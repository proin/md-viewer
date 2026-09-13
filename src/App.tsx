import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { BookOpen, Check, ChevronDown, ChevronRight, ChevronsLeft, Circle, ExternalLink, File, FileCode2, FileText, Folder as FolderIcon, FolderOpen, List, LoaderCircle, PanelLeftClose, Pencil, Plus, RefreshCw, Save, Search, X, ArrowUpRight, Braces, AlertCircle } from 'lucide-react';
import type { Entry, Folder } from './desktop';
import MarkdownPreview from './MarkdownPreview';
import Editor from './Editor';
import { useDocuments, tabIsDirty, tabNeedsAttention } from './useDocuments';

type Heading = { id: string; text: string; level: number };
type Pending = { path: string; name: string; action: 'close' | 'reload' | 'external'; resolve: (value: boolean) => void };
const api = window.desktop;
const isMarkdown = (path: string) => /\.(md|markdown|mdown|mkd)$/i.test(path);
const errorText = (error: unknown, path?: string, kind = '파일') => {
  const message = error instanceof Error ? error.message : String(error);
  if (/FILE_CHANGED/.test(message)) return '다른 앱에서 파일이 변경되었습니다. 편집 내용을 복사한 뒤 파일을 다시 열어 변경 내용을 확인하십시오.';
  if (/ENOENT/.test(message)) return `${kind === '폴더' ? '폴더가' : '파일이'} 이동되었거나 삭제되었습니다.${path ? ` ${path}` : ''} 파일 또는 폴더를 다시 선택하십시오.`;
  if (/EACCES|EPERM/.test(message)) return '파일에 접근할 수 없습니다. 폴더의 읽기·쓰기 권한을 확인하십시오.';
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^[A-Z_]+:\s*/, '');
};

export default function App() {
  const [root, setRoot] = useState<Folder | null>(null);
  const [cache, setCache] = useState<Record<string, Entry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [globalError, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entry[]>([]);
  const [searching, setSearching] = useState(false);
  const [outline, setOutline] = useState(true);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [sidebar, setSidebar] = useState(true);
  const [dropActive, setDropActive] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const dragDepth = useRef(0);
  const dropBusy = useRef(false);
  const opening = useRef(0);
  const readingRef = useRef<HTMLDivElement>(null);
  const scrollRestore = useRef<{ key: string; cancel: () => void } | null>(null);
  const { tabs, activeId, active, tabsRef, activeRef, scrolls, activate, patch, add, remove, replace, refresh, save: saveDocument, saveAll: saveDocuments } = useDocuments(api, errorText);
  const doc = active?.file ?? null;
  const draft = active?.draft ?? '';
  const editing = active?.editing ?? false;
  const editorEpoch = active?.epoch ?? 0;
  const saving = active?.saving ?? false;
  const externalChanged = active?.externalChanged ?? false;
  const error = globalError || active?.error || '';
  const dirty = active ? tabIsDirty(active) : false;
  const deferredActive = useDeferredValue(active);
  const deferredDraft = deferredActive?.file.path === active?.file.path ? deferredActive?.draft ?? '' : draft;
  const latest = useRef({ root, expanded });
  latest.current = { root, expanded };
  const pathsKey = JSON.stringify(tabs.map(tab => tab.file.path));

  const selectTab = useCallback((path: string) => { activate(path); setError(''); }, [activate]);
  const setEditing = useCallback((value: boolean | ((previous: boolean) => boolean)) => {
    const path = activeRef.current;
    if (path) patch(path, tab => ({ ...tab, editing: typeof value === 'function' ? value(tab.editing) : value }));
  }, [activeRef, patch]);
  const setDraft = (value: string) => { if (activeId) patch(activeId, tab => ({ ...tab, draft: value })); };
  const dismissError = () => {
    setError('');
    if (activeId) patch(activeId, tab => ({ ...tab, externalChanged: false, error: '' }));
  };

  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => {
    if (!sessionReady) return;
    void api.syncSession({ paths: JSON.parse(pathsKey), activePath: activeId }).catch(e => setError(errorText(e)));
  }, [sessionReady, pathsKey, activeId]);
  useLayoutEffect(() => {
    const currentTab = document.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    currentTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const element = readingRef.current;
    if (!activeId || !element) return;
    const key = `${activeId}:${editing ? 'edit' : 'read'}`;
    const target = scrolls.current.get(key) ?? 0;
    let restoring = true;
    const cancel = () => { restoring = false; if (scrollRestore.current?.key === key) scrollRestore.current = null; };
    const apply = () => { if (restoring) element.scrollTop = target; };
    scrollRestore.current = { key, cancel };
    const observer = new ResizeObserver(apply);
    observer.observe(element);
    const article = element.querySelector('.markdown-preview');
    if (article) observer.observe(article);
    for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown']) element.addEventListener(event, cancel, { passive: true });
    apply();
    const frame = requestAnimationFrame(apply);
    return () => {
      cancel(); observer.disconnect(); cancelAnimationFrame(frame);
      for (const event of ['wheel', 'pointerdown', 'touchstart', 'keydown']) element.removeEventListener(event, cancel);
    };
  }, [activeId, editing, scrolls]);

  const finishPending = useCallback((approved: boolean) => {
    const request = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    request?.resolve(approved);
  }, []);
  const confirmDocument = useCallback((path: string, action: Pending['action']): Promise<boolean> => {
    const tab = tabsRef.current.find(tab => tab.file.path === path);
    if (!tab || !tabNeedsAttention(tab)) return Promise.resolve(true);
    if (pendingRef.current) return Promise.resolve(false);
    return new Promise(resolve => {
      const request = { path, name: tab.file.name, action, resolve };
      pendingRef.current = request;
      setPending(request);
    });
  }, [tabsRef]);
  useEffect(() => {
    if (!pending) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector('.confirm-dialog');
    const buttons = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    buttons[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); finishPending(false); }
      if (event.key === 'Tab') {
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [pending, finishPending]);

  const save = useCallback(async () => {
    const path = activeRef.current;
    if (!path) return false;
    setError('');
    const success = await saveDocument(path);
    if (success) setNotice('저장되었습니다');
    return success;
  }, [activeRef, saveDocument]);
  const saveAll = useCallback(async () => {
    setError('');
    const success = await saveDocuments();
    api.setDirty(tabsRef.current.some(tabNeedsAttention));
    await api.completeWindowClose(success);
    if (success) setNotice('모든 변경 내용을 저장했습니다');
  }, [saveDocuments, tabsRef]);
  const closeTab = useCallback(async (path: string) => {
    if (await confirmDocument(path, 'close')) { remove(path); setError(''); }
  }, [confirmDocument, remove]);
  const stepTab = useCallback((direction: number) => {
    const index = tabsRef.current.findIndex(tab => tab.file.path === activeRef.current);
    const count = tabsRef.current.length;
    if (count) selectTab(tabsRef.current[(index + direction + count) % count].file.path);
  }, [tabsRef, activeRef, selectTab]);
  const loadFile = useCallback(async (path: string, select = true) => {
    if (tabsRef.current.some(tab => tab.file.path === path)) { if (select) selectTab(path); return; }
    opening.current += 1; setLoading(true); setError('');
    try { add(await api.readFile(path), select); }
    catch (e) { setError(errorText(e, path)); }
    finally { opening.current -= 1; if (!opening.current) setLoading(false); }
  }, [tabsRef, selectTab, add]);
  const reloadFile = useCallback(async (path: string) => {
    if (!(await confirmDocument(path, 'reload'))) return;
    const before = tabsRef.current.find(tab => tab.file.path === path);
    if (!before) return;
    try {
      const file = await api.readFile(path);
      const current = tabsRef.current.find(tab => tab.file.path === path);
      if (!current || current.file !== before.file || current.epoch !== before.epoch || current.draft !== before.draft || current.saving) {
        setNotice('편집 내용이 변경되어 다시 열기를 중단했습니다');
        return;
      }
      replace(file); setError('');
    }
    catch (e) { setError(errorText(e, path)); }
  }, [confirmDocument, replace, tabsRef]);
  const loadDirectory = useCallback(async (path: string) => {
    const entries = await api.readDirectory(path);
    setCache(old => ({ ...old, [path]: entries }));
    return entries;
  }, []);
  const showFolder = useCallback(async (folder: Folder) => {
    const entries = await api.readDirectory(folder.path);
    setRoot(folder); setCache({ [folder.path]: entries }); setExpanded(new Set()); setQuery(''); setError('');
  }, []);
  const openFolder = useCallback(async () => {
    try { const folder = await api.chooseFolder(); if (folder) await showFolder(folder); }
    catch (e) { setError(errorText(e)); }
  }, [showFolder]);
  const openFile = useCallback(async () => {
    try { const paths = await api.chooseFiles(); for (const path of paths ?? []) await loadFile(path); }
    catch (e) { setError(errorText(e)); }
  }, [loadFile]);
  const dropPaths = useCallback(async (paths: string[]) => {
    if (dropBusy.current) return;
    dropBusy.current = true;
    setLoading(true); setError('');
    const failures: string[] = [];
    try {
      for (const path of paths) {
        try {
          const target = await api.openPath(path);
          if (target.kind === 'directory') await showFolder(target.root);
          else add(target.file);
        } catch (e) { failures.push(errorText(e, path)); }
      }
      setQuery('');
      if (failures.length) setError(failures.join('\n'));
    } finally { dropBusy.current = false; setLoading(false); }
  }, [showFolder, add]);

  const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const handleDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    dragDepth.current += 1; setDropActive(true);
  };
  const handleDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true);
  };
  const handleDragLeave = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDropActive(false);
  };
  const handleDrop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); event.stopPropagation();
    dragDepth.current = 0; setDropActive(false);
    try {
      const paths = api.getDroppedPaths(Array.from(event.dataTransfer.files));
      if (!paths.length) { setError('파일 경로를 가져올 수 없습니다. Finder에서 파일을 놓거나 파일 열기를 사용하십시오.'); return; }
      void dropPaths(paths);
    } catch (e) { setError(errorText(e)); }
  };

  useEffect(() => {
    if (!api) { setError('데스크톱 앱에서 실행하십시오. 개발 실행 명령: npm start'); return; }
    let disposed = false;
    api.getInitialState().then(async initial => {
      if (initial.root) {
        try { await showFolder(initial.root); }
        catch (e) { setError(errorText(e, initial.root.path, '폴더')); }
      }
      const paths = initial.filePaths ?? (initial.filePath ? [initial.filePath] : []);
      for (const path of paths) { if (disposed) return; await loadFile(path, false); }
      if (!disposed) {
        const selected = tabsRef.current.find(tab => tab.file.path === initial.filePath) ?? tabsRef.current[0];
        if (selected) activate(selected.file.path);
        setSessionReady(true);
      }
    }).catch(e => { setError(errorText(e)); setSessionReady(true); });
    const unsubscribeOpen = api.onOpenFile(path => { void loadFile(path); });
    const unsubscribeMenu = api.onMenuAction(action => {
      if (action === 'open-folder') void openFolder();
      if (action === 'open-file') void openFile();
      if (action === 'save') void save();
      if (action === 'save-all') void saveAll();
      if (action === 'close-tab' && activeRef.current) void closeTab(activeRef.current);
      if (action === 'next-tab') stepTab(1);
      if (action === 'previous-tab') stepTab(-1);
      if (action === 'edit' && activeRef.current) setEditing(value => !value);
    });
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribeFolder = api.onFolderChanged(() => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const state = latest.current;
        if (state.root) {
          const updated = await Promise.allSettled([state.root.path, ...state.expanded].map(loadDirectory));
          if (updated[0]?.status === 'rejected' && /ENOENT/.test(String(updated[0].reason)) && latest.current.root?.path === state.root.path) {
            setRoot(null); setCache({}); setExpanded(new Set()); setError(errorText(updated[0].reason, state.root.path, '폴더'));
          }
        }
        await Promise.allSettled(tabsRef.current.map(tab => refresh(tab.file.path)));
      }, 250);
    });
    return () => { disposed = true; clearTimeout(timer); unsubscribeOpen(); unsubscribeMenu(); unsubscribeFolder(); };
  }, [showFolder, loadFile, openFile, openFolder, save, saveAll, loadDirectory, tabsRef, activeRef, activate, closeTab, stepTab, setEditing, refresh]);

  useEffect(() => {
    if (!query.trim() || !root) { setResults([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const found: Entry[] = [];
      const queue = [root.path];
      const term = query.trim().toLocaleLowerCase();
      try {
        while (queue.length && !cancelled) {
          const path = queue.shift()!;
          const entries = await api.readDirectory(path);
          for (const entry of entries) {
            if (entry.kind === 'directory') queue.push(entry.path);
            else if (entry.name.toLocaleLowerCase().includes(term)) found.push(entry);
          }
        }
        if (!cancelled) setResults(found);
      } catch (e) { if (!cancelled) setError(errorText(e)); }
      finally { if (!cancelled) setSearching(false); }
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, root]);

  const toggleDirectory = async (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else { next.add(path); try { await loadDirectory(path); } catch (e) { setError(errorText(e)); } }
    setExpanded(next);
  };

  const openDefault = async (path: string) => {
    if (!(await confirmDocument(path, 'external'))) return;
    try { await api.openDefault(path); }
    catch (e) { setError(errorText(e)); }
  };

  const jumpToHeading = (id: string) => {
    scrollRestore.current?.cancel();
    const preview = document.querySelector('[data-testid="markdown-preview"]');
    const target = preview?.querySelector(`[id="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const navigate = async (href: string) => {
    if (href.startsWith('#')) { try { jumpToHeading(decodeURIComponent(href.slice(1))); } catch { jumpToHeading(href.slice(1)); } return; }
    if (/^https?:|^mailto:/i.test(href)) { try { await api.openExternal(href); } catch (e) { setError(errorText(e)); } return; }
    if (!doc) return;
    try {
      const fileUrl = new URL(href, `file://${doc.path.split('/').map(encodeURIComponent).join('/')}`);
      if (fileUrl.protocol !== 'file:') return;
      const path = decodeURIComponent(fileUrl.pathname);
      if (isMarkdown(path)) await loadFile(path);
      else await openDefault(path);
    } catch (e) { setError(errorText(e)); }
  };

  const treeEntry = (entry: Entry, depth = 0) => {
    const folder = entry.kind === 'directory';
    const active = entry.path === doc?.path;
    return <div key={entry.path}>
      <button data-testid="tree-item" data-path={entry.path} className={`tree-item ${active ? 'selected' : ''} ${entry.kind === 'file' ? 'other-file' : ''}`} style={{ paddingLeft: 14 + depth * 16 }} title={entry.path} aria-expanded={folder ? expanded.has(entry.path) : undefined}
        onClick={() => folder ? void toggleDirectory(entry.path) : entry.kind === 'markdown' ? void loadFile(entry.path) : void openDefault(entry.path)}>
        {folder ? (expanded.has(entry.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="tree-indent" />}
        {folder ? (expanded.has(entry.path) ? <FolderOpen size={16} /> : <FolderIcon size={16} />) : entry.kind === 'markdown' ? <FileText size={15} /> : <File size={15} />}
        <span>{entry.name}</span>{tabs.some(tab => tab.file.path === entry.path && tabIsDirty(tab)) && <Circle className="dirty-dot" size={6} fill="currentColor" />}
      </button>
      {folder && expanded.has(entry.path) && <div>{cache[entry.path]?.map(item => treeEntry(item, depth + 1))}{cache[entry.path]?.length === 0 && <div className="tree-empty" style={{ paddingLeft: 45 + depth * 16 }}>빈 폴더</div>}</div>}
    </div>;
  };

  const savePending = async () => {
    const request = pendingRef.current;
    if (!request) return;
    const success = await saveDocument(request.path);
    if (pendingRef.current !== request) return;
    if (!success) selectTab(request.path);
    finishPending(success);
  };
  const pendingBusy = !!pending && !!tabs.find(tab => tab.file.path === pending.path)?.saving;
  const actionLabel = pending?.action === 'close' ? '닫기' : pending?.action === 'reload' ? '다시 열기' : '열기';
  const relative = doc && root && doc.path.startsWith(root.path + '/') ? doc.path.slice(root.path.length + 1) : doc?.name;

  const standaloneTabs = tabs.filter(tab => !root || !tab.file.path.startsWith(root.path + '/'));

  return <div className={`application ${sidebar ? '' : 'sidebar-hidden'}`} onDragEnterCapture={handleDragEnter} onDragOverCapture={handleDragOver} onDragLeaveCapture={handleDragLeave} onDropCapture={handleDrop} onDragEnd={() => { dragDepth.current = 0; setDropActive(false); }}>
    <header className="titlebar">
      <div className="traffic-space" />
      <div className="brand-mark"><BookOpen size={18} strokeWidth={1.7} /></div><span className="brand-name">Markdown Viewer</span>
      <div className="titlebar-center">{root?.name || '문서 공간'}</div>
      <div className="titlebar-right"><span className="local-dot" />로컬 파일</div>
    </header>

    {sidebar && <aside className="sidebar">
      <div className="sidebar-heading"><span>파일 탐색</span><div className="row-actions"><button title="폴더 열기 (⌘⇧O)" aria-label="폴더 열기" onClick={() => void openFolder()}><Plus size={17} /></button><button title="파일 트리 새로고침" aria-label="파일 트리 새로고침" disabled={!root} onClick={() => root && void Promise.allSettled([root.path, ...expanded].map(loadDirectory))}><RefreshCw size={14} /></button></div></div>
      <div className="search-box"><Search size={14} /><input data-testid="file-filter" placeholder="파일 이름 검색" aria-label="파일 이름 검색" value={query} disabled={!root} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="검색 지우기" onClick={() => setQuery('')}><X size={12} /></button>}<span className="search-key">⌕</span></div>
      {standaloneTabs.length > 0 && <div className="standalone-file"><div className="folder-heading"><FileText size={14} /><span>열린 파일</span></div>{standaloneTabs.map(tab => treeEntry({ path: tab.file.path, name: tab.file.name, kind: 'markdown' }))}</div>}
      {root ? <>
        <div className="folder-heading" title={root.path}><FolderOpen size={15} /><span>{root.name}</span><button aria-label="폴더 모두 접기" title="폴더 모두 접기" onClick={() => setExpanded(new Set())}><ChevronsLeft size={14} /></button></div>
        <nav className="file-tree" aria-label="폴더 파일 트리">{query.trim() ? <>{searching ? <div className="tree-message"><LoaderCircle className="spin" size={15} />파일 검색 중</div> : results.length ? results.map(entry => treeEntry(entry)) : <div className="tree-message">검색 결과가 없습니다</div>}</> : cache[root.path]?.length ? cache[root.path].map(entry => treeEntry(entry)) : <div className="tree-message">폴더에 파일이 없습니다</div>}</nav>
      </> : <div className="sidebar-empty"><FolderIcon size={28} strokeWidth={1.2} /><p>{doc ? '폴더를 열면 파일 트리가 표시됩니다' : '파일 또는 폴더를 열 수 있습니다'}</p><button onClick={() => void openFolder()}>폴더 열기 <ArrowUpRight size={12} /></button></div>}
      <div className="sidebar-bottom"><button onClick={() => void openFile()}><FileText size={15} /><span>파일 열기</span><kbd>⌘O</kbd></button><div className="sidebar-footnote"><span className="local-dot" />파일은 이 Mac에 저장됩니다</div></div>
    </aside>}

    <main className="main-area">
      {tabs.length > 0 && <div className="document-tabs" data-testid="document-tabs" role="tablist" aria-label="열린 문서">
        {tabs.map((tab, index) => {
          const selected = tab.file.path === activeId;
          const duplicateName = tabs.some(other => other.file.path !== tab.file.path && other.file.name === tab.file.name);
          const parent = tab.file.path.split('/').at(-2);
          return <div className={`document-tab ${selected ? 'active' : ''}`} key={tab.file.path} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void closeTab(tab.file.path); } }}>
            <button id={`document-tab-${index}`} role="tab" aria-selected={selected} aria-controls="document-panel" tabIndex={selected ? 0 : -1} data-testid="document-tab" data-path={tab.file.path} className="tab-select" title={tab.file.path} onClick={() => selectTab(tab.file.path)} onKeyDown={event => {
              let target: number | null = null;
              if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
              if (event.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length;
              if (event.key === 'Home') target = 0;
              if (event.key === 'End') target = tabs.length - 1;
              if (target !== null) { event.preventDefault(); selectTab(tabs[target].file.path); document.getElementById(`document-tab-${target}`)?.focus(); }
            }}><FileText size={13} /><span className="tab-name">{tab.file.name}{duplicateName && <small>{parent}</small>}</span>{tabIsDirty(tab) && <span className="tab-dirty" aria-label="저장하지 않은 변경 내용" />}{tab.externalChanged && <AlertCircle size={12} className="tab-warning" />}</button>
            <button data-testid="tab-close" data-path={tab.file.path} className="tab-close" aria-label={`${tab.file.name} 닫기`} title="파일 닫기 (⌘W)" onClick={() => void closeTab(tab.file.path)}><X size={13} /></button>
          </div>;
        })}
      </div>}
      <div className="document-toolbar">
        <button className="icon-button sidebar-toggle" title={sidebar ? '사이드바 접기' : '사이드바 펼치기'} aria-label="사이드바 표시 전환" onClick={() => setSidebar(value => !value)}><PanelLeftClose size={17} /></button>
        <div className="open-actions"><button data-testid="file-open" className="button" onClick={() => void openFile()} title="마크다운 파일 열기 (⌘O)"><FileText size={14} /><span>파일 열기</span></button><button data-testid="folder-open" className="button" onClick={() => void openFolder()} title="폴더 열기 (⌘⇧O)"><FolderOpen size={14} /><span>폴더 열기</span></button></div>
        <div className="breadcrumb">{doc ? <><strong data-testid="document-title" title={doc.path}>{relative}</strong>{dirty && <span className="unsaved-indicator" title="저장하지 않은 변경 내용" />}</> : <span>시작하기</span>}</div>
        {doc && <div className="document-actions">
          <button data-testid="external-open" className="button external-button" onClick={() => void openDefault(doc.path)} title="macOS에 지정된 기본 앱으로 열기"><ExternalLink size={14} /><span>기본 앱으로 열기</span></button>
          <div className="toolbar-divider" />
          <button data-testid={editing ? 'preview-button' : 'edit-button'} className={`button ${editing ? 'active-button' : ''}`} onClick={() => setEditing(value => !value)}>{editing ? <BookOpen size={14} /> : <Pencil size={14} />}<span>{editing ? '미리보기' : '편집하기'}</span></button>
          <button data-testid="save-button" className="button save-button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}<span>저장</span><kbd>⌘S</kbd></button>
          <button data-testid="outline-toggle" className={`icon-button ${outline ? 'is-on' : ''}`} title="목차 표시 전환" aria-label="목차 표시 전환" aria-pressed={outline} onClick={() => setOutline(value => !value)}><List size={18} /></button>
        </div>}
      </div>

      {(error || externalChanged) && <div className="error-banner" role="alert"><AlertCircle size={16} /><span>{error || '다른 앱에서 파일이 변경되었습니다. 저장 전에 변경 내용을 확인하십시오.'}</span>{externalChanged && <button onClick={() => doc && void reloadFile(doc.path)}>다시 열기</button>}<button aria-label="알림 닫기" onClick={dismissError}><X size={15} /></button></div>}

      {doc ? <div id="document-panel" role="tabpanel" aria-labelledby={`document-tab-${tabs.findIndex(tab => tab.file.path === activeId)}`} className={`document-workspace ${editing ? 'editing' : ''}`}>
        {editing && <section className="editor-pane"><div className="pane-label"><FileCode2 size={13} /><span>마크다운 편집</span><span className="pane-hint">⌘F 검색</span></div><Editor key={doc.path + ':' + editorEpoch} documentId={doc.path} resetKey={editorEpoch} initialValue={draft} onChange={setDraft} onSave={() => void save()} /></section>}
        <section className="preview-pane">
          {editing && <div className="pane-label"><BookOpen size={13} /><span>미리보기</span><span className="pane-hint">실시간 반영</span></div>}
          <div ref={readingRef} className="reading-surface" onScroll={event => { const key = `${doc.path}:${editing ? 'edit' : 'read'}`; if (scrollRestore.current?.key !== key) scrolls.current.set(key, event.currentTarget.scrollTop); }}><div className="page-topline"><FileText size={12} /><span>MARKDOWN</span>{!editing && <span className="reading-tag">읽기 모드</span>}</div><MarkdownPreview key={doc.path} content={deferredDraft} filePath={doc.path} onNavigate={href => void navigate(href)} onHeadings={setHeadings} /></div>
        </section>
        {outline && !editing && <aside className="outline"><div className="outline-title"><List size={13} />문서 목차</div>{headings.length ? headings.map(heading => <button key={heading.id} style={{ paddingLeft: 12 + Math.min(heading.level - 1, 3) * 9 }} onClick={() => jumpToHeading(heading.id)} title={heading.text}>{heading.text}</button>) : <p>제목이 없는 문서입니다</p>}</aside>}
      </div> : <div className="welcome">
        <div className="welcome-content"><div className="welcome-eyebrow"><span />YOUR DOCUMENTS, IN FOCUS</div><div className="welcome-symbol"><BookOpen size={40} strokeWidth={1.25} /><span className="symbol-plus">md</span></div><h1>문서를 읽고,<br /><span>생각을 기록하는 공간.</span></h1><p>마크다운 파일을 직접 열거나 폴더에서 선택할 수 있습니다.<br />파일 또는 폴더를 이 창에 끌어 놓아도 열립니다.</p><div className="welcome-actions"><button className="button primary" onClick={() => void openFile()}><FileText size={17} />파일 열기<kbd>⌘O</kbd></button><button className="button secondary" onClick={() => void openFolder()}><FolderOpen size={16} />폴더 열기</button></div><div className="welcome-formats">.md <span>·</span> .markdown <span>·</span> .mdown <span>·</span> .mkd</div><div className="welcome-features"><div><BookOpen size={18} /><strong>편안한 읽기</strong><span>표 · 코드 강조 · 수식</span></div><div><Pencil size={18} /><strong>바로 편집</strong><span>편집과 미리보기를 동시에</span></div><div><FolderIcon size={18} /><strong>끌어 놓아 열기</strong><span>마크다운 파일 또는 폴더</span></div></div></div>
        <div className="welcome-corner">MARKDOWN VIEWER <span>1.3</span></div>
      </div>}

      <footer className="statusbar"><div><span className={`status-dot ${dirty ? 'changed' : ''}`} /><span data-testid="save-status">{saving ? '저장 중' : dirty ? '저장하지 않은 변경 내용' : doc ? '저장됨' : '준비됨'}</span>{notice && <span className="status-notice"><Check size={12} />{notice}</span>}</div><div>{doc && <><span>{draft.length.toLocaleString()}자</span><span className="status-separator" /><span>{draft.split('\n').length.toLocaleString()}줄</span><span className="status-separator" /><span>UTF-8</span><span className="status-separator" /></>}<span>Markdown</span><Braces size={13} /></div></footer>
      {loading && <div className="loading-overlay"><LoaderCircle className="spin" size={26} /><span>문서 여는 중</span></div>}
    </main>

    {dropActive && <div className="drop-overlay" data-testid="drop-overlay"><div><FolderOpen size={35} strokeWidth={1.5} /><strong>파일 또는 폴더를 놓아 여십시오</strong><span>마크다운 파일은 바로 열리고, 폴더는 파일 트리로 표시됩니다.</span></div></div>}

    {pending && <div className="modal-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><div className="dialog-icon"><Save size={22} /></div><h2 id="confirm-title">변경 내용을 저장하시겠습니까?</h2><p title={pending.path}>{pending.name}에 저장하지 않은 내용이 있습니다.</p><div className="dialog-actions"><button className="button secondary" disabled={pendingBusy} onClick={() => finishPending(false)}>취소</button><button className="button secondary" disabled={pendingBusy} onClick={() => finishPending(true)}>저장하지 않고 {actionLabel}</button><button className="button primary" disabled={pendingBusy} onClick={() => void savePending()}>저장하고 {actionLabel}</button></div></div></div>}
  </div>;
}
