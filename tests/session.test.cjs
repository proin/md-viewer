const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { FileAccess } = require('../electron/files.cjs');
const { savedFilePaths, watchLocations, validateSession } = require('../electron/session.cjs');

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'markdown-tabs-session-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const documents = [path.join(directory, '첫 문서.md'), path.join(directory, 'second.md')];
  await Promise.all(documents.map((filePath, index) => fs.writeFile(filePath, `# Document ${index}\n`)));
  return { directory, documents };
}

test('session migration preserves closed-all state instead of resurrecting the legacy active file', () => {
  assert.deepEqual(savedFilePaths({ filePath: '/legacy.md' }), ['/legacy.md']);
  assert.deepEqual(savedFilePaths({ filePaths: [], filePath: '/closed.md' }), []);
  assert.deepEqual(savedFilePaths({ filePaths: ['/a.md', null, '/a.md', '/b.md'] }), ['/a.md', '/b.md']);
});

test('watch locations cover every open document outside the tree and deduplicate sibling folders', () => {
  assert.deepEqual([...watchLocations({
    root: { path: '/root' }, filePaths: ['/root/a.md', '/root/nested/b.md', '/else/a.md', '/else/b.md', '/third/c.md'],
  })], [['/root', true], ['/else', false], ['/third', false]]);
  assert.deepEqual([...watchLocations({ root: null, filePaths: ['/else/a.md', '/third/c.md'] })], [['/else', false], ['/third', false]]);
});

test('multi-file selection validates every document before granting any new access', async t => {
  const { directory, documents } = await fixture(t);
  const access = new FileAccess();
  await access.openFile(documents[0]);
  const invalid = path.join(directory, 'invalid.md');
  await fs.writeFile(invalid, Buffer.from([0xff, 0xfe]));
  await assert.rejects(access.openFiles([documents[1], invalid]), /INVALID_ENCODING/);
  assert.deepEqual([...access.files], [documents[0]]);
  assert.equal((await access.readFile(documents[0])).path, documents[0]);
  await assert.rejects(access.readFile(documents[1]), /ACCESS_DENIED/);
  const opened = await access.openFiles([documents[0], documents[1], documents[0]]);
  assert.deepEqual(opened.map(document => document.path), documents);
});

test('session replacement accepts only authorized documents and leaves inputs intact on rejection', async t => {
  const { documents } = await fixture(t);
  const access = new FileAccess();
  await access.openFile(documents[0]);
  const current = [documents[0]];
  await assert.rejects(validateSession(access, current, { paths: documents, activePath: documents[1] }), /ACCESS_DENIED/);
  assert.deepEqual(current, [documents[0]]);
  await assert.rejects(validateSession(access, current, { paths: current, activePath: documents[1] }), /열린 파일 목록에 없습니다/);
  await assert.rejects(validateSession(access, current, { paths: [123], activePath: null }), /목록이 올바르지/);
});

test('closing tabs updates ordered paths and permits an already-open deleted document to retain its buffer', async t => {
  const { documents } = await fixture(t);
  const access = new FileAccess();
  await access.openFiles(documents);
  assert.deepEqual(await validateSession(access, [], { paths: [...documents, documents[0]], activePath: documents[1] }), {
    filePaths: documents, filePath: documents[1],
  });
  await fs.unlink(documents[0]);
  assert.deepEqual(await validateSession(access, documents, { paths: [documents[0]], activePath: documents[0] }), {
    filePaths: [documents[0]], filePath: documents[0],
  });
  assert.deepEqual(await validateSession(access, documents, { paths: [], activePath: null }), { filePaths: [], filePath: null });
});

async function bootMain(t, options = {}) {
  const data = await fixture(t);
  const profile = path.join(data.directory, 'profile');
  await fs.mkdir(profile);
  if (options.saved) await fs.writeFile(path.join(profile, 'last-session.json'), JSON.stringify(options.saved(data)));
  let releaseReady;
  const readyPromise = new Promise(resolve => { releaseReady = resolve; });
  const app = new EventEmitter();
  Object.assign(app, {
    name: 'Markdown Viewer', isPackaged: false, setPath() {}, setName() {},
    getPath: () => profile, requestSingleInstanceLock: () => true,
    whenReady: () => readyPromise, addRecentDocument() {}, quit() {},
  });
  const windows = [];
  app.quitCalls = 0;
  app.quitCompleted = false;
  app.quit = () => {
    app.quitCalls++;
    app.emit('before-quit');
    for (const window of windows) if (!window.isDestroyed()) window.close();
    if (windows.every(window => window.isDestroyed())) {
      app.quitCompleted = true;
      app.emit('will-quit');
      app.emit('quit');
    }
  };
  const sent = [];
  const dialogs = [];
  let closeResponse = 2;
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      windows.push(this);
      this.destroyed = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: '' }, isLoadingMainFrame: () => false,
        send: (channel, payload) => sent.push([channel, payload]), setWindowOpenHandler() {},
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      });
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() {}
    focus() {}
    setDocumentEdited() {}
    loadURL(url) { this.webContents.mainFrame.url = url; }
    close() {
      let prevented = false;
      this.emit('close', { preventDefault: () => { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit('closed'); }
    }
  }
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  const electron = {
    app, BrowserWindow, ipcMain, clipboard: { writeText() {} }, shell: {},
    dialog: {
      showErrorBox: (title, message) => { throw new Error(`${title}: ${message}`); },
      showMessageBox: async (_window, options) => { dialogs.push(options); return { response: closeResponse }; },
    },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    Menu: { buildFromTemplate: template => template, setApplicationMenu() {} },
  };
  const mainPath = path.resolve(__dirname, '../electron/main.cjs');
  const nativeRequire = createRequire(mainPath);
  const source = await fs.readFile(mainPath, 'utf8');
  const errors = [];
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : nativeRequire(name),
    __dirname: path.dirname(mainPath), URL, Response, Buffer, setTimeout, clearTimeout,
    console: { error: (...args) => errors.push(args) },
    process: { argv: ['electron', '.', ...(options.args?.(data) || [])], env: {}, platform: 'darwin' },
  });
  vm.runInContext(source, context, { filename: mainPath });
  for (const filePath of options.pending?.(data) || []) app.emit('open-file', { preventDefault() {} }, filePath);
  releaseReady();
  for (let attempt = 0; attempt < 200 && !windows.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(windows.length, `Native app initialized: ${JSON.stringify(errors)}`);
  const sender = () => ({ sender: windows.at(-1).webContents, senderFrame: windows.at(-1).webContents.mainFrame });
  t.after(async () => {
    await vm.runInContext('stateWrite', context);
    app.emit('will-quit');
  });
  return {
    ...data, profile, app, windows, sent, dialogs,
    invoke: async (channel, ...args) => handlers.get(channel)(sender(), ...args),
    setDirty: value => ipcMain.emit('document:dirty', sender(), value),
    chooseClose: value => { closeResponse = value; },
    state: async () => JSON.parse(JSON.stringify(await handlers.get('files:initial-state')(sender()))),
  };
}

test('native restoration reloads all valid open tabs and preserves their selected tab', async t => {
  const native = await bootMain(t, { saved: data => ({
    filePaths: [data.documents[0], path.join(data.directory, 'deleted.md'), data.documents[1]], filePath: data.documents[0],
  }) });
  assert.deepEqual(await native.state(), { root: null, filePaths: native.documents, filePath: native.documents[0] });
  await native.invoke('files:read-file', native.documents[1]);
  assert.equal((await native.state()).filePath, native.documents[0], 'Background file reads do not select a tab');
  await native.invoke('files:sync-session', { paths: [native.documents[1]], activePath: native.documents[1] });
  const saved = JSON.parse(await fs.readFile(path.join(native.profile, 'last-session.json'), 'utf8'));
  assert.deepEqual(saved.filePaths, [native.documents[1]], 'Closed tabs are removed from the saved session');
});

test('native legacy session restoration keeps its file and explicit empty tabs keep every file closed', async t => {
  const legacy = await bootMain(t, { saved: data => ({ filePath: data.documents[0] }) });
  assert.deepEqual((await legacy.state()).filePaths, [legacy.documents[0]]);
  const closed = await bootMain(t, { saved: data => ({ filePaths: [], filePath: data.documents[0] }) });
  assert.deepEqual((await closed.state()).filePaths, []);
  assert.equal((await closed.state()).filePath, null);
});

test('multiple macOS startup open-file events and CLI file arguments all survive initialization', async t => {
  const native = await bootMain(t, {
    args: data => ['--file', data.documents[0]],
    pending: data => [data.documents[0], data.documents[1]],
  });
  assert.deepEqual((await native.state()).filePaths, native.documents);
  assert.equal((await native.state()).filePath, native.documents[1]);
});

test('native dirty-window close waits for explicit successful completion of every document save', async t => {
  const native = await bootMain(t);
  native.setDirty(true);
  native.chooseClose(0);
  native.windows[0].close();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(native.sent.at(-1), ['menu:action', 'save-all']);
  native.setDirty(false);
  assert.equal(native.windows[0].isDestroyed(), false, 'Clean notification alone must not close the window');
  native.windows[0].close();
  assert.equal(native.windows[0].isDestroyed(), false, 'Pending save-all still requires completion');
  await native.invoke('document:complete-window-close', false);
  assert.equal(native.windows[0].isDestroyed(), false, 'Failure keeps the window');
  await native.invoke('document:complete-window-close', true);
  assert.equal(native.windows[0].isDestroyed(), false, 'Ordinary save-all never closes a window');
  native.setDirty(true);
  native.windows[0].close();
  await new Promise(resolve => setImmediate(resolve));
  native.setDirty(false);
  await native.invoke('document:complete-window-close', true);
  assert.equal(native.windows[0].isDestroyed(), true);
});

test('native app quit resumes after choosing to discard unsaved changes', async t => {
  const native = await bootMain(t);
  native.setDirty(true);
  native.chooseClose(1);
  native.app.quit();
  assert.equal(native.app.quitCompleted, false, 'Initial quit is prevented while the dialog is pending');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(native.app.quitCompleted, true, 'Approval reissues app.quit instead of merely closing a macOS window');
  assert.equal(native.dialogs.length, 1);
  assert.equal(native.app.quitCalls, 2);
});

test('native app quit resumes only after all saves succeed and repeated quit does not duplicate the dialog', async t => {
  const native = await bootMain(t);
  native.setDirty(true);
  native.chooseClose(0);
  native.app.quit();
  native.app.quit();
  await new Promise(resolve => setImmediate(resolve));
  native.app.quit();
  assert.equal(native.dialogs.length, 1);
  assert.equal(native.app.quitCompleted, false);
  native.setDirty(false);
  assert.equal(native.app.quitCompleted, false);
  await native.invoke('document:complete-window-close', true);
  assert.equal(native.app.quitCompleted, true);
  assert.equal(native.dialogs.length, 1);
});

test('canceling quit or failing save clears quit intent so a later ordinary close keeps the app running', async t => {
  const canceled = await bootMain(t);
  canceled.setDirty(true);
  canceled.chooseClose(2);
  canceled.app.quit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canceled.app.quitCompleted, false);
  canceled.chooseClose(1);
  canceled.windows[0].close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(canceled.windows[0].isDestroyed(), true);
  assert.equal(canceled.app.quitCalls, 1, 'Canceling quit resets the intent before a later window close');
  assert.equal(canceled.app.quitCompleted, false);

  const failed = await bootMain(t);
  failed.setDirty(true);
  failed.chooseClose(0);
  failed.app.quit();
  await new Promise(resolve => setImmediate(resolve));
  await failed.invoke('document:complete-window-close', false);
  failed.chooseClose(1);
  failed.windows[0].close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.windows[0].isDestroyed(), true);
  assert.equal(failed.app.quitCalls, 1, 'A failed save clears the original quit intent');
  assert.equal(failed.app.quitCompleted, false);
});
