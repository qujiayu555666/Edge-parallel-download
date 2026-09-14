import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { probe, download, createConnectionLimiter } from './engine.mjs';
import { resolveFilename, safeFilename } from '../extension/filename.js';
import { captureOriginalTemp, cleanupOriginalTemp } from './temp-files.mjs';

const EXTENSION_ORIGIN = 'chrome-extension://jcpnknmnbonffkcmnficeijhojknegbm';
const disposition = name => `attachment; filename="${safeFilename(name).replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`;

export async function createBridge() {
  const jobs = new Map();
  const preparing = new Map();
  let closing = false;
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address()?.port}` ||
        (req.headers.origin && req.headers.origin !== EXTENSION_ORIGIN) ||
        !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(403).end(); return;
    }
    const jobId = /^\/file\/([a-f0-9]{64})\//.exec(req.url || '')?.[1];
    const job = jobs.get(jobId);
    if (!job) { res.writeHead(404).end(); return; }
    job.touched = Date.now();
    let start = 0, end = job.meta.size - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) >= job.meta.size ||
          (match[2] && (!Number.isSafeInteger(Number(match[2])) || Number(match[2]) < Number(match[1])))) {
        res.writeHead(416, { 'Content-Range': `bytes */${job.meta.size}` }).end(); return;
      }
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': disposition(job.filename),
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    };
    if (job.meta.etag) headers.ETag = job.meta.etag;
    if (job.meta.lastModified) headers['Last-Modified'] = job.meta.lastModified;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${job.meta.size}`;
    if (req.method === 'HEAD') { res.writeHead(range ? 206 : 200, headers).end(); return; }
    job.started = true;
    job.startedAt ||= Date.now();
    const controller = new AbortController();
    job.controllers.add(controller);
    res.on('close', () => controller.abort());
    res.writeHead(range ? 206 : 200, headers);
    try {
      for await (const chunk of download(job.meta, {
        connections: job.connections, limiter: job.limiter, signal: controller.signal, start, end,
        onProgress: progress => {
          job.receivedBytes += progress.chunkBytes;
          job.samples.push({ time: Date.now(), bytes: progress.chunkBytes });
          while (job.samples.length && job.samples[0].time < Date.now() - 3000) job.samples.shift();
        },
      })) {
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        job.touched = Date.now();
      }
      res.end();
    } catch {
      // A truncated response is reported by Edge as interrupted. Never mark a partial file complete.
      res.destroy();
    } finally {
      job.controllers.delete(controller);
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 15_000;
  server.timeout = 0;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const sweep = setInterval(() => {
    for (const [id, job] of jobs) {
      if (!job.controllers.size && Date.now() - job.touched > (job.started ? 86_400_000 : 120_000)) jobs.delete(id);
    }
  }, 30_000);
  sweep.unref();

  async function handle(message) {
    if (closing) throw new Error('下载组件正在关闭');
    if (message.action === 'ping') return { version: '0.2.0', ready: true, jobs: jobs.size };
    if (message.action === 'status') return { jobs: [...jobs.values()].filter(job => job.started).map(job => {
      const now = Date.now();
      const recent = job.samples.filter(sample => sample.time >= now - 3000);
      const seconds = Math.max(0.25, Math.min(3, (now - (job.startedAt || now)) / 1000));
      return { filename: job.filename, connections: job.connections, activeConnections: job.limiter.active,
        receivedBytes: job.receivedBytes, bytesPerSecond: recent.reduce((sum, sample) => sum + sample.bytes, 0) / seconds };
    }) };
    if (message.action === 'cleanupOriginal') {
      const job = jobs.get(message.jobId);
      if (!job || message.canceled !== true || message.completed !== true) throw new Error('无法确认需要清理的下载任务');
      // Edge owns its random temporary paths. No captured file means there is
      // nothing the helper can safely remove, not that the transfer failed.
      if (!job.originalTemp) return { settled: true, cleaned: false, removed: false, reason: 'browser-managed' };
      const result = await cleanupOriginalTemp(job.originalTemp, { attempts: 6, retryDelayMs: 250 });
      const cleaned = result.removed || result.reason === 'already-gone';
      return { ...result, settled: cleaned, cleaned };
    }
    if (message.action === 'release') {
      const job = jobs.get(message.jobId);
      for (const controller of job?.controllers || []) controller.abort();
      jobs.delete(message.jobId);
      preparing.get(message.requestId)?.abort();
      return { released: true };
    }
    if (message.action !== 'prepare') throw new Error('未知操作');
    if (jobs.size + preparing.size >= 8) throw new Error('后台任务已满，请保留 Edge 原生下载');
    const url = new URL(message.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持此链接');
    const connections = Math.max(2, Math.min(64, Math.floor(Number(message.connections) || 16)));
    const controller = new AbortController();
    preparing.set(message.id, controller);
    try {
      const meta = await probe(url.href, { signal: controller.signal, timeoutMs: 10_000 });
      if (message.expectedSize && meta.size !== message.expectedSize) throw new Error('文件大小与浏览器响应不一致');
      if (message.etag && meta.etag !== message.etag) throw new Error('文件标识与浏览器响应不一致');
      if (!message.etag && message.lastModified && meta.lastModified !== message.lastModified) throw new Error('文件时间与浏览器响应不一致');
      if (closing) throw new Error('下载组件已关闭');
      const jobId = randomBytes(32).toString('hex');
      const filename = resolveFilename({ browserFilename: message.filename,
        contentDisposition: meta.contentDisposition || message.contentDisposition, finalUrl: meta.url, url: url.href });
      if (!filename) throw new Error('未能确定原文件名称，继续使用 Edge 下载');
      // Optional cleanup information must never decide whether a valid remote
      // file supports acceleration. The browser chooses its own temporary name.
      const originalTemp = await captureOriginalTemp(message.originalTarget);
      jobs.set(jobId, { meta, filename, originalTemp, connections, limiter: createConnectionLimiter(connections),
        receivedBytes: 0, samples: [], touched: Date.now(), controllers: new Set(), started: false });
      return { jobId, filename, size: meta.size, url: `http://127.0.0.1:${server.address().port}/file/${jobId}/${encodeURIComponent(filename)}` };
    } finally { preparing.delete(message.id); }
  }
  async function close() {
    closing = true;
    clearInterval(sweep);
    for (const controller of preparing.values()) controller.abort();
    for (const job of jobs.values()) for (const controller of job.controllers) controller.abort();
    jobs.clear();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return { handle, close, port: server.address().port };
}
