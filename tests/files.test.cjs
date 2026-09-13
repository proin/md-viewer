const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { FileAccess, absolutePath, isInside, canOpenDefault } = require('../electron/files.cjs');
const { openDocument, isThisApp } = require('../electron/open-default.cjs');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-viewer-files-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'notes');
  const outside = path.join(base, 'notes-private');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const file = path.join(root, '문서.md');
  await fs.writeFile(file, '# 문서\r\n\r\n내용입니다.\r\n', { mode: 0o640 });
  await fs.writeFile(path.join(outside, 'private.md'), '# Private');
  const access = new FileAccess();
  await access.authorizeRoot(root);
  return { access, base, root: await fs.realpath(root), outside: await fs.realpath(outside), file: await fs.realpath(file) };
}

test('read and atomic save preserve Korean text, line endings, and permissions', async t => {
  const { access, file, root } = await fixture(t);
  const before = await access.readFile(file);
  assert.equal(before.name, '문서.md');
  assert.equal(before.content, '# 문서\r\n\r\n내용입니다.\r\n');
  const after = await access.saveFile(file, `${before.content}\r\n저장했습니다.\r\n`, before.version);
  assert.equal(after.content, await fs.readFile(file, 'utf8'));
  assert.notEqual(after.version, before.version);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), []);
});

test('external modifications reject stale saves without overwriting disk content', async t => {
  const { access, file } = await fixture(t);
  const before = await access.readFile(file);
  await fs.writeFile(file, '# 다른 앱에서 변경한 내용');
  await assert.rejects(access.saveFile(file, '# 편집 중인 내용', before.version), { code: 'FILE_CHANGED' });
  assert.equal(await fs.readFile(file, 'utf8'), '# 다른 앱에서 변경한 내용');
});

test('simultaneous stale saves are serialized and exactly one save succeeds', async t => {
  const { access, file } = await fixture(t);
  const { version } = await access.readFile(file);
  const contents = ['# 첫 번째 저장', '# 두 번째 저장'];
  const saves = await Promise.allSettled(contents.map(content => access.saveFile(file, content, version)));
  // Async path resolution may finish in either order before the per-file save queue.
  assert.equal(saves.filter(save => save.status === 'fulfilled').length, 1);
  assert.equal(saves.filter(save => save.status === 'rejected').length, 1);
  assert.equal(saves.find(save => save.status === 'rejected').reason.code, 'FILE_CHANGED');
  assert.equal(await fs.readFile(file, 'utf8'), contents[saves.findIndex(save => save.status === 'fulfilled')]);
});

test('directory listing sorts folders first and identifies markdown without reading unrelated files', async t => {
  const { access, root } = await fixture(t);
  await fs.mkdir(path.join(root, '자료'));
  await fs.writeFile(path.join(root, 'README.MD'), '# Hello');
  await fs.writeFile(path.join(root, 'image.png'), 'image');
  const entries = await access.readDirectory(root);
  assert.equal(entries[0].kind, 'directory');
  assert.equal(entries.find(entry => entry.name === 'README.MD').kind, 'markdown');
  assert.equal(entries.find(entry => entry.name === 'image.png').kind, 'file');
  await assert.rejects(access.readFile(path.join(root, 'image.png')), { code: 'NOT_MARKDOWN' });
});

test('path traversal and sibling paths with shared name prefixes are denied', async t => {
  const { access, root, outside } = await fixture(t);
  assert.equal(isInside(root, outside), false);
  await assert.rejects(access.readDirectory(outside), { code: 'ACCESS_DENIED' });
  await assert.rejects(access.readFile(`${root}/../notes-private/private.md`), { code: 'ACCESS_DENIED' });
  await assert.rejects(access.readFile('relative.md'), { code: 'INVALID_PATH' });
  await assert.rejects(access.readFile(`${root}/\0.md`), { code: 'INVALID_PATH' });
});

test('symlinks escaping the authorized root are hidden and blocked for reading and saving', async t => {
  const { access, root, outside } = await fixture(t);
  const target = path.join(outside, 'private.md');
  const link = path.join(root, 'linked.md');
  await fs.symlink(target, link);
  await fs.symlink(outside, path.join(root, 'linked-directory'));
  assert.ok(!(await access.readDirectory(root)).some(entry => entry.name.startsWith('linked')));
  await assert.rejects(access.readFile(link), { code: 'ACCESS_DENIED' });
  await assert.rejects(access.saveFile(link, 'overwrite', '0'.repeat(64)), { code: 'ACCESS_DENIED' });
  await assert.rejects(access.readFile(path.join(root, 'linked-directory', 'private.md')), { code: 'ACCESS_DENIED' });
  assert.equal(await fs.readFile(target, 'utf8'), '# Private');
});

test('standalone document authorization allows adjacent images but no other documents', async t => {
  const { file, root, outside } = await fixture(t);
  const access = new FileAccess();
  await access.authorizeFile(file);
  await fs.writeFile(path.join(root, 'other.md'), '# Other');
  await fs.writeFile(path.join(root, 'sample.png'), Buffer.from([137, 80, 78, 71]));
  assert.match((await access.readFile(file)).content, /내용/);
  assert.equal((await access.readImage(path.join(root, 'sample.png'))).mimeType, 'image/png');
  await assert.rejects(access.readFile(path.join(root, 'other.md')), { code: 'ACCESS_DENIED' });
  await assert.rejects(access.readDirectory(root), { code: 'ACCESS_DENIED' });
  await fs.writeFile(path.join(outside, 'private.png'), 'private');
  await assert.rejects(access.readImage(path.join(outside, 'private.png')), { code: 'ACCESS_DENIED' });
});

test('opening a standalone Markdown file reads and saves it without opening a folder', async t => {
  const { file, root } = await fixture(t);
  const access = new FileAccess();
  const opened = await access.openPath(file);
  assert.equal(opened.kind, 'markdown');
  assert.equal(opened.file.path, file);
  assert.match(opened.file.content, /내용/);
  assert.equal(access.roots.size, 0);
  const saved = await access.saveFile(opened.file.path, '# 직접 연 문서', opened.file.version);
  assert.equal(saved.content, await fs.readFile(file, 'utf8'));
  await assert.rejects(access.readDirectory(root), { code: 'ACCESS_DENIED' });
});

test('opening a dropped folder grants its tree and Markdown files', async t => {
  const { root, file } = await fixture(t);
  const access = new FileAccess();
  const opened = await access.openPath(root);
  assert.equal(opened.kind, 'directory');
  assert.equal(opened.root.path, root);
  assert.equal(opened.root.name, path.basename(root));
  assert.ok((await access.readDirectory(opened.root.path)).some(entry => entry.path === file));
  assert.match((await access.readFile(file)).content, /내용/);
});

test('opening a selected file outside the current folder grants only that file and its images', async t => {
  const { access, root, outside } = await fixture(t);
  const file = path.join(outside, 'private.md');
  const opened = await access.openPath(file);
  assert.equal(opened.kind, 'markdown');
  assert.equal(opened.file.content, '# Private');
  assert.deepEqual([...access.roots], [root]);
  await fs.writeFile(path.join(outside, 'other.md'), '# Other');
  await fs.writeFile(path.join(outside, 'image.png'), 'image');
  assert.equal((await access.readImage(path.join(outside, 'image.png'))).mimeType, 'image/png');
  await assert.rejects(access.readFile(path.join(outside, 'other.md')), { code: 'ACCESS_DENIED' });
});

test('file URLs preserve spaces, Korean names, percent signs and hash characters', async t => {
  const { outside } = await fixture(t);
  const folder = path.join(outside, '한글 자료 # 100%');
  const file = path.join(folder, '편집할 문서 # 100%.MD');
  await fs.mkdir(folder);
  await fs.writeFile(file, '# URL로 연 문서');
  const access = new FileAccess();
  const fileURL = pathToFileURL(file).href;
  assert.equal(absolutePath(fileURL), file);
  const opened = await access.openPath(fileURL);
  assert.equal(opened.kind, 'markdown');
  assert.equal(opened.file.path, await fs.realpath(file));
  assert.equal(opened.file.content, '# URL로 연 문서');
  assert.equal((await access.readFile(fileURL)).version, opened.file.version);
  const openedFolder = await access.openPath(pathToFileURL(folder).href);
  assert.equal(openedFolder.kind, 'directory');
  assert.equal(openedFolder.root.path, await fs.realpath(folder));
});

test('composed and decomposed Korean paths open with the actual filesystem path', async t => {
  const { outside } = await fixture(t);
  for (const form of ['NFC', 'NFD']) {
    const folder = path.join(outside, form, '한글 폴더'.normalize(form));
    const file = path.join(folder, '강의 문서.md'.normalize(form));
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(file, `# ${form} 문서`);
    const access = new FileAccess();
    const opened = await access.openPath(pathToFileURL(file).href);
    assert.equal(opened.file.path, await fs.realpath(file));
    assert.equal(opened.file.name.normalize('NFC'), '강의 문서.md');
    assert.equal(opened.file.content, `# ${form} 문서`);
    if (process.platform === 'darwin') {
      const alternate = file.normalize(form === 'NFC' ? 'NFD' : 'NFC');
      const reopened = await access.openPath(alternate);
      assert.equal(reopened.file.content, `# ${form} 문서`);
    }
  }
});

test('authorized files remain accessible through filesystem aliases', async t => {
  const { access, base, root, file } = await fixture(t);
  const alias = path.join(base, 'folder-alias');
  await fs.symlink(root, alias);
  const aliasFile = path.join(alias, path.basename(file));
  const before = await access.readFile(aliasFile);
  assert.equal(before.path, file);
  const saved = await access.saveFile(aliasFile, '# 연결된 경로로 저장', before.version);
  assert.equal(saved.path, file);
  assert.equal(await fs.readFile(file, 'utf8'), '# 연결된 경로로 저장');
});

test('macOS normalizes Finder path spellings before checking folder and file access', { skip: process.platform !== 'darwin' }, async t => {
  const { outside } = await fixture(t);
  const folder = path.join(outside, '한글 폴더');
  const file = path.join(folder, '문서.md');
  await fs.mkdir(folder);
  await fs.writeFile(file, '# 한글 경로');
  const access = new FileAccess();
  await access.openPath(folder);
  for (const form of ['NFC', 'NFD']) {
    assert.equal((await access.readFile(file.normalize(form))).content, '# 한글 경로');
    assert.equal((await access.readDirectory(folder.normalize(form))).length, 1);
  }
  const standalone = new FileAccess();
  await standalone.openPath(file);
  assert.equal((await standalone.readFile(file.normalize('NFD'))).content, '# 한글 경로');
});

test('failed file and folder opens keep previous grants and do not authorize unreadable content', async t => {
  const { access, root, outside, file } = await fixture(t);
  const invalid = path.join(outside, 'invalid.md');
  const unsupported = path.join(outside, 'unsupported.txt');
  await fs.writeFile(invalid, Buffer.from([0xff, 0xfe, 0x23, 0x00]));
  await fs.writeFile(unsupported, '# Text');
  await assert.rejects(access.openPath(invalid), { code: 'INVALID_ENCODING' });
  await assert.rejects(access.openPath(unsupported), { code: 'NOT_MARKDOWN' });
  await assert.rejects(access.openPath(path.join(outside, 'missing.md')), { code: 'ENOENT' });
  await assert.rejects(access.openPath(path.join(outside, 'missing-folder')), { code: 'ENOENT' });
  assert.deepEqual([...access.roots], [root]);
  assert.equal(access.files.size, 0);
  assert.equal(access.assetRoots.size, 0);
  assert.match((await access.readFile(file)).content, /내용/);
  await assert.rejects(access.readFile(invalid), { code: 'ACCESS_DENIED' });
});

test('malformed file URLs and non-file protocols are rejected without authorizing paths', async () => {
  const access = new FileAccess();
  for (const value of ['file:///tmp/%ZZ.md', 'file:///tmp/one%2Ftwo.md', 'https://example.com/note.md', 'relative.md', 'file:///tmp/note%00.md']) {
    await assert.rejects(access.openPath(value), { code: 'INVALID_PATH' });
  }
  assert.equal(access.roots.size, 0);
  assert.equal(access.files.size, 0);
});

test('local SVG uses an image MIME type while HTML and escaped image paths are blocked', async t => {
  const { access, root, outside } = await fixture(t);
  await fs.writeFile(path.join(root, 'active.svg'), '<svg onload="alert(1)"></svg>');
  await fs.writeFile(path.join(root, 'active.html'), '<script>alert(1)</script>');
  await fs.writeFile(path.join(outside, 'secret.png'), 'secret');
  await fs.symlink(path.join(outside, 'secret.png'), path.join(root, 'secret.png'));
  assert.equal((await access.readImage(path.join(root, 'active.svg'))).mimeType, 'image/svg+xml');
  await assert.rejects(access.readImage(path.join(root, 'active.html')), { code: 'UNSUPPORTED_IMAGE' });
  await assert.rejects(access.readImage(path.join(root, 'secret.png')), { code: 'ACCESS_DENIED' });
});

test('invalid UTF-8 is rejected before editing or saving can corrupt the file', async t => {
  const { access, file } = await fixture(t);
  const original = Buffer.from([0xff, 0xfe, 0x23, 0x00]);
  await fs.writeFile(file, original);
  await assert.rejects(access.readFile(file), { code: 'INVALID_ENCODING' });
  assert.deepEqual(await fs.readFile(file), original);
});

test('UTF-8 BOM is preserved even when the editor submits text without it', async t => {
  const { access, file } = await fixture(t);
  await fs.writeFile(file, '\uFEFF# 원본\r\n');
  const before = await access.readFile(file);
  assert.equal(before.content.charCodeAt(0), 0xfeff);
  const saved = await access.saveFile(file, '# 수정\r\n', before.version);
  assert.equal(saved.content, '\uFEFF# 수정\r\n');
  assert.deepEqual((await fs.readFile(file)).subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
});

test('default-app file extensions include documents and images and exclude executables', () => {
  for (const extension of ['md', 'MD', 'pdf', 'txt', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']) {
    assert.equal(canOpenDefault(`/notes/example.${extension}`), true, extension);
  }
  for (const extension of ['app', 'exe', 'com', 'sh', 'command', 'js', 'html']) {
    assert.equal(canOpenDefault(`/notes/example.${extension}`), false, extension);
  }
});

test('macOS default-app opening preserves the system choice when another app is selected', async () => {
  const opened = [];
  await openDocument('/notes/example.md', {
    platform: 'darwin', appId: 'test.viewer',
    inspectApplication: async () => ({ path: '/Applications/Editor.app', bundleIdentifier: 'test.editor' }),
    shell: { openPath: async filePath => { opened.push(filePath); return ''; } },
  });
  assert.deepEqual(opened, ['/notes/example.md']);
});

test('macOS app selection prevents reopening this app when it is the default', async () => {
  let selected = false;
  await openDocument('/notes/example.md', {
    platform: 'darwin', appId: 'test.viewer',
    inspectApplication: async () => ({ path: '/Applications/Viewer.app', bundleIdentifier: 'test.viewer' }),
    dialog: { showOpenDialog: async () => { selected = true; return { canceled: true, filePaths: [] }; } },
    shell: { openPath: async () => { throw new Error('The same app must not be opened again.'); } },
  });
  assert.equal(selected, true);
  assert.equal(isThisApp({ path: '/Applications/Renamed.app', bundleIdentifier: 'test.viewer' }, 'test.viewer'), true);
});

test('macOS opens a chosen external app with separate file arguments', async t => {
  const { base, file } = await fixture(t);
  const application = path.join(base, 'Editor.app');
  await fs.mkdir(application);
  let inspectionCount = 0;
  const calls = [];
  await openDocument(file, {
    platform: 'darwin', appId: 'test.viewer',
    inspectApplication: async () => ++inspectionCount === 1
      ? { path: '/Applications/Viewer.app', bundleIdentifier: 'test.viewer' }
      : { path: application, bundleIdentifier: 'test.editor' },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [application] }) },
    runner: async (...args) => { calls.push(args); return {}; },
    shell: { openPath: async () => { throw new Error('The same app must not be opened again.'); } },
  });
  assert.equal(calls[0][0], '/usr/bin/open');
  assert.deepEqual(calls[0][1], ['-a', await fs.realpath(application), '--', file]);
});
