const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  chooseFolder: () => ipcRenderer.invoke('files:choose-folder'),
  chooseFile: () => ipcRenderer.invoke('files:choose-file'),
  chooseFiles: () => ipcRenderer.invoke('files:choose-files'),
  getDroppedPaths: files => [...new Set(Array.from(files, file => webUtils.getPathForFile(file)).filter(Boolean))],
  openPath: path => ipcRenderer.invoke('files:open-path', path),
  getInitialState: () => ipcRenderer.invoke('files:initial-state'),
  syncSession: selection => ipcRenderer.invoke('files:sync-session', selection),
  readDirectory: path => ipcRenderer.invoke('files:read-directory', path),
  readFile: path => ipcRenderer.invoke('files:read-file', path),
  saveFile: (path, content, version) => ipcRenderer.invoke('files:save-file', path, content, version),
  openDefault: path => ipcRenderer.invoke('files:open-default', path),
  revealFile: path => ipcRenderer.invoke('files:reveal', path),
  openExternal: url => ipcRenderer.invoke('links:open-external', url),
  copyText: text => ipcRenderer.invoke('clipboard:write-text', text),
  readClipboardText: () => {
    if (!document.activeElement?.closest('.cm-content[contenteditable="true"]')) {
      return Promise.reject(new Error('편집 영역을 선택해 주십시오.'));
    }
    return ipcRenderer.invoke('clipboard:read-text');
  },
  showEditorMenu: options => {
    if (!document.activeElement?.closest('.cm-content[contenteditable="true"]')) {
      return Promise.reject(new Error('편집 영역을 선택해 주십시오.'));
    }
    return ipcRenderer.invoke('editor:show-menu', options);
  },
  onEditorMenuAction: callback => subscribe('editor:menu-action', callback),
  setDirty: dirty => ipcRenderer.send('document:dirty', dirty === true),
  completeWindowClose: success => ipcRenderer.invoke('document:complete-window-close', success === true),
  onOpenFile: callback => subscribe('document:open', callback),
  onFolderChanged: callback => subscribe('files:changed', callback),
  onMenuAction: callback => subscribe('menu:action', callback),
}));
