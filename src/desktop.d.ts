export type Folder = { path: string; name: string };
export type Entry = { path: string; name: string; kind: 'directory' | 'markdown' | 'file' };
export type DocumentFile = { path: string; name: string; content: string; version: string; modifiedAt: number };
export interface DesktopAPI {
  chooseFolder(): Promise<Folder | null>;
  chooseFile(): Promise<string | null>;
  chooseFiles(): Promise<string[] | null>;
  syncSession(session: { paths: string[]; activePath: string | null }): Promise<void>;
  completeWindowClose(success: boolean): Promise<void>;
  getDroppedPaths(files: File[]): string[];
  openPath(path: string): Promise<{ kind: 'directory'; root: Folder } | { kind: 'markdown'; file: DocumentFile }>;
  getInitialState(): Promise<{ root: Folder | null; filePath: string | null; filePaths: string[] }>;
  readDirectory(path: string): Promise<Entry[]>;
  readFile(path: string): Promise<DocumentFile>;
  saveFile(path: string, content: string, expectedVersion: string): Promise<DocumentFile>;
  openDefault(path: string): Promise<void>;
  revealFile(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  readClipboardText(): Promise<string>;
  showEditorMenu(options: { requestId: string; canUndo: boolean; canRedo: boolean; hasSelection: boolean }): Promise<void>;
  onEditorMenuAction(callback: (event: { requestId: string; action: 'undo' | 'redo' | 'copy' | 'cut' | 'paste' | 'select-all' }) => void): () => void;
  setDirty(dirty: boolean): void;
  onOpenFile(callback: (path: string) => void): () => void;
  onFolderChanged(callback: () => void): () => void;
  onMenuAction(callback: (action: 'open-folder' | 'open-file' | 'save' | 'save-all' | 'edit' | 'close-tab' | 'next-tab' | 'previous-tab') => void): () => void;
}
declare global { interface Window { desktop: DesktopAPI } }
