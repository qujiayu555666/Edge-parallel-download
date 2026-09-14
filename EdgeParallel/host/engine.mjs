import { setTimeout as delay } from 'node:timers/promises';

// Independent implementation of HTTP range downloading. No PCL source is used.
export class DownloadError extends Error {
  constructor(message, code = 'DOWNLOAD_FAILED', retryable = false) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
    this.retryable = retryable;
  }
}

function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new DownloadError('Invalid download URL.', 'UNSUPPORTED_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new DownloadError('Only HTTP(S) URLs without embedded credentials are supported.', 'UNSUPPORTED_URL');
  }
  url.hash = '';
  return url.href;
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

/** Share one limiter between downloads/resume requests belonging to the same job. */
export function createConnectionLimiter(limit) {
  positiveInteger(limit, 'limit', 64);
  let active = 0;
  const waiting = new Set();
  const abortGroups = new Map();
  const detach = waiter => {
    const group = abortGroups.get(waiter.signal);
    if (!group) return;
    group.waiters.delete(waiter);
    if (!group.waiters.size) {
      waiter.signal.removeEventListener('abort', group.abort);
      abortGroups.delete(waiter.signal);
    }
  };
  const drain = () => {
    while (active < limit && waiting.size) {
      const waiter = waiting.values().next().value;
      waiting.delete(waiter);
      detach(waiter);
      active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active--;
        drain();
      });
    }
  };
  return {
    get active() { return active; },
    get pending() { return waiting.size; },
    acquire(signal) {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const waiter = { signal, resolve, reject };
        if (signal) {
          let group = abortGroups.get(signal);
          if (!group) {
            group = { waiters: new Set() };
            group.abort = () => {
              for (const cancelled of group.waiters) {
                waiting.delete(cancelled);
                cancelled.reject(signal.reason);
              }
              abortGroups.delete(signal);
            };
            abortGroups.set(signal, group);
            signal.addEventListener('abort', group.abort, { once: true });
          }
          group.waiters.add(waiter);
        }
        waiting.add(waiter);
        drain();
      });
    },
  };
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* Already cancelled or consumed. */ }
}

async function request(url, { headers, signal, headerTimeoutMs, idleTimeoutMs, maxRedirects = 5 }) {
  let current = validateUrl(url);
  const controller = new AbortController();
  const fetchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  const arm = (timeoutMs, code) => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DownloadError(
      code === 'HEADER_TIMEOUT' ? 'Timed out waiting for response headers.' : 'The server stopped sending file bytes.',
      code, true,
    )), timeoutMs);
    timer.unref();
  };
  const translateError = error => fetchSignal.aborted ? fetchSignal.reason : error;
  const read = async reader => {
    arm(idleTimeoutMs, 'IDLE_TIMEOUT');
    try { return await reader.read(); }
    catch (error) { throw translateError(error); }
    finally { clearTimeout(timer); }
  };
  const close = () => {
    clearTimeout(timer);
    controller.abort(new DOMException('Request closed.', 'AbortError'));
  };
  try {
    for (let redirects = 0; ; redirects++) {
      fetchSignal.throwIfAborted();
      arm(headerTimeoutMs, 'HEADER_TIMEOUT');
      let response;
      try {
        response = await fetch(current, {
          headers, signal: fetchSignal, redirect: 'manual', credentials: 'omit',
        });
      } catch (error) { throw translateError(error); }
      finally { clearTimeout(timer); }
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return { response, url: current, read, close };
      }
      const location = response.headers.get('location');
      await cancelBody(response);
      if (!location || redirects >= maxRedirects) {
        throw new DownloadError('Too many redirects or missing redirect location.', 'REDIRECT_FAILED');
      }
      const next = validateUrl(new URL(location, current).href);
      if (new URL(current).protocol === 'https:' && new URL(next).protocol === 'http:') {
        throw new DownloadError('HTTPS to HTTP redirect is not supported.', 'UNSAFE_REDIRECT');
      }
      current = next;
    }
  } catch (error) { close(); throw error; }
}

function rangeMetadata(response, start, end, expectedSize) {
  if (response.status !== 206) {
    throw new DownloadError(`The server returned HTTP ${response.status} instead of a byte range.`,
      'RANGE_UNSUPPORTED', response.status === 429 || response.status >= 500);
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase().trim() !== 'identity') {
    throw new DownloadError('Compressed range responses cannot be assembled safely.', 'ENCODING_UNSUPPORTED');
  }
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
  if (!match) throw new DownloadError('Missing or malformed Content-Range.', 'INVALID_RANGE');
  const [actualStart, actualEnd, size] = match.slice(1).map(Number);
  if (![actualStart, actualEnd, size].every(Number.isSafeInteger) || size < 1 || actualStart !== start ||
      actualEnd !== end || actualEnd >= size || (expectedSize !== undefined && size !== expectedSize)) {
    throw new DownloadError('The returned byte range does not match the requested file.', 'INVALID_RANGE');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== end - start + 1)) {
    throw new DownloadError('The byte range has an inconsistent Content-Length.', 'INVALID_RANGE');
  }
  return size;
}

function getValidator(headers) {
  const etag = headers.get('etag');
  if (etag && /^"[^"\r\n]*"$/.test(etag)) return { etag, lastModified: headers.get('last-modified') || null };
  const lastModified = headers.get('last-modified');
  if (lastModified && Number.isFinite(Date.parse(lastModified))) return { etag: null, lastModified };
  return { etag: null, lastModified: null };
}

function assertValidator(meta, headers) {
  if (meta.etag && headers.get('etag') !== meta.etag) {
    throw new DownloadError('The file ETag changed during download.', 'FILE_CHANGED');
  }
  if (!meta.etag && meta.lastModified && headers.get('last-modified') !== meta.lastModified) {
    throw new DownloadError('The file modification date changed during download.', 'FILE_CHANGED');
  }
}

/** Probe one byte without downloading the complete file. Unsupported servers throw. */
export async function probe(url, {
  signal, timeoutMs = 15_000, headerTimeoutMs = timeoutMs, idleTimeoutMs = timeoutMs, requireValidator = true,
} = {}) {
  positiveInteger(headerTimeoutMs, 'headerTimeoutMs', 3_600_000);
  positiveInteger(idleTimeoutMs, 'idleTimeoutMs', 3_600_000);
  const result = await request(url, {
    headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' }, signal, headerTimeoutMs, idleTimeoutMs,
  });
  const { response } = result;
  try {
    const size = rangeMetadata(response, 0, 0);
    const validator = getValidator(response.headers);
    if (requireValidator && !validator.etag && !validator.lastModified) {
      throw new DownloadError('The server provides no stable file validator.', 'NO_VALIDATOR');
    }
    // Consume at most the single advertised byte, then cancel the response.
    if (!response.body) throw new DownloadError('The range response has no body.', 'TRUNCATED_RANGE');
    const reader = response.body.getReader();
    try {
      const part = await result.read(reader);
      if (part.done || part.value.byteLength !== 1) {
        throw new DownloadError('The probe response did not contain exactly one byte.', 'INVALID_RANGE');
      }
    } finally {
      try { await reader.cancel(); } catch { /* Preserve the original read error. */ }
      finally { reader.releaseLock(); }
    }
    return {
      url: result.url, size, ...validator,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      contentDisposition: response.headers.get('content-disposition') || null,
      acceptRanges: true,
    };
  } finally {
    result.close();
    await cancelBody(response);
  }
}

async function readChunk(meta, start, end, { signal, headerTimeoutMs, idleTimeoutMs, retries, limiter }) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let result;
    let release;
    try {
      release = await limiter?.acquire(signal);
      signal.throwIfAborted();
      const headers = { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' };
      const validator = meta.etag || meta.lastModified;
      if (validator) headers['If-Range'] = validator;
      result = await request(meta.url, { headers, signal, headerTimeoutMs, idleTimeoutMs });
      const { response } = result;
      rangeMetadata(response, start, end, meta.size);
      assertValidator(meta, response.headers);
      if (!response.body) throw new DownloadError('The byte range has no response body.', 'TRUNCATED_RANGE', true);
      const expected = end - start + 1;
      const buffer = Buffer.allocUnsafe(expected);
      const reader = response.body.getReader();
      let length = 0;
      try {
        for (;;) {
          const part = await result.read(reader);
          if (part.done) break;
          if (length + part.value.byteLength > expected) {
            throw new DownloadError('The server sent more data than the requested range.', 'INVALID_RANGE');
          }
          buffer.set(part.value, length);
          length += part.value.byteLength;
        }
      } finally {
        try { await reader.cancel(); } catch { /* Preserve the original read error. */ }
        finally { reader.releaseLock(); }
      }
      if (length !== expected) throw new DownloadError('The byte range ended early.', 'TRUNCATED_RANGE', true);
      return buffer;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (attempt >= retries || (error instanceof DownloadError && !error.retryable)) throw error;
    } finally {
      result?.close();
      if (result) await cancelBody(result.response);
      release?.();
    }
    // Failed requests release their permit before waiting to retry.
    await delay(Math.min(200 * 2 ** attempt, 1_000), undefined, { signal });
  }
}

/**
 * Yield file bytes in order, with at most `connections` chunks in flight/buffered.
 * Stopping consumption (including Readable.from() destruction) aborts all requests.
 */
export async function* download(meta, {
  connections = 4, chunkSize, signal, limiter, onProgress,
  timeoutMs = 30_000, retries = 2, start = 0, end = meta?.size - 1,
  headerTimeoutMs = timeoutMs, idleTimeoutMs = timeoutMs,
} = {}) {
  const url = validateUrl(meta?.url);
  positiveInteger(meta?.size, 'size', Number.MAX_SAFE_INTEGER);
  positiveInteger(connections, 'connections', 64);
  positiveInteger(headerTimeoutMs, 'headerTimeoutMs', 3_600_000);
  positiveInteger(idleTimeoutMs, 'idleTimeoutMs', 3_600_000);
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new TypeError('retries must be from 0 to 5.');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= meta.size) {
    throw new TypeError('Requested download range must lie inside the probed file.');
  }
  const totalBytes = end - start + 1;
  // Keep several waves available even for medium files at high concurrency.
  // Small parts also reduce how long a slow first response blocks ordered output.
  chunkSize ??= Math.max(256 * 1024, Math.min(2 * 1024 * 1024,
    Math.ceil(totalBytes / connections / 4 / (64 * 1024)) * 64 * 1024));
  positiveInteger(chunkSize, 'chunkSize', 2 * 1024 * 1024);
  if (limiter !== undefined && typeof limiter?.acquire !== 'function') throw new TypeError('limiter must provide acquire(signal).');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function.');
  if (!meta.etag && !meta.lastModified) throw new DownloadError('A file validator is required.', 'NO_VALIDATOR');
  const transferMeta = { ...meta, url };
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const count = Math.ceil(totalBytes / chunkSize);
  const pending = new Map();
  let nextToSchedule = 0;
  let receivedBytes = 0;
  const schedule = () => {
    const index = nextToSchedule++;
    const chunkStart = start + index * chunkSize;
    const chunkEnd = Math.min(chunkStart + chunkSize - 1, end);
    // A settled-result wrapper prevents unhandled rejections for later chunks.
    const task = readChunk(transferMeta, chunkStart, chunkEnd, {
      signal: combinedSignal, headerTimeoutMs, idleTimeoutMs, retries, limiter,
    }).then(buffer => {
      receivedBytes += buffer.length;
      onProgress?.({ receivedBytes, totalBytes, chunkBytes: buffer.length, start: chunkStart, end: chunkEnd });
      return { buffer };
    }).catch(error => ({ error }));
    pending.set(index, task);
  };
  try {
    combinedSignal.throwIfAborted();
    while (nextToSchedule < Math.min(connections, count)) schedule();
    for (let index = 0; index < count; index++) {
      const result = await pending.get(index);
      pending.delete(index);
      combinedSignal.throwIfAborted();
      if (result.error) throw result.error;
      yield result.buffer;
      if (nextToSchedule < count) schedule();
    }
  } finally {
    controller.abort(new DOMException('Download stopped.', 'AbortError'));
    await Promise.all(pending.values());
  }
}
