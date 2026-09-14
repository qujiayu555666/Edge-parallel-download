// SPDX-License-Identifier: MIT
import { safeFilename, resolveFilename, isTemporaryFilename } from './filename.js';
export { safeFilename } from './filename.js';
export const DEFAULT_SETTINGS = Object.freeze({ enabled: true, connections: 16, minBytes: 8 * 1024 * 1024 });

export function settingsFrom(value = {}) {
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    connections: [2, 4, 8, 16, 32, 64].includes(value.connections) ? value.connections : DEFAULT_SETTINGS.connections,
    minBytes: [1, 8, 32, 128].map(n => n * 1024 * 1024).includes(value.minBytes) ? value.minBytes : DEFAULT_SETTINGS.minBytes
  };
}

export function isPublicHttp(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return false;
    // Known local addresses stay in the browser; no credentials are forwarded to the helper.
    if (h.includes(':')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const [a, b] = h.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
          (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
          (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b))) return false;
    }
    return true;
  } catch { return false; }
}

export function validBridgeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) > 0 &&
      !u.username && !u.password && /^\/file\/[a-f0-9]{64}\//.test(u.pathname) && !u.hash;
  } catch { return false; }
}

const headersOf = rows => new Map((rows || []).map(row => [row.name.toLowerCase(), row.value || '']));

export class RequestMetadata {
  constructor(now = () => Date.now()) { this.rows = new Map(); this.now = now; }
  prune() {
    const cutoff = this.now() - 90_000;
    for (const [id, row] of this.rows) if (row.seenAt < cutoff) this.rows.delete(id);
    while (this.rows.size > 512) this.rows.delete(this.rows.keys().next().value);
  }
  begin(details) {
    this.prune();
    const previous = this.rows.get(details.requestId);
    this.rows.set(details.requestId, {
      requestId: details.requestId, url: details.url, method: details.method,
      tabId: details.tabId, incognito: Boolean(details.incognito), seenAt: this.now(),
      sensitive: Boolean(previous?.sensitive), claimed: false
    });
  }
  sent(details) {
    const row = this.rows.get(details.requestId);
    if (!row || details.url !== row.url) return;
    const headers = headersOf(details.requestHeaders);
    row.sent = true;
    row.sensitive ||= ['authorization', 'proxy-authorization', 'cookie', 'range', 'if-range'].some(h => headers.has(h));
  }
  received(details) {
    const row = this.rows.get(details.requestId);
    if (!row || details.url !== row.url) return;
    const h = headersOf(details.responseHeaders);
    row.response = true;
    row.status = details.statusCode;
    row.size = /^\d+$/.test(h.get('content-length') || '') ? Number(h.get('content-length')) : -1;
    row.etag = h.get('etag') || '';
    row.lastModified = h.get('last-modified') || '';
    row.encoding = h.get('content-encoding') || 'identity';
    row.vary = h.get('vary') || '';
    row.contentDisposition = h.get('content-disposition') || '';
    row.seenAt = this.now();
  }
  lookup(item) {
    this.prune();
    const url = item.finalUrl || item.url;
    const matches = [...this.rows.values()].filter(row => !row.claimed && row.url === url);
    // downloads does not expose the webRequest requestId. Ambiguous requests stay native.
    if (matches.length !== 1) return null;
    return matches[0];
  }
  claim(item) {
    const row = this.lookup(item);
    if (!row) return null;
    row.claimed = true;
    return row;
  }
}

export function eligibilityReason(item, row, settings) {
  if (!settings.enabled) return '自动加速已关闭';
  if (item.state !== 'in_progress') return '下载已经结束';
  if (item.incognito || row?.incognito) return '隐私窗口下载由 Edge 处理';
  if (item.byExtensionId) return '此任务由扩展发起';
  if (!isPublicHttp(item.finalUrl || item.url)) return '此地址不属于支持的公开 HTTP/HTTPS 下载';
  if (item.paused) return '原下载已暂停';
  if (item.danger !== 'safe') return '等待 Edge 确认下载安全状态';
  if (!row) return '尚未观察到唯一的原始请求；可在下方粘贴公开直链下载';
  if (!row.sent || !row.response) return '等待浏览器补齐下载响应';
  if (row.method !== 'GET') return '此下载使用表单或非 GET 请求';
  if (row.sensitive) return '此请求带有登录信息或续传头，保留原生下载';
  if (row.status !== 200) return `原响应状态为 ${row.status}，保留原生下载`;
  if (!Number.isSafeInteger(row.size) || row.size < 1) return '服务器未提供确定的文件大小';
  if (row.size < settings.minBytes) return '文件小于设置的加速门槛';
  if (!['', 'identity'].includes(row.encoding.toLowerCase())) return '服务器返回压缩响应';
  if (item.totalBytes > 0 && item.totalBytes !== row.size) return '浏览器与服务器文件大小不一致';
  if (!row.etag && !row.lastModified) return '服务器未提供可验证的文件版本';
  if (row.vary && row.vary.split(',').some(v => !['accept-encoding'].includes(v.trim().toLowerCase()))) return '文件内容随请求头变化';
  return '';
}
export const eligible = (item, row, settings) => !eligibilityReason(item, row, settings);

export class DownloadController {
  constructor({ downloads, storage, native, metadata, onStatus = () => {}, schedule = setTimeout }) {
    this.downloads = downloads;
    this.storage = storage;
    this.native = native;
    this.metadata = metadata;
    this.onStatus = onStatus;
    this.schedule = schedule;
    this.settings = { ...DEFAULT_SETTINGS };
    this.transactions = new Map();
    this.awaitingFilename = new Map();
    this.observed = new Map();
    this.lastDecision = null;
    this.persistQueue = Promise.resolve();
    this.lastError = '';
  }
  async persist() {
    const transactions = [...this.transactions.values()].map(t => ({ ...t }));
    this.persistQueue = this.persistQueue.catch(() => {}).then(() => this.storage.set({ transactions }));
    await this.persistQueue;
    this.onStatus(this.status());
  }
  status() {
    return { active: [...this.transactions.values()].filter(t => t.stage === 'active').length,
      lastError: this.lastError, lastDecision: this.lastDecision };
  }
  decision(item, state, reason) {
    this.lastDecision = { name: safeFilename(item.filename) || '当前下载', state, reason, time: Date.now() };
    this.onStatus(this.status());
  }
  async restore() {
    const saved = await this.storage.get('transactions');
    for (const t of saved.transactions || []) {
      if (!Number.isInteger(t.originalId)) continue;
      if (['cleanup', 'cleanup_failed'].includes(t.stage)) {
        delete t.finishing;
        this.transactions.set(t.originalId, t);
        if (t.stage === 'cleanup') await this.finish(t, 'release');
        continue;
      }
      const original = t.stage === 'committing' ? await this.find(t.originalId) : null;
      const committed = t.stage === 'active' || (t.stage === 'committing' && original?.state !== 'in_progress');
      if (!committed) {
        if (Number.isInteger(t.replacementId)) await this.quiet('cancel', t.replacementId);
        await this.resumeOriginal(t.originalId);
      } else {
        const item = await this.find(t.replacementId);
        if (item?.state === 'in_progress') this.transactions.set(t.originalId, { ...t, stage: 'active' });
        else if (item?.state === 'complete') {
          this.transactions.set(t.originalId, t);
          await this.finish(t, 'release');
        }
      }
    }
    await this.persist();
  }
  async find(id) { return (await this.downloads.search({ id }))[0]; }
  async quiet(method, id) { try { await this.downloads[method](id); return true; } catch { return false; } }
  async resumeOriginal(id) {
    try {
      const item = await this.find(id);
      if (item?.state === 'in_progress' && item.paused) await this.downloads.resume(id);
    } catch { /* Preserve the original entry if the browser cannot resume it. */ }
  }
  async disposeHost(t, op = 'cancel') {
    if (t.jobId) try { await this.native.request(op, { jobId: t.jobId }, 3000); } catch { /* Disconnected helper already cleans up. */ }
  }
  async cleanupOriginal(t) {
    if (t.direct) return true;
    const replacement = await this.find(t.replacementId);
    if (replacement?.state !== 'complete') return false;
    const original = await this.find(t.originalId);
    if (original?.state === 'in_progress' || original?.state === 'complete') return false;
    if (original && original.url !== t.originalUrl && original.finalUrl !== t.originalUrl) return false;
    try {
      const result = await this.native.request('cleanupOriginal', { jobId: t.jobId, canceled: true, completed: true }, 12_000);
      if (!result.cleaned && !(result.settled && result.reason === 'browser-managed')) {
        throw new Error('临时文件仍被占用，已保留原任务记录。');
      }
      // This removes the canceled history item only. For browser-managed paths
      // it acknowledges the awaited cancellation; it does not assert disk deletion.
      try { await this.downloads.erase({ id: t.originalId }); } catch { /* Leave harmless canceled history. */ }
      return true;
    } catch (error) {
      this.lastError = String(error.message || error);
      return false;
    }
  }
  async rollback(t, error) {
    if (Number.isInteger(t.replacementId)) await this.quiet('cancel', t.replacementId);
    await this.disposeHost(t);
    if (!t.userCanceled) await this.resumeOriginal(t.originalId);
    this.transactions.delete(t.originalId);
    if (error) this.lastError = String(error.message || error);
    await this.persist();
  }
  async created(item) {
    if (this.transactions.has(item.id)) return;
    if (item.byExtensionId || validBridgeUrl(item.url)) return;
    const row = this.metadata.lookup(item);
    const reason = eligibilityReason(item, row, this.settings);
    if (reason) {
      if (item.state === 'in_progress') {
        if (!this.observed.has(item.id)) this.observed.set(item.id, { since: Date.now(), url: item.finalUrl || item.url });
        while (this.observed.size > 128) this.observed.delete(this.observed.keys().next().value);
      } else this.observed.delete(item.id);
      this.decision(item, 'native', reason);
      return;
    }
    this.observed.delete(item.id);
    // onCreated may precede target determination and temp-file initialization.
    // Leave Edge running until its final target is available, instead of pausing an unnamed task.
    if (!item.filename || isTemporaryFilename(item.filename)) {
      this.awaitingFilename.set(item.id, { row, since: Date.now() });
      this.decision(item, 'waiting', '等待 Edge 确定完整文件名');
      const latest = await this.find(item.id);
      if (latest?.filename && !isTemporaryFilename(latest.filename)) await this.filenameReady(latest);
      return;
    }
    await this.start(item, row);
  }
  async filenameReady(item) {
    const pending = this.awaitingFilename.get(item.id);
    if (!pending) return;
    if (item.state !== 'in_progress' || Date.now() - pending.since > 90_000) {
      this.awaitingFilename.delete(item.id); return;
    }
    if (!item.filename || isTemporaryFilename(item.filename)) return;
    this.awaitingFilename.delete(item.id);
    const row = this.metadata.lookup(item);
    if (row === pending.row && eligible(item, row, this.settings)) await this.start(item, row);
    else await this.created(item);
  }
  async responseReady(url) {
    for (const [id, pending] of this.observed) {
      if (pending.url !== url) continue;
      const item = await this.find(id);
      if (item && (item.finalUrl || item.url) === url) await this.created(item);
    }
  }
  async direct(url) {
    if (!isPublicHttp(url)) throw new Error('请输入公开的 HTTP 或 HTTPS 文件直链。');
    const prepared = await this.native.request('prepare', { url, connections: this.settings.connections }, 25_000);
    let id;
    try {
      const filename = resolveFilename({ browserFilename: prepared.filename, url });
      if (!filename || !validBridgeUrl(prepared.url) || !Number.isSafeInteger(prepared.size) || prepared.size < 1) {
        throw new Error('下载助手未能确认文件名或下载地址。');
      }
      id = await this.downloads.download({ url: prepared.url, filename, saveAs: false, conflictAction: 'uniquify' });
      const t = { originalId: id, replacementId: id, originalUrl: url, jobId: prepared.jobId,
        filename, direct: true, stage: 'active' };
      this.transactions.set(id, t);
      await this.persist();
      this.decision({ filename }, 'active', `直链下载已启动，最多 ${this.settings.connections} 个连接`);
      const item = await this.find(id);
      if (item?.state === 'complete') await this.finish(t, 'release');
      else if (!item || (item.state === 'interrupted' && item.error === 'USER_CANCELED')) await this.finish(t, 'cancel');
      return { downloadId: id, filename };
    } catch (error) {
      if (Number.isInteger(id)) {
        this.transactions.delete(id);
        await this.quiet('cancel', id);
        try { await this.persist(); } catch { /* Runtime state has already been cleared. */ }
      }
      await this.disposeHost({ jobId: prepared.jobId });
      throw error;
    }
  }
  async start(item, row) {
    if (this.transactions.has(item.id)) return;
    if (row.claimed || this.metadata.lookup(item) !== row) {
      this.decision(item, 'native', '原始请求已无法唯一关联，保留原生下载'); return;
    }
    const filename = resolveFilename({ browserFilename: item.filename, contentDisposition: row.contentDisposition,
      finalUrl: item.finalUrl, url: row.url });
    if (!filename) { this.decision(item, 'native', '无法确认完整文件名，保留原生下载'); return; }
    row.claimed = true;
    this.decision(item, 'preparing', '正在检查服务器分段支持');
    const t = { originalId: item.id, originalUrl: row.url, originalFilename: item.filename,
      filename, stage: 'pausing', jobId: null };
    this.transactions.set(item.id, t);
    try {
      await this.persist();
      await this.downloads.pause(item.id);
      t.stage = 'preparing';
      await this.persist();
      const prepared = await this.native.request('prepare', {
        url: row.url, filename, originalTarget: item.filename, contentDisposition: row.contentDisposition,
        connections: this.settings.connections,
        expectedSize: row.size, etag: row.etag, lastModified: row.lastModified
      }, 25000);
      t.jobId = prepared.jobId;
      if (typeof prepared.jobId !== 'string' || !validBridgeUrl(prepared.url) || prepared.size !== row.size) {
        throw new Error('下载助手返回了无效的下载地址或文件大小。');
      }
      t.filename = resolveFilename({ browserFilename: prepared.filename || filename });
      if (!t.filename) throw new Error('未能确认完整文件名，已保留原下载。');
      if (t.aborted) throw new Error('下载接管已停止。');
      t.stage = 'starting';
      await this.persist();
      t.replacementId = await this.downloads.download({
        url: prepared.url, filename: t.filename, saveAs: false, conflictAction: 'uniquify'
      });
      await this.persist();
      const [original, replacement] = await Promise.all([this.find(item.id), this.find(t.replacementId)]);
      if (t.aborted || original?.state !== 'in_progress' || original.danger !== 'safe' || !['in_progress', 'complete'].includes(replacement?.state) ||
          replacement.danger !== 'safe') throw new Error('Edge 未接受加速下载，已保留原下载。');
      t.stage = 'committing';
      await this.persist();
      if (t.aborted) throw new Error('下载助手已断开，已保留原下载。');
      await this.downloads.cancel(item.id);
      t.stage = 'active';
      this.decision({ filename: t.filename }, 'active', `已接管，最多 ${this.settings.connections} 个连接`);
      await this.persist();
      // Keep the canceled item until the replacement finishes and cleanup is confirmed.
      this.lastError = '';
      const currentReplacement = await this.find(t.replacementId);
      if (currentReplacement?.state === 'complete') await this.finish(t, 'release');
      else if (!currentReplacement || (currentReplacement.state === 'interrupted' && currentReplacement.error === 'USER_CANCELED')) {
        await this.finish(t, 'cancel');
      } else this.onStatus(this.status());
    } catch (error) {
      if (t.stage === 'active') {
        this.lastError = '下载接管记录保存失败；请在 Edge 下载列表查看进度。';
        this.onStatus(this.status());
      } else {
        this.decision(item, 'native', String(error.message || error));
        await this.rollback(t, error);
      }
    }
  }
  async finish(t, op) {
    if (t.finishing) return;
    t.finishing = true;
    if (op === 'release' && !(await this.cleanupOriginal(t))) {
      t.cleanupAttempts = (t.cleanupAttempts || 0) + 1;
      t.stage = t.cleanupAttempts < 4 ? 'cleanup' : 'cleanup_failed';
      delete t.finishing;
      await this.persist();
      if (t.stage === 'cleanup') {
        const timer = this.schedule(() => this.finish(t, 'release').catch(() => {}), 30_000);
        timer?.unref?.();
      }
      return;
    }
    this.transactions.delete(t.originalId);
    await this.disposeHost(t, op);
    await this.persist();
  }
  async changed(delta) {
    if (this.observed.has(delta.id) && !this.transactions.has(delta.id)) {
      const { since } = this.observed.get(delta.id);
      const item = await this.find(delta.id);
      if (!item || item.state !== 'in_progress' || Date.now() - since > 90_000) this.observed.delete(delta.id);
      else await this.created(item);
    }
    if (this.awaitingFilename.has(delta.id)) {
      const latest = await this.find(delta.id);
      if (latest) await this.filenameReady(latest);
      else this.awaitingFilename.delete(delta.id);
    }
    for (const t of this.transactions.values()) {
      if (delta.id === t.originalId && delta.state?.current === 'interrupted' &&
          !['committing', 'active'].includes(t.stage)) {
        t.aborted = true;
        t.userCanceled = delta.error?.current === 'USER_CANCELED';
      }
      if (delta.id !== t.replacementId || t.stage !== 'active') continue;
      if (delta.state?.current === 'complete') await this.finish(t, 'release');
      else if (delta.state?.current === 'interrupted' && delta.error?.current === 'USER_CANCELED') await this.finish(t, 'cancel');
      // Other interruptions remain resumable through the same helper URL.
    }
  }
  async erased(id) {
    this.observed.delete(id);
    this.awaitingFilename.delete(id);
    const t = [...this.transactions.values()].find(t => t.replacementId === id);
    if (t?.stage === 'active') await this.finish(t, 'cancel');
  }
  async disconnected() {
    this.lastError = '本地下载助手已断开。未接管的下载继续使用 Edge；已接管的下载请检查下载列表。';
    for (const t of [...this.transactions.values()]) {
      if (t.stage !== 'active') {
        t.aborted = true;
        await this.resumeOriginal(t.originalId);
      }
    }
    this.onStatus(this.status());
  }
}
