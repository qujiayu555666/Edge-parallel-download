import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../host/bridge.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { filenameFromContentDisposition } from '../extension/filename.js';

const payload = Buffer.alloc(9 * 1024 * 1024 + 117);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + (i >>> 12)) % 256;
const digest = b => createHash('sha256').update(b).digest('hex');
async function fixture(extraHeaders = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(200, { 'Content-Length': payload.length }).end(payload); return; }
    const start = Number(match[1]), end = Number(match[2]);
    res.writeHead(206, {
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${payload.length}`,
      ETag: '"fixture-v1"',
      ...extraHeaders,
    });
    res.end(payload.subarray(start, end + 1));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/fixture.bin`, seen,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

test('bridge streams a complete verified file and supports native byte-offset resume', async () => {
  const upstream = await fixture(), bridge = await createBridge();
  try {
    const job = await bridge.handle({ id: '1', action: 'prepare', url: upstream.url,
      expectedSize: payload.length, etag: '"fixture-v1"', connections: 4, filename: '测试文件.bin' });
    const response = await fetch(job.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(payload.length));
    assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8/);
    assert.equal(filenameFromContentDisposition(response.headers.get('content-disposition')), '测试文件.bin');
    assert.match(response.headers.get('content-disposition'), /filename="[^"\r\n]+\.bin"/);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(payload));
    const start = 3 * 1024 * 1024 + 63;
    const resumed = await fetch(job.url, { headers: { Range: `bytes=${start}-` } });
    assert.equal(resumed.status, 206);
    assert.equal(digest(Buffer.from(await resumed.arrayBuffer())), digest(payload.subarray(start)));
    assert.ok(upstream.seen.some(range => range.startsWith(`bytes=${start}-`)));
    const offsets = [[0, 3_000_000], [3_000_001, 6_000_000], [6_000_001, payload.length - 1]];
    await Promise.all(offsets.map(async ([from, to]) => {
      const response = await fetch(job.url, { headers: { Range: `bytes=${from}-${to}` } });
      assert.equal(response.status, 206);
      assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(payload.subarray(from, to + 1)));
    }));
    const status = await bridge.handle({ action: 'status' });
    assert.equal(status.jobs[0].filename, '测试文件.bin');
    assert.equal(status.jobs[0].connections, 4);
    assert.ok(status.jobs[0].receivedBytes >= payload.length);
    await bridge.handle({ action: 'release', jobId: job.jobId });
    assert.equal((await fetch(job.url)).status, 404);
  } finally { await bridge.close(); await upstream.close(); }
});

test('real transfer preserves server filename and removes only its captured leftover after completion', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'edgeparallel-fix-'));
  const original = path.join(folder, '原文件.zip');
  const temporary = `${original}.crdownload`;
  const neighbor = path.join(folder, 'still-downloading.zip.crdownload');
  await fs.writeFile(temporary, 'old browser partial');
  await fs.writeFile(neighbor, 'another task');
  const upstream = await fixture({ 'Content-Disposition': "attachment; filename*=UTF-8''%E5%8E%9F%E6%96%87%E4%BB%B6.zip" });
  const bridge = await createBridge();
  try {
    const job = await bridge.handle({ id: 'cleanup', action: 'prepare', url: upstream.url,
      filename: 'download', originalTarget: original, expectedSize: payload.length });
    assert.equal(job.filename, '原文件.zip');
    const response = await fetch(job.url);
    assert.equal(filenameFromContentDisposition(response.headers.get('content-disposition')), '原文件.zip');
    const output = Buffer.from(await response.arrayBuffer());
    assert.equal(digest(output), digest(payload));
    await fs.writeFile(path.join(folder, job.filename), output);
    await assert.rejects(bridge.handle({ action: 'cleanupOriginal', jobId: job.jobId, canceled: true }));
    assert.equal((await fs.stat(temporary)).isFile(), true);
    const result = await bridge.handle({ action: 'cleanupOriginal', jobId: job.jobId, canceled: true, completed: true });
    assert.equal(result.cleaned, true); assert.equal(result.removed, true);
    await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
    assert.equal(digest(await fs.readFile(original)), digest(payload));
    assert.equal(await fs.readFile(neighbor, 'utf8'), 'another task');
    await bridge.handle({ action: 'release', jobId: job.jobId });
  } finally {
    await bridge.close(); await upstream.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('bridge rejects changed original metadata, hostile origins, wrong tokens and invalid ranges', async () => {
  const upstream = await fixture(), bridge = await createBridge();
  try {
    await assert.rejects(bridge.handle({ id: 'mismatch', action: 'prepare', url: upstream.url, expectedSize: 42 }));
    const job = await bridge.handle({ id: '2', action: 'prepare', url: upstream.url, etag: '"fixture-v1"' });
    assert.equal((await fetch(job.url, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await fetch(job.url, { method: 'POST' })).status, 403);
    assert.equal((await fetch(job.url.replace(job.jobId, 'a'.repeat(64)))).status, 404);
    assert.equal((await fetch(job.url, { headers: { Range: `bytes=${payload.length}-` } })).status, 416);
    const head = await fetch(job.url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally { await bridge.close(); await upstream.close(); }
});

test('random or absent browser temporary files do not prevent a verified download', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edgeparallel-random-temp-'));
  const originalTarget = path.join(directory, 'firmware.ipsw');
  const randomTemp = path.join(directory, '未确认 728837.crdownload');
  const neighbor = path.join(directory, 'other.zip.crdownload');
  await fs.writeFile(randomTemp, 'browser-owned partial');
  await fs.writeFile(neighbor, 'unrelated active task');
  const upstream = await fixture(), bridge = await createBridge();
  try {
    const prepared = await bridge.handle({ id: 'random-temp', action: 'prepare', url: upstream.url,
      filename: 'firmware.ipsw', originalTarget, expectedSize: payload.length, etag: '"fixture-v1"' });
    assert.equal(prepared.filename, 'firmware.ipsw');
    const response = await fetch(prepared.url);
    assert.equal(response.status, 200);
    assert.equal(filenameFromContentDisposition(response.headers.get('content-disposition')), 'firmware.ipsw');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(digest(bytes), digest(payload));
    await fs.writeFile(originalTarget, bytes);
    // Even a newly appearing matching name was not captured and must not be deleted.
    await fs.writeFile(`${originalTarget}.crdownload`, 'later task');
    const result = await bridge.handle({ action: 'cleanupOriginal', jobId: prepared.jobId, canceled: true, completed: true });
    assert.deepEqual(result, { settled: true, cleaned: false, removed: false, reason: 'browser-managed' });
    assert.equal(await fs.readFile(randomTemp, 'utf8'), 'browser-owned partial');
    assert.equal(await fs.readFile(neighbor, 'utf8'), 'unrelated active task');
    assert.equal(await fs.readFile(`${originalTarget}.crdownload`, 'utf8'), 'later task');
    assert.equal(digest(await fs.readFile(originalTarget)), digest(payload));
    await bridge.handle({ action: 'release', jobId: prepared.jobId });
    assert.equal((await fetch(prepared.url)).status, 404);
    // A nonexistent folder or a non-local target also affects optional cleanup only.
    for (const target of [path.join(directory, 'missing', 'firmware.ipsw'), '\\\\server\\share\\firmware.ipsw']) {
      const job = await bridge.handle({ id: 'no-local-temp', action: 'prepare', url: upstream.url,
        filename: 'firmware.ipsw', originalTarget: target });
      assert.equal(job.size, payload.length);
      await bridge.handle({ action: 'release', jobId: job.jobId });
    }
  } finally {
    await bridge.close(); await upstream.close(); await fs.rm(directory, { recursive: true, force: true });
  }
});

test('compiled windowless launcher exchanges real native-messaging frames and exits on disconnect', async t => {
  const exe = process.env.EDGEPARALLEL_TEST_HOST || fileURLToPath(new URL('../host/EdgeParallelHost.exe', import.meta.url));
  if (!process.env.EDGEPARALLEL_TEST_HOST) {
    try { await fs.access(exe); }
    catch { t.skip('Run scripts/build.ps1 to test the compiled Windows launcher.'); return; }
  }
  const child = spawn(exe, ['chrome-extension://jcpnknmnbonffkcmnficeijhojknegbm/'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0);
  const reply = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        resolve(JSON.parse(buffer.subarray(4, buffer.readUInt32LE(0) + 4).toString()));
      }
    });
    child.on('exit', code => { if (!buffer.length) reject(new Error(`Native host exited ${code}`)); });
  });
  const bytes = Buffer.from(JSON.stringify({ id: 'ping-1', action: 'ping' }));
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  // Deliberately split the frame to check binary pipe handling.
  child.stdin.write(header.subarray(0, 2));
  child.stdin.write(Buffer.concat([header.subarray(2), bytes]));
  try {
    const result = await Promise.race([reply, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Native host response timed out')), 10_000); timer.unref();
    })]);
    assert.equal(result.id, 'ping-1'); assert.equal(result.ok, true); assert.equal(result.ready, true);
    const exited = once(child, 'exit'); child.stdin.end();
    const [code] = await exited; assert.equal(code, 0);
  } finally { if (child.exitCode === null) child.kill(); }
});
