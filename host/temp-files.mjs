import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const suffix = '.crdownload';
const decimal = /^-?\d+$/;

function validOriginal(filename) {
  if (typeof filename !== 'string' || !filename || filename.includes('\0') ||
      filename.toLowerCase().endsWith(suffix) || !path.isAbsolute(filename)) return false;
  if (process.platform === 'win32') {
    // Local drive paths only. Reject aliases, streams, and Windows-normalized names.
    if (!/^[a-z]:[\\/]/i.test(filename)) return false;
    const parts = filename.slice(3).split(/[\\/]/);
    return parts.length > 0 && parts.every(part => part && part !== '.' && part !== '..' &&
      !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
  }
  return !filename.startsWith('//') && !filename.includes('\\') &&
    filename.split('/').slice(1).every(part => part && part !== '.' && part !== '..');
}

function identity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}

function validIdentity(value) {
  return value && ['dev', 'ino', 'birthtimeNs'].every(key =>
    typeof value[key] === 'string' && decimal.test(value[key])) && BigInt(value.ino) > 0n;
}

function sameIdentity(stat, saved) {
  return validIdentity(saved) && stat.ino > 0n &&
    String(stat.dev) === saved.dev && String(stat.ino) === saved.ino &&
    String(stat.birthtimeNs) === saved.birthtimeNs;
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function inspectDirectory(directoryPath) {
  const stat = await fs.lstat(directoryPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino <= 0n) return null;
  const realPath = await fs.realpath(directoryPath);
  const realStat = await fs.lstat(realPath, { bigint: true });
  if (!sameIdentity(realStat, identity(stat))) return null;
  return { path: directoryPath, realPath, identity: identity(stat) };
}

async function sameDirectory(saved) {
  const current = await inspectDirectory(saved.path);
  return current && samePath(current.realPath, saved.realPath) &&
    ['dev', 'ino', 'birthtimeNs'].every(key => current.identity[key] === saved.identity[key]);
}

function sameFile(stat, saved) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n &&
    sameIdentity(stat, saved.identity) && String(stat.size) === saved.size &&
    String(stat.mtimeNs) === saved.mtimeNs;
}

/** Capture only the exact temporary file belonging to an already paused original download. */
export async function captureOriginalTemp(originalFilename) {
  if (!validOriginal(originalFilename)) return null;
  const temporaryPath = `${originalFilename}${suffix}`;
  try {
    const directory = await inspectDirectory(path.dirname(temporaryPath));
    if (!directory) return null;
    const stat = await fs.lstat(temporaryPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.ino <= 0n || stat.nlink !== 1n) return null;
    const file = { identity: identity(stat), size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
    // Recheck both the folder and the file after collecting the record.
    if (!(await sameDirectory(directory)) ||
        !sameFile(await fs.lstat(temporaryPath, { bigint: true }), file)) return null;
    return { version: 1, originalFilename, path: temporaryPath, directory, file };
  } catch {
    return null;
  }
}

function validRecord(record) {
  return record?.version === 1 && validOriginal(record.originalFilename) &&
    record.path === `${record.originalFilename}${suffix}` &&
    record.directory?.path === path.dirname(record.path) &&
    typeof record.directory.realPath === 'string' && path.isAbsolute(record.directory.realPath) &&
    validIdentity(record.directory.identity) && validIdentity(record.file?.identity) &&
    typeof record.file.size === 'string' && /^\d+$/.test(record.file.size) &&
    typeof record.file.mtimeNs === 'string' && decimal.test(record.file.mtimeNs);
}

/**
 * Call only after the browser confirms the original is canceled and its replacement completed.
 * No directory search is performed. Missing, changed, or replaced files are always preserved.
 * Retry waits total at most 1.25 seconds; local filesystem operations have their usual OS limits.
 */
export async function cleanupOriginalTemp(record, { attempts = 4, retryDelayMs = 100 } = {}) {
  if (!record) return { removed: false, reason: 'not-captured' };
  if (!validRecord(record)) return { removed: false, reason: 'invalid-record' };
  const tries = Math.min(6, Math.max(1, Number.isFinite(attempts) ? Math.floor(attempts) : 4));
  const waitMs = Math.min(250, Math.max(0, Number.isFinite(retryDelayMs) ? retryDelayMs : 100));
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      if (!(await sameDirectory(record.directory))) return { removed: false, reason: 'directory-changed' };
      const stat = await fs.lstat(record.path, { bigint: true });
      if (!sameFile(stat, record.file)) return { removed: false, reason: 'file-changed' };
      // Revalidate the parent immediately before the final identity check and removal.
      if (!(await sameDirectory(record.directory))) return { removed: false, reason: 'directory-changed' };
      if (!sameFile(await fs.lstat(record.path, { bigint: true }), record.file)) {
        return { removed: false, reason: 'file-changed' };
      }
      await fs.unlink(record.path);
      return { removed: true, reason: 'removed' };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { removed: false, reason: 'already-gone' };
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') return { removed: false, reason: 'filesystem-error' };
      if (attempt + 1 === tries) return { removed: false, reason: 'locked' };
      await delay(waitMs);
    }
  }
  return { removed: false, reason: 'locked' };
}
