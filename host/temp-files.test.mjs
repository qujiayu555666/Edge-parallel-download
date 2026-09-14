import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureOriginalTemp, cleanupOriginalTemp } from './temp-files.mjs';

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'edgeparallel-temp-test-'));
  const original = path.join(directory, '安装包 1.2.zip');
  const temporary = `${original}.crdownload`;
  try { await run({ directory, original, temporary }); }
  finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
}

test('cleanup removes only the captured original artifact and preserves completed file and neighbors', async () => {
  await fixture(async ({ directory, original, temporary }) => {
    await fs.writeFile(temporary, 'partial bytes');
    await fs.writeFile(original, 'completed replacement');
    const neighbor = path.join(directory, 'Unconfirmed 782837.crdownload');
    await fs.writeFile(neighbor, 'unrelated active download');
    const record = await captureOriginalTemp(original);
    assert.ok(record);
    assert.equal(record.path, temporary);
    assert.deepEqual(await cleanupOriginalTemp(JSON.parse(JSON.stringify(record))), { removed: true, reason: 'removed' });
    await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
    assert.equal(await fs.readFile(original, 'utf8'), 'completed replacement');
    assert.equal(await fs.readFile(neighbor, 'utf8'), 'unrelated active download');
  });
});

test('missing artifact is never discovered later and missing captured artifact is harmless', async () => {
  await fixture(async ({ original, temporary }) => {
    assert.equal(await captureOriginalTemp(original), null);
    await fs.writeFile(temporary, 'later unrelated file');
    assert.deepEqual(await cleanupOriginalTemp(null), { removed: false, reason: 'not-captured' });
    assert.equal(await fs.readFile(temporary, 'utf8'), 'later unrelated file');
    const record = await captureOriginalTemp(original);
    await fs.unlink(temporary);
    assert.deepEqual(await cleanupOriginalTemp(record), { removed: false, reason: 'already-gone' });
  });
});

test('capture rejects relative, device, UNC, stream, and temporary filenames', async () => {
  const invalid = [null, {}, '', 'archive.zip', '../archive.zip', '\\\\server\\share\\archive.zip',
    '\\\\?\\C:\\archive.zip', 'C:archive.zip', 'C:\\archive.zip:stream', 'C:\\NUL.zip',
    'C:\\folder\\..\\archive.zip', 'C:\\archive.zip ', 'C:\\archive.zip.crdownload'];
  for (const filename of invalid) assert.equal(await captureOriginalTemp(filename), null);
});

test('changed content or timestamp prevents cleanup', async () => {
  await fixture(async ({ original, temporary }) => {
    await fs.writeFile(temporary, 'partial');
    const first = await captureOriginalTemp(original);
    await fs.appendFile(temporary, ' more');
    assert.equal((await cleanupOriginalTemp(first)).reason, 'file-changed');
    const second = await captureOriginalTemp(original);
    const newTime = new Date(Date.now() + 5000);
    await fs.utimes(temporary, newTime, newTime);
    assert.equal((await cleanupOriginalTemp(second)).reason, 'file-changed');
    assert.equal(await fs.readFile(temporary, 'utf8'), 'partial more');
  });
});

test('replacement at the same path survives even with the same size and timestamp', async () => {
  await fixture(async ({ original, temporary }) => {
    await fs.writeFile(temporary, 'first');
    const record = await captureOriginalTemp(original);
    const oldStat = await fs.stat(temporary);
    await fs.rename(temporary, `${temporary}.old`);
    await fs.writeFile(temporary, 'other');
    await fs.utimes(temporary, oldStat.atime, oldStat.mtime);
    assert.equal((await cleanupOriginalTemp(record)).reason, 'file-changed');
    assert.equal(await fs.readFile(temporary, 'utf8'), 'other');
  });
});

test('replacing the containing directory prevents cleanup', async () => {
  await fixture(async ({ directory }) => {
    const subfolder = path.join(directory, 'downloads');
    await fs.mkdir(subfolder);
    const original = path.join(subfolder, 'file.zip');
    const temporary = `${original}.crdownload`;
    await fs.writeFile(temporary, 'first');
    const record = await captureOriginalTemp(original);
    await fs.rename(subfolder, `${subfolder}-old`);
    await fs.mkdir(subfolder);
    await fs.writeFile(temporary, 'new file');
    assert.equal((await cleanupOriginalTemp(record)).reason, 'directory-changed');
    assert.equal(await fs.readFile(temporary, 'utf8'), 'new file');
  });
});

test('junction substitution for the captured containing folder is rejected', async () => {
  await fixture(async ({ directory }) => {
    const folder = path.join(directory, 'downloads');
    await fs.mkdir(folder);
    const original = path.join(folder, 'file.zip');
    await fs.writeFile(`${original}.crdownload`, 'partial');
    const record = await captureOriginalTemp(original);
    await fs.rename(folder, `${folder}-old`);
    await fs.symlink(`${folder}-old`, folder, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await cleanupOriginalTemp(record)).reason, 'directory-changed');
    assert.equal(await captureOriginalTemp(original), null);
    assert.equal(await fs.readFile(`${original}.crdownload`, 'utf8'), 'partial');
    await fs.unlink(folder);
  });
});

test('directories and multiply linked files are not captured', async () => {
  await fixture(async ({ original, temporary }) => {
    await fs.mkdir(temporary);
    assert.equal(await captureOriginalTemp(original), null);
    await fs.rmdir(temporary);
    await fs.writeFile(temporary, 'partial');
    await fs.link(temporary, `${temporary}.other-link`);
    assert.equal(await captureOriginalTemp(original), null);
  });
});

test('a file symlink cannot be captured or substituted for a captured temporary file', async t => {
  await fixture(async ({ directory, original, temporary }) => {
    const target = path.join(directory, 'unrelated.zip');
    await fs.writeFile(target, 'unrelated completed file');
    try { await fs.symlink(target, temporary, 'file'); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        t.skip('This Windows account cannot create file symlinks');
        return;
      }
      throw error;
    }
    assert.equal(await captureOriginalTemp(original), null);
    await fs.unlink(temporary);
    await fs.writeFile(temporary, 'partial');
    const record = await captureOriginalTemp(original);
    await fs.unlink(temporary);
    await fs.symlink(target, temporary, 'file');
    assert.equal((await cleanupOriginalTemp(record)).reason, 'file-changed');
    assert.equal(await fs.readFile(target, 'utf8'), 'unrelated completed file');
    await fs.unlink(temporary);
  });
});

test('adding another hard link after capture prevents cleanup', async () => {
  await fixture(async ({ original, temporary }) => {
    await fs.writeFile(temporary, 'partial');
    const record = await captureOriginalTemp(original);
    await fs.link(temporary, `${temporary}.other-link`);
    assert.equal((await cleanupOriginalTemp(record)).reason, 'file-changed');
    assert.equal(await fs.readFile(temporary, 'utf8'), 'partial');
  });
});

test('tampered capture records cannot target final files or neighboring temporary files', async () => {
  await fixture(async ({ original, temporary }) => {
    await fs.writeFile(temporary, 'partial');
    await fs.writeFile(original, 'complete');
    const record = await captureOriginalTemp(original);
    assert.equal((await cleanupOriginalTemp({ ...record, path: original })).reason, 'invalid-record');
    assert.equal((await cleanupOriginalTemp({ ...record, path: `${original}.other.crdownload` })).reason, 'invalid-record');
    assert.equal((await cleanupOriginalTemp({ ...record, file: { ...record.file, identity: { ino: 'garbage' } } })).reason, 'invalid-record');
    assert.equal(await fs.readFile(original, 'utf8'), 'complete');
    assert.equal(await fs.readFile(temporary, 'utf8'), 'partial');
  });
});

test('transient browser locks are retried and permanently locked files are preserved', async t => {
  await fixture(async ({ original, temporary }) => {
    await fs.writeFile(temporary, 'partial');
    const record = await captureOriginalTemp(original);
    const realUnlink = fs.unlink;
    let calls = 0;
    const mock = t.mock.method(fs, 'unlink', async filename => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return realUnlink(filename);
    });
    try {
      assert.equal((await cleanupOriginalTemp(record, { retryDelayMs: 0 })).removed, true);
      assert.equal(calls, 3);
      await fs.writeFile(temporary, 'another partial');
      const locked = await captureOriginalTemp(original);
      calls = 0;
      mock.mock.mockImplementation(async () => { calls++; throw Object.assign(new Error('locked'), { code: 'EBUSY' }); });
      assert.equal((await cleanupOriginalTemp(locked, { attempts: 100, retryDelayMs: 0 })).reason, 'locked');
      assert.equal(calls, 6);
      assert.equal(await fs.readFile(temporary, 'utf8'), 'another partial');
    } finally { mock.mock.restore(); }
  });
});

test('every lock retry checks file identity again before deleting', async t => {
  await fixture(async ({ original, temporary }) => {
    await fs.writeFile(temporary, 'partial');
    const record = await captureOriginalTemp(original);
    let calls = 0;
    const mock = t.mock.method(fs, 'unlink', async () => {
      calls++;
      await fs.rename(temporary, `${temporary}.old`);
      await fs.writeFile(temporary, 'unrelated new download');
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    });
    try {
      assert.equal((await cleanupOriginalTemp(record, { retryDelayMs: 0 })).reason, 'file-changed');
      assert.equal(calls, 1);
      assert.equal(await fs.readFile(temporary, 'utf8'), 'unrelated new download');
    } finally { mock.mock.restore(); }
  });
});
