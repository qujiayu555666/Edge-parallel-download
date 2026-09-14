// Filename resolution shared by the extension and the windowless host.
// This module deliberately does not infer names from MIME types.

const MAX_LENGTH = 180;
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])[ .]*(?:\..*)?$/i;
const GENERIC = /^(?:download(?: \(\d+\))?|未确认(?:\s*\d+)?)$/i;

function basename(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.split(/[\\/]/).pop() || '';
}

function splitParameters(header) {
  const parts = [];
  let start = 0;
  let quote = false;
  let escaped = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (escaped) { escaped = false; continue; }
    if (quote && c === '\\') { escaped = true; continue; }
    if (c === '"') { quote = !quote; continue; }
    if (c === ';' && !quote) { parts.push(header.slice(start, i)); start = i + 1; }
  }
  parts.push(header.slice(start));
  return parts;
}

function parameterValue(part) {
  const equal = part.indexOf('=');
  if (equal < 0) return null;
  const key = part.slice(0, equal).trim().toLowerCase();
  const value = part.slice(equal + 1).trim();
  if (!value) return { key, value: '' };
  if (value[0] === '"') {
    let out = '';
    for (let i = 1; i < value.length; i++) {
      if (value[i] === '\\') {
        if (i + 1 === value.length) break;
        out += value[++i];
      } else if (value[i] === '"') {
        return { key, value: value.slice(i + 1).trim() ? '' : out };
      } else out += value[i];
    }
    return { key, value: '' };
  }
  // Be lenient with unquoted spaces used by some servers: dropping everything
  // after the first space would also drop the filename extension.
  return { key, value };
}

/** Parse Content-Disposition and return the preferred decoded filename. */
export function filenameFromContentDisposition(header) {
  if (typeof header !== 'string' || /[\r\n]/.test(header)) return '';
  const values = splitParameters(header).slice(1).map(parameterValue).filter(Boolean);
  const extended = values.find(({ key }) => key === 'filename*');
  if (extended) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(extended.value);
    if (match && (!match[1] || /^utf-?8$/i.test(match[1]))) {
      try {
        const decoded = basename(decodeURIComponent(match[2]));
        if (decoded && !isTemporaryFilename(decoded)) return decoded;
      } catch { /* Try filename below. */ }
    }
  }
  const fallback = basename(values.find(({ key }) => key === 'filename')?.value || '');
  return isTemporaryFilename(fallback) ? '' : fallback;
}

export function filenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const segment = parsed.pathname.split('/').pop() || '';
    const name = sanitizeFilename(decodeURIComponent(segment));
    // A bare route such as /download/12345 cannot tell us the actual filename.
    // Explicit browser/header names may legitimately have no extension.
    return name.lastIndexOf('.') > 0 && !name.endsWith('.') ? name : '';
  } catch { return ''; }
}

export function isTemporaryFilename(value) {
  return /\.crdownload$/i.test(basename(value).replace(/[. ]+$/g, ''));
}

function prefixWithinLength(value, maxLength) {
  const prefix = value.slice(0, maxLength);
  // Avoid splitting an emoji/supplementary character in a UTF-16 Windows name.
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

/** Return a safe Windows basename, or empty when no usable name was supplied. */
export function sanitizeFilename(value) {
  if (isTemporaryFilename(value)) return '';
  let name = basename(value)
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!name || name === '.' || name === '..') return '';
  // Lone surrogates would break encodeURIComponent when creating the bridge URL.
  name = name.toWellFormed();
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length <= MAX_LENGTH) return name;
  const dot = name.lastIndexOf('.');
  const compound = /\.tar\.(?:gz|bz2|xz|zst|lz|lzma|br)$/i.exec(name)?.[0];
  const extension = compound || (dot > 0 && dot < name.length - 1 ? name.slice(dot) : '');
  if (extension.length >= MAX_LENGTH) return '';
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${prefixWithinLength(stem, MAX_LENGTH - extension.length)}${extension}`;
}

/**
 * Resolve a reliable filename. Content-Disposition filename* wins, followed
 * by filename, browser/original names, and finally the URL path. Returns an
 * empty string when every candidate is temporary or otherwise generic.
 */
export function resolveFilename({ contentDisposition = '', filename = '', originalFilename = '', browserFilename = '', url = '', finalUrl = '' } = {}) {
  const headerName = sanitizeFilename(filenameFromContentDisposition(contentDisposition));
  const browserName = sanitizeFilename(browserFilename);
  const hasExtension = name => name.lastIndexOf('.') > 0;
  // Edge can append the correct extension or preserve a user-chosen target.
  // An extensionless response header must not throw that information away.
  const preferredBrowser = headerName && !hasExtension(headerName) && hasExtension(browserName) ? browserName : '';
  const candidates = [preferredBrowser, headerName, browserFilename, originalFilename || filename,
    filenameFromUrl(finalUrl), filenameFromUrl(url)];
  for (const candidate of candidates) {
    const clean = sanitizeFilename(candidate);
    if (clean && !GENERIC.test(clean)) return clean;
  }
  return '';
}

export { sanitizeFilename as safeFilename };
