import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createConnectionLimiter, download, probe } from './engine.mjs';

const file = Buffer.alloc(1024 * 1024 + 137);
for (let i = 0; i < file.length; i++) file[i] = (i * 131 + (i >>> 8)) & 255;
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const etag = '"fixture-v1"';

async function fixture(run, options = {}) {
  const payload = options.file || file;
  const state = { active: 0, maxActive: 0, requests: [], closed: 0, retried: false };
  const server = http.createServer(async (req, res) => {
    state.requests.push({ url: req.url, range: req.headers.range, ifRange: req.headers['if-range'] });
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/file' }).end();
      return;
    }
    if (req.url === '/no-range') {
      res.writeHead(200, { 'Content-Length': payload.length }).end(payload);
      return;
    }
    if (req.url === '/missing-validator') {
      res.writeHead(206, { 'Content-Range': `bytes 0-0/${payload.length}`, 'Content-Length': 1 }).end(payload.subarray(0, 1));
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) return res.writeHead(400).end();
    const start = Number(match[1]);
    const end = Number(match[2]);
    const isProbe = start === 0 && end === 0;
    if (req.url === '/retry' && !isProbe && !state.retried) {
      state.retried = true;
      res.writeHead(503).end('Try again');
      return;
    }
    if (!isProbe) {
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      res.once('close', () => { state.active--; state.closed++; });
    }
    let contentRange = `bytes ${start}-${end}/${payload.length}`;
    if (req.url === '/malformed') contentRange = 'bytes 7-7/garbage';
    if (req.url === '/bad-chunk' && !isProbe) contentRange = `bytes ${start + 1}-${end}/${payload.length}`;
    const headers = {
      'Content-Range': contentRange, 'Content-Length': end - start + 1,
      ETag: req.url === '/changed' && !isProbe ? '"fixture-v2"' : etag,
      'Content-Type': 'application/octet-stream',
    };
    if (req.url === '/late-headers' && !isProbe) {
      const timer = setTimeout(() => res.writeHead(206, headers).end(payload.subarray(start, end + 1)), 5_000);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    res.writeHead(206, headers);
    if (req.url === '/truncated' && !isProbe) {
      res.write(payload.subarray(start, start + Math.floor((end - start + 1) / 2)));
      res.socket?.destroy();
      return;
    }
    if (req.url === '/slow' && !isProbe) {
      res.write(payload.subarray(start, start + 1));
      const timer = setTimeout(() => res.end(payload.subarray(start + 1, end + 1)), 5_000);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    if (req.url === '/continuous' && !isProbe) {
      let offset = start;
      const stride = Math.ceil((end - start + 1) / 8);
      const write = () => {
        const next = Math.min(offset + stride, end + 1);
        res.write(payload.subarray(offset, next));
        offset = next;
        if (offset === end + 1) res.end();
      };
      write();
      const timer = setInterval(write, 60);
      res.once('close', () => clearInterval(timer));
      return;
    }
    if (!isProbe) await delay(options.delayMs || 25);
    res.end(payload.subarray(start, end + 1));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base, state); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('parallel range requests produce the exact complete file in order', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/file`);
    assert.equal(meta.size, file.length);
    assert.equal(meta.etag, etag);
    const actual = await collect(download(meta, { connections: 4, chunkSize: 64 * 1024 }));
    assert.equal(hash(actual), hash(file));
    assert.equal(state.maxActive, 4);
    assert.ok(state.requests.slice(1).every(request => request.ifRange === etag));
  });
});

test('probe follows a public redirect and retains the final URL', async () => {
  await fixture(async base => {
    const meta = await probe(`${base}/redirect`);
    assert.equal(meta.url, `${base}/file`);
  });
});

test('resume downloads exactly the requested offset and end in order', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/file`);
    const start = 12345;
    const end = 712345;
    const actual = await collect(download(meta, { start, end, connections: 4, chunkSize: 64 * 1024 }));
    assert.equal(hash(actual), hash(file.subarray(start, end + 1)));
    const requests = state.requests.slice(1).map(item => /^bytes=(\d+)-(\d+)$/.exec(item.range).slice(1).map(Number));
    assert.equal(Math.min(...requests.map(item => item[0])), start);
    assert.equal(Math.max(...requests.map(item => item[1])), end);
  });
});

test('invalid resume boundaries fail before issuing requests', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/file`);
    await assert.rejects(collect(download(meta, { start: -1 })), TypeError);
    await assert.rejects(collect(download(meta, { start: meta.size })), TypeError);
    await assert.rejects(collect(download(meta, { start: 100, end: 99 })), TypeError);
    assert.equal(state.requests.length, 1);
  });
});

test('servers without Range support fall back before transferring a file', async () => {
  await fixture(async base => {
    await assert.rejects(probe(`${base}/no-range`), { code: 'RANGE_UNSUPPORTED' });
  });
});

test('malformed ranges and missing validators are rejected', async () => {
  await fixture(async base => {
    await assert.rejects(probe(`${base}/malformed`), { code: 'INVALID_RANGE' });
    await assert.rejects(probe(`${base}/missing-validator`), { code: 'NO_VALIDATOR' });
  });
});

test('URL credentials and non-web schemes are rejected', async () => {
  await assert.rejects(probe('file:///C:/secret'), { code: 'UNSUPPORTED_URL' });
  await assert.rejects(probe('https://username:password@example.test/file'), { code: 'UNSUPPORTED_URL' });
});

test('changed file validators stop the transfer without retrying corrupt data', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/changed`);
    await assert.rejects(collect(download(meta, { connections: 2, chunkSize: 64 * 1024 })), { code: 'FILE_CHANGED' });
    assert.ok(state.requests.length <= 3);
  });
});

test('incorrect offsets in a later range are rejected before yielding bytes', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/bad-chunk`);
    await assert.rejects(collect(download(meta, { connections: 1, chunkSize: 64 * 1024 })), { code: 'INVALID_RANGE' });
    assert.equal(state.requests.length, 2);
  });
});

test('a temporary server failure retries only the affected range and recovers', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/retry`);
    const actual = await collect(download(meta, { connections: 4, chunkSize: 64 * 1024 }));
    assert.equal(hash(actual), hash(file));
    assert.equal(state.requests.length, Math.ceil(file.length / (64 * 1024)) + 2);
  });
});

test('truncated range bodies fail after bounded retries', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/truncated`);
    await assert.rejects(collect(download(meta, { connections: 1, chunkSize: 64 * 1024, retries: 1 })));
    assert.equal(state.requests.length, 3);
  });
});

test('cancellation closes active connections promptly', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/slow`);
    const controller = new AbortController();
    const started = Date.now();
    const result = collect(download(meta, { connections: 4, chunkSize: 64 * 1024, signal: controller.signal }));
    await delay(80);
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    assert.ok(Date.now() - started < 2_000);
    await delay(50);
    assert.equal(state.active, 0);
  });
});

test('a slow consumer bounds the amount of data requested ahead', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/file`);
    const iterator = download(meta, { connections: 3, chunkSize: 64 * 1024 });
    const first = await iterator.next();
    assert.equal(first.value.length, 64 * 1024);
    await delay(100);
    assert.equal(state.requests.length, 4, 'one probe and only three scheduled chunks');
    await iterator.return();
  });
});

test('a continuous slow range can take longer than the timeout without restarting', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/continuous`);
    const started = Date.now();
    const actual = await collect(download(meta, {
      connections: 1, chunkSize: 2 * 1024 * 1024, timeoutMs: 200, retries: 0,
    }));
    assert.equal(hash(actual), hash(file));
    assert.ok(Date.now() - started >= 400);
    assert.equal(state.requests.length, 2, 'continuous progress must not restart a range');
  });
});

test('a stalled response body fails at the idle timeout and releases its connection', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/slow`);
    const limiter = createConnectionLimiter(1);
    const started = Date.now();
    await assert.rejects(collect(download(meta, {
      connections: 1, limiter, idleTimeoutMs: 150, headerTimeoutMs: 1_000, retries: 0,
    })), { code: 'IDLE_TIMEOUT' });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(limiter.active, 0);
    await delay(30);
    assert.equal(state.active, 0);
  });
});

test('a response with no headers fails on the separate header timeout', async () => {
  await fixture(async base => {
    const meta = await probe(`${base}/late-headers`);
    await assert.rejects(collect(download(meta, {
      connections: 1, headerTimeoutMs: 100, idleTimeoutMs: 1_000, retries: 0,
    })), { code: 'HEADER_TIMEOUT' });
  });
});

test('one shared limiter caps all simultaneous resume requests for a job', async () => {
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/file`);
    const limiter = createConnectionLimiter(3);
    const split = Math.floor(meta.size / 2);
    const [first, second] = await Promise.all([
      collect(download(meta, { end: split - 1, connections: 16, chunkSize: 64 * 1024, limiter })),
      collect(download(meta, { start: split, connections: 16, chunkSize: 64 * 1024, limiter })),
    ]);
    assert.equal(hash(Buffer.concat([first, second])), hash(file));
    assert.equal(state.maxActive, 3);
    assert.equal(limiter.active, 0);
    assert.equal(limiter.pending, 0);
  });
});

test('aborting queued acquires removes all waiters without leaking permits', async () => {
  const limiter = createConnectionLimiter(1);
  const release = await limiter.acquire();
  const controller = new AbortController();
  const queued = Array.from({ length: 32 }, () => limiter.acquire(controller.signal));
  assert.equal(limiter.active, 1);
  assert.equal(limiter.pending, 32);
  const settled = Promise.allSettled(queued);
  controller.abort();
  const results = await settled;
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(limiter.pending, 0);
  release();
  release();
  assert.equal(limiter.active, 0);
  const nextRelease = await limiter.acquire();
  assert.equal(limiter.active, 1);
  nextRelease();
});

test('cancellation while ranges are both active and queued frees the shared limiter', async () => {
  await fixture(async base => {
    const meta = await probe(`${base}/slow`);
    const limiter = createConnectionLimiter(2);
    const controller = new AbortController();
    const result = collect(download(meta, {
      connections: 16, chunkSize: 64 * 1024, limiter, signal: controller.signal,
    }));
    const rejected = assert.rejects(result, { name: 'AbortError' });
    await delay(50);
    assert.equal(limiter.active, 2);
    assert.ok(limiter.pending > 0);
    controller.abort();
    await rejected;
    assert.equal(limiter.active, 0);
    assert.equal(limiter.pending, 0);
  });
});

test('64 connections use adaptive chunks on a 32 MiB file and preserve its hash', async () => {
  const largeFile = Buffer.alloc(32 * 1024 * 1024);
  for (let offset = 0; offset < largeFile.length; offset += file.length) {
    file.copy(largeFile, offset, 0, Math.min(file.length, largeFile.length - offset));
  }
  await fixture(async (base, state) => {
    const meta = await probe(`${base}/file`);
    const progress = [];
    const actualHash = createHash('sha256');
    for await (const buffer of download(meta, { connections: 64, onProgress: value => progress.push(value) })) {
      actualHash.update(buffer);
    }
    assert.equal(actualHash.digest('hex'), hash(largeFile));
    assert.equal(state.maxActive, 64);
    const ranges = state.requests.slice(1).map(item => /^bytes=(\d+)-(\d+)$/.exec(item.range).slice(1).map(Number));
    assert.ok(ranges.every(([start, end]) => end - start + 1 === 256 * 1024));
    assert.equal(progress.length, 128);
    assert.equal(progress.at(-1).receivedBytes, meta.size);
    assert.ok(progress.every((item, index) => item.totalBytes === meta.size && item.receivedBytes === (index + 1) * 256 * 1024));
  }, { file: largeFile, delayMs: 120 });
});
