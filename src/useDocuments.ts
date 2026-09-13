import { useCallback, useRef, useState } from 'react';
import type { DesktopAPI, DocumentFile } from './desktop';
import { discardEditorState } from './Editor';

export type DocumentTab = {
  file: DocumentFile;
  draft: string;
  editing: boolean;
  epoch: number;
  externalChanged: boolean;
  error: string;
  saving: boolean;
};
export const tabIsDirty = (tab: DocumentTab) => tab.draft !== tab.file.content;
export const tabNeedsAttention = (tab: DocumentTab) => tabIsDirty(tab) || tab.saving;

export function useDocuments(api: DesktopAPI, describeError: (error: unknown, path?: string) => string) {
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const tabsRef = useRef<DocumentTab[]>([]);
  const activeRef = useRef<string | null>(null);
  const saves = useRef(new Map<string, Promise<boolean>>());
  const scrolls = useRef(new Map<string, number>());

  const commit = useCallback((update: (current: DocumentTab[]) => DocumentTab[]) => {
    const next = update(tabsRef.current);
    tabsRef.current = next;
    setTabs(next);
    api?.setDirty(next.some(tabNeedsAttention));
  }, [api]);
  const activate = useCallback((path: string | null) => {
    if (path !== null && !tabsRef.current.some(tab => tab.file.path === path)) return;
    activeRef.current = path;
    setActiveId(path);
  }, []);
  const patch = useCallback((path: string, update: (tab: DocumentTab) => DocumentTab) => {
    commit(current => current.map(tab => tab.file.path === path ? update(tab) : tab));
  }, [commit]);
  const add = useCallback((file: DocumentFile, select = true) => {
    if (!tabsRef.current.some(tab => tab.file.path === file.path)) {
      commit(current => [...current, { file, draft: file.content, editing: false, epoch: 0, externalChanged: false, error: '', saving: false }]);
    }
    if (select) activate(file.path);
  }, [activate, commit]);
  const remove = useCallback((path: string) => {
    const index = tabsRef.current.findIndex(tab => tab.file.path === path);
    if (index < 0) return;
    const next = tabsRef.current.filter(tab => tab.file.path !== path);
    discardEditorState(path);
    scrolls.current.delete(`${path}:read`);
    scrolls.current.delete(`${path}:edit`);
    commit(() => next);
    if (activeRef.current === path) activate(next[Math.min(index, next.length - 1)]?.file.path ?? null);
  }, [activate, commit]);
  const replace = useCallback((file: DocumentFile) => {
    patch(file.path, tab => ({ ...tab, file, draft: file.content, epoch: tab.epoch + 1, externalChanged: false, error: '' }));
  }, [patch]);
  const refresh = useCallback(async (path: string) => {
    const before = tabsRef.current.find(tab => tab.file.path === path);
    if (!before || before.saving) return;
    try {
      const file = await api.readFile(path);
      const current = tabsRef.current.find(tab => tab.file.path === path);
      if (!current || current.saving || current.file.version !== before.file.version || file.version === current.file.version) return;
      if (tabIsDirty(current)) patch(path, tab => ({ ...tab, externalChanged: true }));
      else replace(file);
    } catch (error) {
      if (tabsRef.current.some(tab => tab.file.path === path)) patch(path, tab => ({ ...tab, externalChanged: true, error: describeError(error, path) }));
    }
  }, [api, describeError, patch, replace]);

  const save = useCallback((path: string): Promise<boolean> => {
    const running = saves.current.get(path);
    if (running) return running;
    const before = tabsRef.current.find(tab => tab.file.path === path);
    if (!before || !tabIsDirty(before)) return Promise.resolve(true);
    patch(path, tab => ({ ...tab, saving: true, error: '' }));
    const operation = (async () => {
      try {
        const saved = await api.saveFile(path, before.draft, before.file.version);
        patch(path, tab => ({ ...tab, file: saved,
          draft: tab.draft === before.draft ? saved.content : tab.draft,
          epoch: tab.epoch + (tab.draft === before.draft && saved.content !== before.draft ? 1 : 0),
          saving: false, externalChanged: false }));
        return !tabsRef.current.some(tab => tab.file.path === path && tabIsDirty(tab));
      } catch (error) {
        patch(path, tab => ({ ...tab, saving: false, error: describeError(error, path) }));
        return false;
      } finally { saves.current.delete(path); }
    })();
    saves.current.set(path, operation);
    return operation;
  }, [api, describeError, patch]);
  const saveAll = useCallback(async () => {
    for (const tab of [...tabsRef.current]) {
      if (!(await save(tab.file.path))) { activate(tab.file.path); return false; }
    }
    return !tabsRef.current.some(tabNeedsAttention);
  }, [activate, save]);

  return { tabs, activeId, active: tabs.find(tab => tab.file.path === activeId) ?? null, tabsRef, activeRef, scrolls, activate, patch, add, remove, replace, refresh, save, saveAll };
}
