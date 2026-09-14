import test from 'node:test';
import assert from 'node:assert/strict';
import { filenameFromContentDisposition, filenameFromUrl, resolveFilename, safeFilename, isTemporaryFilename } from '../extension/filename.js';

test('filename* UTF-8 takes precedence and decodes percent escapes', () => {
  assert.equal(filenameFromContentDisposition("attachment; filename=old.zip; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20%23.zip"), '测试 #.zip');
  assert.equal(filenameFromContentDisposition("attachment; FILENAME*=uTf-8'en'%E4%B8%AD%E6%96%87%3B%F0%9F%93%A6.zip; filename=old.zip"), '中文;📦.zip');
  assert.equal(filenameFromContentDisposition("attachment; filename*=UTF-8''a%2520b+plus.txt"), 'a%20b+plus.txt');
});

test('quoted filename preserves semicolons and unescapes quotes', () => {
  assert.equal(filenameFromContentDisposition('attachment; filename="a; \\"quoted\\".txt"'), 'a; "quoted".txt');
});

test('invalid extended value falls back to regular filename and URL', () => {
  assert.equal(resolveFilename({ contentDisposition: 'attachment; filename*=UTF-8\'\'%E0%A4%A; filename="ok.pdf"' }), 'ok.pdf');
  assert.equal(resolveFilename({ contentDisposition: "attachment; filename*=UTF-8''; filename=actual.pdf" }), 'actual.pdf');
  assert.equal(resolveFilename({ contentDisposition: "attachment; filename*=unknown''x.zip; filename=actual.pdf" }), 'actual.pdf');
  assert.equal(resolveFilename({ originalFilename: 'download', url: 'https://example.test/files/report.final.pdf?x=1' }), 'report.final.pdf');
});

test('regular quoted or token filenames retain Chinese, literal percent signs, and suffixes', () => {
  assert.equal(filenameFromContentDisposition('attachment; filename="报告; 九月.pdf"; size=50'), '报告; 九月.pdf');
  assert.equal(filenameFromContentDisposition('attachment; filename=中文.zip'), '中文.zip');
  assert.equal(filenameFromContentDisposition('attachment; filename=unquoted name.zip'), 'unquoted name.zip');
  assert.equal(filenameFromContentDisposition('attachment; filename="100%20real.txt"'), '100%20real.txt');
  assert.equal(filenameFromContentDisposition('attachment; filename="missing-end.zip'), '');
  assert.equal(filenameFromContentDisposition('attachment; filename="ok.zip" unexpected'), '');
});

test('temporary and generic names do not hide a reliable URL name', () => {
  assert.equal(resolveFilename({ browserFilename: '未确认 782837.crdownload', url: 'https://example.test/a.tar.gz' }), 'a.tar.gz');
  assert.equal(resolveFilename({ browserFilename: 'download' }), '');
  assert.equal(resolveFilename({ browserFilename: 'x.crdownload' }), '');
  assert.equal(resolveFilename({ browserFilename: 'download (1)', url: 'https://example.test/download' }), '');
  assert.equal(resolveFilename({ browserFilename: 'DOWNLOAD (34)', url: 'https://example.test/a.exe' }), 'a.exe');
  assert.equal(resolveFilename({ contentDisposition: 'attachment; filename="x.CRDOWNLOAD. "', browserFilename: 'correct.zip' }), 'correct.zip');
  assert.equal(isTemporaryFilename('C:\\Downloads\\未确认 782837.CRDOWNLOAD '), true);
  assert.equal(isTemporaryFilename('complete.crdownload.zip'), false);
  assert.equal(safeFilename('aborted.zip.crdownload'), '');
});

test('resolution favors response headers then final browser name and never infers an extension', () => {
  assert.equal(resolveFilename({ contentDisposition: 'attachment; filename="manual"', browserFilename: 'C:\\Downloads\\manual.pdf' }), 'manual.pdf');
  assert.equal(resolveFilename({ contentDisposition: 'attachment; filename="server.zip"', browserFilename: 'browser.exe' }), 'server.zip');
  assert.equal(resolveFilename({ browserFilename: 'C:\\Downloads\\chosen.pdf', originalFilename: 'older.pdf', url: 'https://example.test/script.php' }), 'chosen.pdf');
  assert.equal(resolveFilename({ browserFilename: 'LICENSE', url: 'https://example.test/download' }), 'LICENSE');
  assert.equal(resolveFilename({ filename: 'file', contentType: 'application/pdf' }), 'file');
  assert.equal(resolveFilename({ contentType: 'application/pdf' }), '');
  assert.equal(resolveFilename({ finalUrl: 'https://cdn.test/final.tar.gz', url: 'https://example.test/start.zip' }), 'final.tar.gz');
});

test('URL filenames are decoded once, ignore query strings and reject directories and unsupported URLs', () => {
  assert.equal(filenameFromUrl('https://example.test/%E4%B8%AD%E6%96%87%20%E8%B5%84%E6%96%99.zip?sig=123#fragment'), '中文 资料.zip');
  assert.equal(filenameFromUrl('https://example.test/a%2520b.zip'), 'a%20b.zip');
  assert.equal(filenameFromUrl('https://example.test/folder/'), '');
  assert.equal(filenameFromUrl('https://example.test/download/12345'), '');
  assert.equal(filenameFromUrl('https://example.test/.gitignore'), '');
  assert.equal(filenameFromUrl('https://example.test/%E0%A4%A.zip'), '');
  assert.equal(filenameFromUrl('blob:https://example.test/unique.bin'), '');
  assert.equal(filenameFromUrl('https://example.test/partial.CRDOWNLOAD'), '');
});

test('Windows unsafe characters, reserved names, and trailing dots are handled', () => {
  assert.equal(safeFilename('CON.txt'), '_CON.txt');
  assert.equal(safeFilename('COM1.bin'), '_COM1.bin');
  assert.equal(safeFilename('LPT².txt'), '_LPT².txt');
  assert.equal(safeFilename('CON .txt'), '_CON .txt');
  assert.equal(safeFilename('bad<name>:?.zip'), 'bad_name___.zip');
  assert.equal(safeFilename('name. '), 'name');
  assert.equal(safeFilename('C:\\Downloads\\..\\safe.zip'), 'safe.zip');
  assert.equal(safeFilename('..'), '');
  assert.equal(safeFilename('...   '), '');
  assert.equal(safeFilename(''), '');
  assert.equal(safeFilename(null), '');
});

test('long names are truncated while retaining the extension', () => {
  const result = safeFilename(`${'a'.repeat(300)}.tar.gz`);
  assert.equal(result.endsWith('.tar.gz'), true);
  assert.equal(result.length, 180);
  assert.equal(safeFilename(`${'a'.repeat(300)}.EXE`).endsWith('.EXE'), true);
  const emoji = safeFilename(`${'📦'.repeat(110)}.zip`);
  assert.ok(emoji.length <= 180);
  assert.ok(emoji.endsWith('.zip'));
  assert.doesNotThrow(() => encodeURIComponent(emoji));
  assert.doesNotThrow(() => encodeURIComponent(safeFilename(`bad\uD800.txt`)));
  assert.equal(safeFilename(`name.${'a'.repeat(300)}`), '');
});
