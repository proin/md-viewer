const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { FileAccess, absolutePath, isMarkdown, canOpenDefault } = require('./files.cjs');
const { savedFilePaths, watchLocations, validateSession } = require('./session.cjs');
const { openDocument } = require('./open-default.cjs');
const APP_ID = 'net.seasonsoft.markdownviewer';

function argumentValue(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : null;
}

const isolatedProfile = process.env.MARKDOWN_VIEWER_USER_DATA || argumentValue('--user-data-dir');
if (isolatedProfile) app.setPath('userData', path.resolve(isolatedProfile));
app.setName('Markdown Viewer');
protocol.registerSchemesAsPrivileged([{ scheme: 'md-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const access = new FileAccess();
const state = { root: null, filePath: null, filePaths: [] };
let window = null;
let ready = false;
let pendingFiles = [];
let dirty = false;
let discardAndClose = false;
let saveAndClose = false;
let quitRequested = false;
let closeDialog = false;
let watchers = [];
let changeTimer;
let stateWrite = Promise.resolve();
let sessionUpdate = Promise.resolve();
const devURL = process.env.VITE_DEV_SERVER_URL || null;
const rendererURL = devURL || pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
if (devURL && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(devURL).hostname)) {
  throw new Error('개발 서버는 로컬 주소만 사용할 수 있습니다.');
}

function send(channel, payload) {
  if (window && !window.isDestroyed() && !window.webContents.isLoadingMainFrame()) window.webContents.send(channel, payload);
}

function finishApprovedClose() {
  saveAndClose = false;
  discardAndClose = true;
  if (quitRequested) app.quit();
  else if (window && !window.isDestroyed()) window.close();
}

function persistState() {
  const serialized = JSON.stringify(state);
  stateWrite = stateWrite.catch(() => {}).then(async () => {
    await fsp.mkdir(app.getPath('userData'), { recursive: true });
    const statePath = path.join(app.getPath('userData'), 'last-session.json');
    await fsp.writeFile(`${statePath}.tmp`, serialized, { mode: 0o600 });
    await fsp.rename(`${statePath}.tmp`, statePath);
  }).catch(error => console.error('최근 파일을 기록하지 못했습니다:', error.message));
  return stateWrite;
}

function updateWatchers() {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  for (const [location, recursive] of watchLocations(state)) {
    try {
      const watcher = fs.watch(location, { recursive }, (_event, filename) => {
        if (filename && String(filename).endsWith('.tmp')) return;
        clearTimeout(changeTimer);
        changeTimer = setTimeout(() => send('files:changed'), 180);
      });
      watcher.on('error', () => send('files:changed'));
      watchers.push(watcher);
    } catch {
      // A removed folder is reported by the next file operation.
    }
  }
}

async function acceptOpenFile(filePath, notify = true) {
  const { path: canonical } = await access.openFile(launchPath(filePath));
  if (!state.filePaths.includes(canonical)) state.filePaths.push(canonical);
  state.filePath = canonical;
  app.addRecentDocument(canonical);
  updateWatchers();
  persistState();
  if (notify) send('document:open', canonical);
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  return canonical;
}

function fileArguments(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === '--file') {
      if (argv[index + 1] && !argv[index + 1].startsWith('--')) files.push(argv[++index]);
      continue;
    }
    if (['--folder', '--user-data-dir'].includes(value)) { index++; continue; }
    if (value.startsWith('--')) continue;
    try { if (isMarkdown(absolutePath(value))) files.push(value); } catch {}
  }
  return [...new Set(files)];
}

function launchPath(value) {
  return /^file:/i.test(value) ? absolutePath(value) : path.resolve(value);
}

function recordOpenedPath(result) {
  if (result.kind === 'directory') {
    state.root = result.root;
  } else {
    if (!state.filePaths.includes(result.file.path)) state.filePaths.push(result.file.path);
    state.filePath = result.file.path;
    app.addRecentDocument(result.file.path);
  }
  updateWatchers();
  persistState();
  return result;
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (ready) {
    if (!window) createWindow();
    acceptOpenFile(filePath).catch(error => dialog.showErrorBox('파일을 열 수 없습니다', error.message));
  }
  else pendingFiles.push(filePath);
});

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const filePaths = fileArguments(argv);
    if (filePaths.length) {
      if (!ready) pendingFiles.push(...filePaths);
      else void (async () => {
        for (const filePath of filePaths) {
          try { await acceptOpenFile(filePath); }
          catch (error) { dialog.showErrorBox('파일을 열 수 없습니다', error.message); }
        }
      })();
    }
    else if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    protocol.handle('md-asset', async request => {
      try {
        const url = new URL(request.url);
        if (request.method !== 'GET' || url.hostname !== 'local' || url.pathname !== '/') return new Response(null, { status: 403 });
        const { bytes, mimeType } = await access.readImage(url.searchParams.get('path'));
        return new Response(bytes, { headers: {
          'Content-Type': mimeType,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        } });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    await restoreSession();
    installIPC();
    createWindow();
    installMenu();
    ready = true;
    for (const filePath of pendingFiles.splice(0)) {
      try { await acceptOpenFile(filePath); }
      catch (error) { dialog.showErrorBox('파일을 열 수 없습니다', error.message); }
    }
    app.on('activate', () => {
      if (!window) createWindow();
      else window.show();
    });
  }).catch(error => {
    dialog.showErrorBox('앱을 시작할 수 없습니다', error.message);
    app.quit();
  });
}

async function restoreSession() {
  let saved = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'last-session.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') saved = parsed;
  } catch {}
  const requestedRoot = argumentValue('--folder');
  const requestedFiles = [...new Set([...fileArguments(process.argv), ...pendingFiles.splice(0)])];
  const rootPath = requestedRoot || (!requestedFiles.length && saved.root?.path);
  if (rootPath) {
    try {
      const result = await access.openPath(launchPath(rootPath));
      if (result.kind === 'directory') state.root = result.root;
    } catch {}
  }
  const filePaths = requestedFiles.length ? requestedFiles : (!requestedRoot ? savedFilePaths(saved) : []);
  for (const filePath of filePaths) {
    try { await acceptOpenFile(filePath, false); } catch {}
  }
  if (!requestedFiles.length && !requestedRoot && saved.filePath) {
    try {
      const active = await access.resolveAuthorized(saved.filePath);
      if (state.filePaths.includes(active)) state.filePath = active;
    } catch {}
  }
  updateWatchers();
  await persistState();
}

function assertSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('요청을 처리할 수 없습니다.');
  const incoming = new URL(event.senderFrame.url);
  const allowed = new URL(rendererURL);
  if (devURL ? incoming.origin !== allowed.origin : incoming.href.split('#')[0] !== allowed.href) throw new Error('요청을 처리할 수 없습니다.');
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event);
    return callback(...args);
  });
}

function installIPC() {
  handle('files:initial-state', () => state);
  handle('files:sync-session', selection => {
    const operation = sessionUpdate.catch(() => {}).then(async () => {
      const next = await validateSession(access, state.filePaths, selection);
      const pathsChanged = next.filePaths.length !== state.filePaths.length || next.filePaths.some((value, index) => value !== state.filePaths[index]);
      const activeChanged = next.filePath !== state.filePath;
      Object.assign(state, next);
      if (pathsChanged) updateWatchers();
      if (pathsChanged || activeChanged) await persistState();
    });
    sessionUpdate = operation;
    return operation;
  });
  handle('files:choose-folder', async () => {
    const result = await dialog.showOpenDialog(window, { title: '폴더 열기', buttonLabel: '폴더 열기', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const opened = await access.openPath(result.filePaths[0]);
    if (opened.kind !== 'directory') throw new Error('폴더를 선택해 주십시오.');
    return recordOpenedPath(opened).root;
  });
  handle('files:open-path', async value => recordOpenedPath(await access.openPath(value)));
  handle('files:choose-file', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '마크다운 파일 열기', buttonLabel: '파일 열기', properties: ['openFile'],
      filters: [{ name: '마크다운 파일', extensions: ['md', 'markdown', 'mdown', 'mkd'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return acceptOpenFile(result.filePaths[0], false);
  });
  handle('files:choose-files', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: '마크다운 파일 열기', buttonLabel: '파일 열기', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '마크다운 파일', extensions: ['md', 'markdown', 'mdown', 'mkd'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const documents = await access.openFiles(result.filePaths);
    for (const document of documents) app.addRecentDocument(document.path);
    return documents.map(document => document.path);
  });
  handle('files:read-directory', value => access.readDirectory(value));
  handle('files:read-file', value => access.readFile(value));
  handle('files:save-file', async (value, content, version) => {
    try {
      return await access.saveFile(value, content, version);
    } catch (error) {
      saveAndClose = false;
      quitRequested = false;
      throw error;
    }
  });
  handle('files:open-default', async value => {
    const canonical = await access.resolveAuthorized(value);
    if (!canOpenDefault(canonical)) throw new Error('이 형식의 파일은 Finder에서 열어 주십시오.');
    if (!(await fsp.stat(canonical)).isFile()) throw new Error('파일을 선택해 주십시오.');
    await openDocument(canonical, { shell, dialog, window, appId: APP_ID });
  });
  handle('files:reveal', async value => shell.showItemInFolder(await access.resolveAuthorized(value)));
  handle('links:open-external', async value => {
    if (typeof value !== 'string') throw new Error('링크 주소가 올바르지 않습니다.');
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new Error('이 링크는 열 수 없습니다.');
    await shell.openExternal(url.href);
  });
  handle('clipboard:write-text', async value => {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 20 * 1024 * 1024) throw new Error('복사할 내용은 20MB 이하여야 합니다.');
    await clipboard.writeText(value);
  });
  handle('clipboard:read-text', async () => {
    if (!window.isFocused() || !window.webContents.isFocused()) throw new Error('편집 영역을 선택해 주십시오.');
    const text = await clipboard.readText();
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 20 * 1024 * 1024) throw new Error('붙여넣을 내용은 20MB 이하여야 합니다.');
    return text;
  });
  handle('editor:show-menu', options => {
    if (!options || typeof options.requestId !== 'string' || options.requestId.length === 0 || options.requestId.length > 200 ||
      options.requestId.includes('\0') || !['canUndo', 'canRedo', 'hasSelection'].every(key => typeof options[key] === 'boolean')) {
      throw new Error('편집 메뉴를 열 수 없습니다.');
    }
    if (!window.isFocused() || !window.webContents.isFocused()) throw new Error('편집 영역을 선택해 주십시오.');
    const item = (action, label, enabled = true) => ({
      label, enabled, click: () => send('editor:menu-action', { requestId: options.requestId, action }),
    });
    Menu.buildFromTemplate([
      item('undo', '실행 취소', options.canUndo), item('redo', '다시 실행', options.canRedo),
      { type: 'separator' },
      item('cut', '잘라내기', options.hasSelection), item('copy', '복사', options.hasSelection), item('paste', '붙여넣기'),
      { type: 'separator' }, item('select-all', '전체 선택'),
    ]).popup({ window });
  });
  handle('document:complete-window-close', success => {
    if (!saveAndClose) return;
    saveAndClose = false;
    if (success === true && !dirty && window && !window.isDestroyed()) {
      finishApprovedClose();
    } else quitRequested = false;
  });
  ipcMain.on('document:dirty', (event, value) => {
    try { assertSender(event); } catch { return; }
    dirty = value === true;
    window.setDocumentEdited(dirty);
  });
}

function createWindow() {
  dirty = false;
  discardAndClose = false;
  saveAndClose = false;
  quitRequested = false;
  window = new BrowserWindow({
    width: 1380, height: 900, minWidth: 940, minHeight: 600,
    title: 'Markdown Viewer', backgroundColor: '#f7f7f8', show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 20 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('context-menu', (event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const flags = params.editFlags;
    const items = params.isEditable ? [
      { role: 'undo', label: '실행 취소', enabled: flags.canUndo },
      { role: 'redo', label: '다시 실행', enabled: flags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '잘라내기', enabled: flags.canCut },
      { role: 'copy', label: '복사', enabled: flags.canCopy },
      { role: 'paste', label: '붙여넣기', enabled: flags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: '전체 선택', enabled: flags.canSelectAll },
    ] : [{ role: 'copy', label: '복사', enabled: flags.canCopy }];
    event.preventDefault();
    Menu.buildFromTemplate(items).popup({ window });
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.once('ready-to-show', () => window.show());
  window.webContents.on('did-finish-load', () => { if (state.filePath) send('document:open', state.filePath); });
  window.on('close', async event => {
    if (discardAndClose) return;
    if (saveAndClose) { event.preventDefault(); return; }
    if (!dirty) return;
    event.preventDefault();
    if (closeDialog) return;
    closeDialog = true;
    try {
      const result = await dialog.showMessageBox(window, {
        type: 'question', title: '변경 내용 저장', message: '변경 내용을 저장하시겠습니까?',
        detail: '열린 모든 파일의 변경 내용을 저장합니다. 저장하지 않은 내용은 삭제됩니다.',
        buttons: ['저장하고 종료', '저장하지 않고 종료', '취소'], defaultId: 0, cancelId: 2, noLink: true,
      });
      if (result.response === 0) {
        saveAndClose = true;
        send('menu:action', 'save-all');
      } else if (result.response === 1) {
        finishApprovedClose();
      } else quitRequested = false;
    } finally {
      closeDialog = false;
    }
  });
  window.on('closed', () => { window = null; });
  window.loadURL(rendererURL);
}

function installMenu() {
  const menuAction = action => () => send('menu:action', action);
  const template = [
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [
      { role: 'about', label: 'Markdown Viewer 정보' }, { type: 'separator' },
      { role: 'hide', label: 'Markdown Viewer 가리기' }, { role: 'hideOthers', label: '다른 앱 가리기' },
      { role: 'unhide', label: '모두 표시' }, { type: 'separator' }, { role: 'quit', label: 'Markdown Viewer 종료' },
    ] }] : []),
    { label: '파일', submenu: [
      { label: '폴더 열기…', accelerator: 'CmdOrCtrl+Shift+O', click: menuAction('open-folder') },
      { label: '파일 열기…', accelerator: 'CmdOrCtrl+O', click: menuAction('open-file') },
      { type: 'separator' }, { label: '저장', accelerator: 'CmdOrCtrl+S', click: menuAction('save') },
      { label: '모두 저장', accelerator: 'CmdOrCtrl+Shift+S', click: menuAction('save-all') },
      { type: 'separator' }, { label: '파일 닫기', accelerator: 'CmdOrCtrl+W', click: menuAction('close-tab') },
      { role: 'close', label: '창 닫기', accelerator: 'CmdOrCtrl+Shift+W' },
    ] },
    { label: '편집', submenu: [
      { label: '편집 모드 전환', accelerator: 'CmdOrCtrl+E', click: menuAction('edit') },
      { type: 'separator' }, { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' },
      { type: 'separator' }, { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' },
      { role: 'paste', label: '붙여넣기' }, { role: 'selectAll', label: '전체 선택' },
    ] },
    { label: '보기', submenu: [
      { label: '다음 탭', accelerator: 'Ctrl+Tab', click: menuAction('next-tab') },
      { label: '이전 탭', accelerator: 'Ctrl+Shift+Tab', click: menuAction('previous-tab') },
      { type: 'separator' },
      { role: 'resetZoom', label: '원래 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
      { type: 'separator' }, { role: 'togglefullscreen', label: '전체 화면' },
      ...(!app.isPackaged ? [{ type: 'separator' }, { role: 'toggleDevTools', label: '개발자 도구' }] : []),
    ] },
    { label: '윈도우', submenu: [{ role: 'minimize', label: '최소화' }, { role: 'zoom', label: '확대/축소' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('before-quit', () => { quitRequested = true; });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => {
  clearTimeout(changeTimer);
  for (const watcher of watchers) watcher.close();
});
