import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DownloadController, RequestMetadata, eligible, isPublicHttp, validBridgeUrl, settingsFrom, safeFilename } from '../extension/core.js';
import { NativeBridge } from '../extension/native.js';

const SIZE = 16 * 1024 * 1024;
const URL = 'https://download.example.com/file.zip';
const BRIDGE = `http://127.0.0.1:42001/file/${'b'.repeat(64)}/file.zip`;
const SETTINGS = settingsFrom();
function item(extra = {}) {
  return { id: 7, url: URL, finalUrl: URL, filename: 'C:\\Users\\Test\\Downloads\\file.zip',
    state: 'in_progress', danger: 'safe', paused: false, incognito: false, totalBytes: SIZE, ...extra };
}
function metadata(extra = {}) {
  const store = new RequestMetadata(() => 1000);
  store.begin({ requestId: 'r1', url: URL, method: 'GET', tabId: 1 });
  store.sent({ requestId: 'r1', url: URL, requestHeaders: [] });
  store.received({ requestId: 'r1', url: URL, statusCode: 200, responseHeaders: [
    { name: 'Content-Length', value: String(SIZE) }, { name: 'ETag', value: '"file-v1"' }
  ] });
  Object.assign(store.rows.get('r1'), extra);
  return store;
}
function harness(options = {}) {
  const calls = [];
  const scheduled = [];
  const items = new Map([[7, item()]]);
  const saved = { transactions: [] };
  const downloads = {
    async search({ id }) { calls.push(['search', id]); return items.has(id) ? [{ ...items.get(id) }] : []; },
    async pause(id) { calls.push(['pause', id]); if (options.pauseError) throw Error('pause failed'); items.get(id).paused = true; },
    async resume(id) { calls.push(['resume', id]); items.get(id).paused = false; },
    async cancel(id) {
      calls.push(['cancel', id]);
      if (options.cancelOriginalError && id === 7) throw Error('cancel failed');
      if (items.has(id)) items.get(id).state = 'interrupted';
    },
    async erase(query) { calls.push(['erase', query.id]); items.delete(query.id); },
    async download(input) {
      calls.push(['download', input]);
      if (options.downloadError) throw Error('Edge rejected download');
      items.set(8, item({ id: 8, url: BRIDGE, finalUrl: BRIDGE, state: options.replacementState || 'in_progress' }));
      return 8;
    }
  };
  const native = { async request(op, input, deadline) {
    calls.push(['native', op, input, deadline]);
    if (op === 'prepare') {
      if (options.prepare) return options.prepare(input);
      if (options.prepareError) throw Error('unsupported ranges');
      return { ok: true, jobId: 'b'.repeat(64), url: BRIDGE, size: SIZE, ...options.prepareResult };
    }
    return { ok: true, cleaned: true };
  } };
  const storage = {
    async get() { return structuredClone(saved); },
    async set(value) { Object.assign(saved, structuredClone(value)); calls.push(['persist']); }
  };
  const controller = new DownloadController({ downloads, storage, native, metadata: metadata(options.metadata),
    schedule: fn => { scheduled.push(fn); } });
  return { controller, calls, items, saved, downloads, native, scheduled };
}
function index(calls, name, argument) {
  return calls.findIndex(c => c[0] === name && (argument === undefined || c[1] === argument));
}

test('manifest is MV3, fixed Edge ID key, no startup pages or content scripts', async () => {
  const manifest = JSON.parse(await fs.readFile(new globalThis.URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.deepEqual(manifest.permissions, ['downloads', 'storage', 'webRequest', 'nativeMessaging']);
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(manifest.key.length > 200);
});

test('safe public GET with validators is eligible', () => {
  assert.equal(eligible(item(), metadata().claim(item()), SETTINGS), true);
});

test('download safety readiness is reevaluated without losing request metadata', async () => {
  const h = harness();
  h.items.get(7).danger = undefined;
  await h.controller.created({ ...h.items.get(7) });
  assert.equal(index(h.calls, 'pause'), -1);
  assert.match(h.controller.status().lastDecision.reason, /安全状态/);
  assert.equal(h.controller.metadata.rows.get('r1').claimed, false);
  h.items.get(7).danger = 'safe';
  await h.controller.changed({ id: 7, danger: { current: 'safe' } });
  assert.ok(index(h.calls, 'download') >= 0);
  assert.equal(h.controller.status().active, 1);
});

test('late response metadata can trigger takeover after onCreated', async () => {
  const h = harness();
  const row = h.controller.metadata.rows.get('r1');
  row.response = false;
  await h.controller.created(item());
  assert.equal(index(h.calls, 'pause'), -1);
  row.response = true;
  await h.controller.responseReady(URL);
  assert.ok(index(h.calls, 'download') >= 0);
});

test('filename readiness followed by temporary safety scanning still retries', async () => {
  const h = harness(); h.items.get(7).filename = '';
  await h.controller.created({ ...h.items.get(7) });
  h.items.get(7).filename = 'C:\\Downloads\\firmware.ipsw';
  h.items.get(7).danger = 'asyncScanning';
  await h.controller.changed({ id: 7, filename: { current: h.items.get(7).filename } });
  assert.equal(index(h.calls, 'pause'), -1);
  h.items.get(7).danger = 'safe';
  await h.controller.changed({ id: 7, danger: { current: 'safe' } });
  assert.ok(index(h.calls, 'download') >= 0);
});

test('unrelated webpage responses do not query pending download records', async () => {
  const h = harness({ metadata: { response: false } });
  await h.controller.created(item());
  const before = h.calls.length;
  await h.controller.responseReady('https://example.org/image.png');
  assert.equal(h.calls.length, before);
  await h.controller.erased(7);
  assert.equal(h.controller.observed.has(7), false);
});

test('direct download preserves a transiently interrupted task for native resume', async () => {
  const h = harness({ replacementState: 'interrupted' });
  await h.controller.direct(URL);
  assert.equal(index(h.calls, 'native', 'cancel'), -1);
  assert.equal(h.controller.status().active, 1);
});

test('waiting filenames cannot reuse a request claimed by another download', async () => {
  const h = harness();
  h.items.get(7).filename = '';
  h.items.set(9, item({ id: 9, filename: '' }));
  await h.controller.created({ ...h.items.get(7) });
  await h.controller.created({ ...h.items.get(9) });
  h.items.get(7).filename = 'C:\\Downloads\\one.zip';
  await h.controller.changed({ id: 7, filename: { current: h.items.get(7).filename } });
  h.items.get(9).filename = 'C:\\Downloads\\two.zip';
  await h.controller.changed({ id: 9, filename: { current: h.items.get(9).filename } });
  assert.equal(h.calls.filter(c => c[0] === 'download').length, 1);
  assert.equal(h.items.get(9).state, 'in_progress');
  assert.equal(h.items.get(9).paused, false);
});

test('direct start clears runtime task state after a storage failure', async () => {
  const h = harness();
  h.controller.storage.set = async () => { throw new Error('storage failed'); };
  await assert.rejects(h.controller.direct(URL), /storage failed/);
  assert.equal(h.controller.status().active, 0);
  assert.equal(h.items.get(8).state, 'interrupted');
});

test('missing request and ineligible downloads explain native fallback', async () => {
  const h = harness();
  h.controller.metadata.rows.clear();
  await h.controller.created(item());
  assert.match(h.controller.status().lastDecision.reason, /原始请求/);
  assert.equal(index(h.calls, 'download'), -1);
  const cookie = harness({ metadata: { sensitive: true } });
  await cookie.controller.created(item());
  assert.match(cookie.controller.status().lastDecision.reason, /登录信息/);
});

test('direct public download creates one native item with filename and no original temporary file', async () => {
  const h = harness({ prepareResult: { filename: 'firmware.ipsw' } });
  h.controller.settings.connections = 32;
  const result = await h.controller.direct(URL);
  assert.equal(result.filename, 'firmware.ipsw');
  assert.equal(index(h.calls, 'pause'), -1);
  assert.equal(index(h.calls, 'cancel', 7), -1);
  const prepared = h.calls.find(c => c[0] === 'native' && c[1] === 'prepare')[2];
  assert.equal(prepared.connections, 32);
  assert.equal(prepared.originalTarget, undefined);
  assert.equal(h.calls.find(c => c[0] === 'download')[1].filename, 'firmware.ipsw');
  h.items.get(8).state = 'complete';
  await h.controller.changed({ id: 8, state: { current: 'complete' } });
  assert.equal(index(h.calls, 'native', 'cleanupOriginal'), -1);
  assert.equal(index(h.calls, 'erase'), -1);
  assert.equal(h.controller.status().active, 0);
});

test('direct input rejects local and credential-bearing URLs before contacting host', async () => {
  const h = harness();
  for (const url of ['http://127.0.0.1/file.zip', 'https://u:p@example.com/file.zip', 'file:///a.zip']) {
    await assert.rejects(h.controller.direct(url));
  }
  assert.equal(index(h.calls, 'native'), -1);
});

test('sensitive, POST, compressed, unvalidated and ambiguous requests stay native', () => {
  for (const patch of [{ method: 'POST' }, { sensitive: true }, { sent: false }, { response: false },
    { status: 206 }, { size: -1 }, { size: 1024 }, { encoding: 'gzip' }, { etag: '', lastModified: '' },
    { vary: 'Cookie' }, { vary: '*' }, { incognito: true }]) {
    assert.equal(eligible(item(), metadata(patch).claim(item()), SETTINGS), false, JSON.stringify(patch));
  }
  const ambiguous = metadata();
  ambiguous.rows.set('r2', { ...ambiguous.rows.get('r1'), requestId: 'r2', method: 'POST' });
  assert.equal(ambiguous.claim(item()), null);
});

test('cookies, authorization and preexisting Range headers prevent takeover', () => {
  for (const name of ['Cookie', 'Authorization', 'Proxy-Authorization', 'Range', 'If-Range']) {
    const rows = metadata();
    rows.sent({ requestId: 'r1', url: URL, requestHeaders: [{ name, value: 'private-secret-value' }] });
    assert.equal(eligible(item(), rows.claim(item()), SETTINGS), false, name);
    assert.equal(JSON.stringify([...rows.rows.values()]).includes('private-secret-value'), false);
  }
});

test('metadata does not correlate reused URL twice and expires stale requests', () => {
  const rows = metadata();
  assert.ok(rows.claim(item()));
  assert.equal(rows.claim(item()), null);
  const stale = metadata();
  stale.now = () => 100_000;
  assert.equal(stale.claim(item()), null);
});

test('unsafe items and local, blob, data, credential URLs stay native', () => {
  for (const patch of [{ incognito: true }, { danger: 'dangerous' }, { danger: undefined },
    { paused: true }, { state: 'complete' }, { byExtensionId: 'other' }, { totalBytes: SIZE + 1 }]) {
    assert.equal(eligible(item(patch), metadata().claim(item()), SETTINGS), false);
  }
  for (const url of ['http://127.0.0.1/f', 'http://10.0.0.1/f', 'http://192.168.1.1/f',
    'http://172.16.0.1/f', 'http://localhost/f', 'http://intranet/f', 'http://[::1]/f',
    'https://user:pass@example.com/f', 'blob:https://example.com/id', 'data:text/plain,x']) assert.equal(isPublicHttp(url), false, url);
  assert.equal(isPublicHttp(URL), true);
});

test('settings constrained and basename preserved without absolute path', () => {
  assert.deepEqual(settingsFrom({ connections: 999, minBytes: -1, enabled: 1 }), SETTINGS);
  assert.equal(safeFilename('C:\\chosen\\我的文件.zip'), '我的文件.zip');
  assert.equal(safeFilename('../folder/file.zip'), 'file.zip');
  assert.equal(validBridgeUrl(BRIDGE), true);
  assert.equal(validBridgeUrl('http://127.0.0.1:22/elsewhere'), false);
  assert.equal(validBridgeUrl(BRIDGE.replace('127.0.0.1', 'evil.example.com')), false);
});

test('successful takeover retains canceled original until replacement completion and cleanup', async () => {
  const h = harness();
  await h.controller.created(item());
  assert.ok(index(h.calls, 'pause', 7) < index(h.calls, 'native', 'prepare'));
  assert.ok(index(h.calls, 'download') < index(h.calls, 'cancel', 7));
  assert.equal(index(h.calls, 'erase', 7), -1);
  assert.equal(h.items.get(7).state, 'interrupted');
  assert.equal(h.controller.status().active, 1);
  assert.equal(h.saved.transactions[0].replacementId, 8);
  const prepare = h.calls.find(c => c[0] === 'native' && c[1] === 'prepare');
  assert.equal(prepare[2].expectedSize, SIZE);
  assert.equal(prepare[2].etag, '"file-v1"');
  assert.equal(prepare[2].url, URL);
  assert.deepEqual(h.calls.find(c => c[0] === 'download')[1], {
    url: BRIDGE, filename: 'file.zip', saveAs: false, conflictAction: 'uniquify'
  });
});

test('missing helper or unsupported server resumes original and preserves history', async () => {
  const h = harness({ prepareError: true });
  await h.controller.created(item());
  assert.equal(h.items.get(7).paused, false);
  assert.equal(h.items.get(7).state, 'in_progress');
  assert.equal(index(h.calls, 'cancel', 7), -1);
  assert.equal(index(h.calls, 'erase', 7), -1);
  assert.equal(h.saved.transactions.length, 0);
});

test('browser download rejection resumes original and releases prepared helper job', async () => {
  const h = harness({ downloadError: true });
  await h.controller.created(item());
  assert.equal(h.items.get(7).paused, false);
  assert.equal(index(h.calls, 'erase', 7), -1);
  assert.ok(index(h.calls, 'native', 'cancel') >= 0);
});

test('replacement immediate interruption does not cancel original', async () => {
  const h = harness({ replacementState: 'interrupted' });
  await h.controller.created(item());
  assert.equal(h.items.get(7).state, 'in_progress');
  assert.equal(h.items.get(7).paused, false);
  assert.equal(index(h.calls, 'cancel', 7), -1);
});

test('original cancellation failure cancels replacement and retains original', async () => {
  const h = harness({ cancelOriginalError: true });
  await h.controller.created(item());
  assert.equal(h.items.get(7).state, 'in_progress');
  assert.equal(h.items.get(7).paused, false);
  assert.equal(h.items.get(8).state, 'interrupted');
  assert.equal(index(h.calls, 'erase', 7), -1);
});

test('invalid helper address or mismatched size fails before replacement is created', async () => {
  for (const prepareResult of [{ url: 'https://untrusted.example.com/x' }, { size: SIZE + 1 }]) {
    const h = harness({ prepareResult });
    await h.controller.created(item());
    assert.equal(index(h.calls, 'download'), -1);
    assert.equal(h.items.get(7).paused, false);
  }
});

test('pause error leaves original alone and does not contact helper', async () => {
  const h = harness({ pauseError: true });
  await h.controller.created(item());
  assert.equal(index(h.calls, 'native', 'prepare'), -1);
  assert.equal(index(h.calls, 'cancel', 7), -1);
  assert.equal(h.saved.transactions.length, 0);
});

test('native pause uses backpressure; transient interruption keeps resumable job; cancel releases it', async () => {
  const h = harness();
  await h.controller.created(item());
  await h.controller.changed({ id: 8, paused: { current: true } });
  await h.controller.changed({ id: 8, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  assert.equal(index(h.calls, 'native', 'cancel'), -1);
  assert.equal(h.controller.status().active, 1);
  await h.controller.changed({ id: 8, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
  assert.ok(index(h.calls, 'native', 'cancel') >= 0);
  assert.equal(h.saved.transactions.length, 0);
});

test('completion releases job and clears persisted mapping', async () => {
  const h = harness();
  await h.controller.created(item());
  h.items.get(8).state = 'complete';
  await h.controller.changed({ id: 8, state: { current: 'complete' } });
  assert.ok(index(h.calls, 'native', 'cleanupOriginal') < index(h.calls, 'erase', 7));
  assert.ok(index(h.calls, 'erase', 7) < index(h.calls, 'native', 'release'));
  assert.equal(h.items.has(7), false);
  assert.ok(index(h.calls, 'native', 'release') >= 0);
  assert.equal(h.saved.transactions.length, 0);
});

test('onCreated with empty filename stays running until Edge resolves the target', async () => {
  const h = harness();
  h.items.set(7, item({ filename: '' }));
  await h.controller.created(item({ filename: '' }));
  assert.equal(index(h.calls, 'pause'), -1);
  assert.equal(index(h.calls, 'download'), -1);
  h.items.get(7).filename = 'C:\\Downloads\\中文报告.7z';
  await h.controller.changed({ id: 7, filename: { current: h.items.get(7).filename } });
  assert.equal(h.calls.find(c => c[0] === 'download')[1].filename, '中文报告.7z');
  assert.equal(h.calls.find(c => c[0] === 'native' && c[1] === 'prepare')[2].originalTarget, 'C:\\Downloads\\中文报告.7z');
});

test('temporary filenames never become replacement filenames', async () => {
  const h = harness();
  h.items.get(7).filename = 'C:\\Downloads\\未确认 728837.crdownload';
  await h.controller.created({ ...h.items.get(7) });
  assert.equal(index(h.calls, 'pause'), -1);
  h.items.get(7).filename = 'C:\\Downloads\\installer.msi';
  await h.controller.changed({ id: 7, filename: { current: h.items.get(7).filename } });
  assert.equal(h.calls.find(c => c[0] === 'download')[1].filename, 'installer.msi');
});

test('server filename fixes generic download placeholder and preserves its extension', async () => {
  const h = harness({ metadata: { contentDisposition: "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.tar.gz" } });
  h.items.get(7).filename = 'C:\\Downloads\\download';
  await h.controller.created({ ...h.items.get(7) });
  assert.equal(h.calls.find(c => c[0] === 'download')[1].filename, '测试.tar.gz');
});

test('the probe can supply the complete filename before the browser replacement starts', async () => {
  const h = harness({ prepareResult: { filename: 'report.pdf' } });
  h.items.get(7).filename = 'C:\\Downloads\\report';
  await h.controller.created({ ...h.items.get(7) });
  assert.equal(h.calls.find(c => c[0] === 'download')[1].filename, 'report.pdf');
  assert.equal(h.saved.transactions[0].filename, 'report.pdf');
});

test('unknown filename remains native instead of becoming download', async () => {
  const h = harness();
  const source = 'https://download.example.com/download';
  const row = h.controller.metadata.rows.get('r1'); row.url = source;
  h.items.set(7, item({ filename: 'C:\\Downloads\\download', url: source, finalUrl: source }));
  await h.controller.created({ ...h.items.get(7) });
  assert.equal(index(h.calls, 'pause'), -1);
  assert.equal(index(h.calls, 'download'), -1);
});

test('cleanup failure preserves original history and never cleans during active download', async () => {
  const h = harness();
  await h.controller.created(item());
  assert.equal(index(h.calls, 'native', 'cleanupOriginal'), -1);
  const request = h.native.request;
  h.native.request = async (op, ...args) => op === 'cleanupOriginal' ? { cleaned: false } : request(op, ...args);
  h.items.get(8).state = 'complete';
  await h.controller.changed({ id: 8, state: { current: 'complete' } });
  assert.equal(index(h.calls, 'erase', 7), -1);
  assert.equal(h.items.has(7), true);
  assert.equal(h.saved.transactions[0].stage, 'cleanup');
  assert.equal(index(h.calls, 'native', 'release'), -1);
  h.native.request = request;
  await h.scheduled[0]();
  assert.equal(h.items.has(7), false);
  assert.equal(h.saved.transactions.length, 0);
  assert.ok(index(h.calls, 'native', 'release') >= 0);
});

test('browser-managed temporary files complete takeover without cleanup retry or leaked job', async () => {
  const h = harness();
  const request = h.native.request;
  h.native.request = async (op, ...args) => op === 'cleanupOriginal'
    ? { settled: true, cleaned: false, removed: false, reason: 'browser-managed' }
    : request(op, ...args);
  await h.controller.created(item());
  assert.ok(index(h.calls, 'download') < index(h.calls, 'cancel', 7));
  assert.equal(h.controller.status().active, 1);
  assert.equal(h.items.get(7).state, 'interrupted');
  h.items.get(8).state = 'complete';
  await h.controller.changed({ id: 8, state: { current: 'complete' } });
  assert.equal(h.items.has(7), false);
  assert.equal(h.items.get(8).state, 'complete');
  assert.equal(h.controller.status().active, 0);
  assert.equal(h.saved.transactions.length, 0);
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.controller.lastError, '');
  assert.ok(index(h.calls, 'native', 'release') >= 0);
});

test('arbitrary unsettled cleanup outcomes still retain the captured-file safeguards', async () => {
  const h = harness();
  const request = h.native.request;
  h.native.request = async (op, ...args) => op === 'cleanupOriginal'
    ? { settled: true, cleaned: false, reason: 'file-changed' }
    : request(op, ...args);
  await h.controller.created(item());
  h.items.get(8).state = 'complete';
  await h.controller.changed({ id: 8, state: { current: 'complete' } });
  assert.equal(h.items.has(7), true);
  assert.equal(h.saved.transactions[0].stage, 'cleanup');
  assert.equal(index(h.calls, 'native', 'release'), -1);
});

test('a completion notification does not clean a different still-running replacement', async () => {
  const h = harness();
  await h.controller.created(item());
  await h.controller.changed({ id: 8, state: { current: 'complete' } });
  assert.equal(index(h.calls, 'native', 'cleanupOriginal'), -1);
  assert.equal(index(h.calls, 'erase', 7), -1);
});

test('helper disconnect while preparing resumes original and blocks later takeover', async () => {
  let resolve;
  const prepared = new Promise(r => { resolve = r; });
  const h = harness({ prepare: () => prepared });
  const work = h.controller.created(item());
  while (!h.calls.some(c => c[0] === 'native')) await new Promise(r => setImmediate(r));
  await h.controller.disconnected();
  assert.equal(h.items.get(7).paused, false);
  resolve({ jobId: 'b'.repeat(64), url: BRIDGE, size: SIZE });
  await work;
  assert.equal(index(h.calls, 'download'), -1);
  assert.equal(h.saved.transactions.length, 0);
});

test('user cancellation during preparation does not restart download', async () => {
  let resolve;
  const prepared = new Promise(r => { resolve = r; });
  const h = harness({ prepare: () => prepared });
  const work = h.controller.created(item());
  while (!h.calls.some(c => c[0] === 'native')) await new Promise(r => setImmediate(r));
  h.items.get(7).state = 'interrupted';
  await h.controller.changed({ id: 7, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
  resolve({ jobId: 'b'.repeat(64), url: BRIDGE, size: SIZE });
  await work;
  assert.equal(index(h.calls, 'resume', 7), -1);
  assert.equal(index(h.calls, 'download'), -1);
});

test('worker recovery resumes pending originals and cancels uncommitted replacements', async () => {
  const h = harness();
  h.items.get(7).paused = true;
  h.items.set(8, item({ id: 8 }));
  h.saved.transactions = [{ originalId: 7, replacementId: 8, stage: 'starting', jobId: 'old' }];
  await h.controller.restore();
  assert.equal(h.items.get(7).paused, false);
  assert.equal(h.items.get(8).state, 'interrupted');
  assert.equal(h.saved.transactions.length, 0);
  assert.equal(index(h.calls, 'erase', 7), -1);
});

test('worker recovery keeps replacement if original cancellation already committed', async () => {
  const h = harness();
  h.items.get(7).state = 'interrupted';
  h.items.set(8, item({ id: 8 }));
  h.saved.transactions = [{ originalId: 7, replacementId: 8, stage: 'committing', jobId: 'old' }];
  await h.controller.restore();
  assert.equal(h.items.get(8).state, 'in_progress');
  assert.equal(index(h.calls, 'cancel', 8), -1);
  assert.equal(h.saved.transactions[0].stage, 'active');
});

function nativeHarness() {
  const listeners = {};
  const posted = [];
  const runtime = {
    connectNative(name) { assert.equal(name, 'com.edgeparallel.bridge'); return port; }, lastError: undefined
  };
  const port = { onMessage: { addListener(fn) { listeners.message = fn; } },
    onDisconnect: { addListener(fn) { listeners.disconnect = fn; } },
    postMessage(message) { posted.push(message); }, disconnect() { listeners.disconnect(); } };
  return { bridge: new NativeBridge(runtime), listeners, posted, runtime };
}

test('native protocol uses action field and maps cancel to release', async () => {
  const h = nativeHarness();
  const result = h.bridge.request('cancel', { jobId: 'x' });
  assert.equal(h.posted[0].action, 'release');
  assert.equal(h.posted[0].op, undefined);
  h.listeners.message({ id: h.posted[0].id, ok: true, released: true });
  assert.equal((await result).released, true);
});

test('native flat errors and disconnect reject pending calls', async () => {
  const h = nativeHarness();
  const result = h.bridge.request('ping');
  h.listeners.message({ id: h.posted[0].id, ok: false, error: 'missing helper' });
  await assert.rejects(result, /missing helper/);
  const next = h.bridge.request('ping');
  h.runtime.lastError = { message: 'disconnected' };
  h.listeners.disconnect();
  await assert.rejects(next, /disconnected/);
});

test('prepare timeout releases only the pending probe without killing other jobs', async () => {
  const h = nativeHarness();
  await assert.rejects(h.bridge.request('prepare', { url: URL }, 5), /超时/);
  assert.equal(h.posted[1].action, 'release');
  assert.equal(h.posted[1].requestId, h.posted[0].id);
  assert.ok(h.bridge.port);
});
