import { useEffect, useRef, useState } from 'react';
import { EditorState, Text } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth, selectAll } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { Copy, Scissors, ClipboardPaste, Undo2, Redo2, Search, TextSelect } from 'lucide-react';

type EditorCallbacks = { onChange: (value: string) => void; onSave: () => void };
type SavedEditor = {
  resetKey: number;
  state: EditorState;
  scrollTop: number;
  scrollSnapshot: ReturnType<EditorView['scrollSnapshot']>;
};

const savedEditors = new Map<string, SavedEditor>();
const activeEditors = new Map<string, symbol>();
const callbackTargets = new WeakMap<EditorView, { current: EditorCallbacks & {
  onUpdate: (view: EditorView) => void;
  onContextMenu: (event: MouseEvent, view: EditorView) => boolean;
} }>();
let editorMenuSequence = 0;

function editorInfo(state: EditorState) {
  const { main, ranges } = state.selection;
  const line = state.doc.lineAt(main.head);
  const selected = ranges.reduce((count, range) => count + Array.from(state.doc.sliceString(range.from, range.to, '\n')).length, 0);
  const fromLine = state.doc.lineAt(main.from).number;
  const toLine = state.doc.lineAt(main.empty ? main.to : main.to - 1).number;
  return {
    selected,
    position: `${line.number.toLocaleString()}줄 ${Array.from(line.text.slice(0, main.head - line.from)).length + 1}열`,
    range: fromLine === toLine ? `${fromLine}줄` : `${fromLine}–${toLine}줄`,
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
  };
}

export function discardEditorState(documentId: string) {
  savedEditors.delete(documentId);
  // Closing a mounted tab must also prevent its cleanup from restoring the cache.
  activeEditors.delete(documentId);
}

export default function Editor({ documentId, resetKey, initialValue, onChange, onSave }: EditorCallbacks & {
  documentId: string;
  resetKey: number;
  initialValue: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const menuRequest = useRef<{ requestId: string; state: EditorState } | null>(null);
  const [info, setInfo] = useState({ selected: 0, position: '1줄 1열', range: '1줄', canUndo: false, canRedo: false });
  const [feedback, setFeedback] = useState('');
  const run = (command: (view: EditorView) => boolean) => {
    const view = editor.current;
    if (!view) return;
    setFeedback('');
    view.focus();
    command(view);
  };
  const clipboard = async (command: 'copy' | 'cut' | 'paste') => {
    const view = editor.current;
    if (!view || (command !== 'paste' && view.state.selection.ranges.every(range => range.empty))) return;
    const state = view.state;
    view.focus();
    try {
      const text = command === 'paste' ? await window.desktop.readClipboardText() :
        state.selection.ranges.map(range => state.doc.sliceString(range.from, range.to, '\n')).join('\n');
      if (command !== 'paste') await window.desktop.copyText(text);
      if (editor.current !== view) return;
      // Clipboard access is asynchronous. Never edit a different tab or a changed selection.
      if (command !== 'copy' && (view.state.doc !== state.doc || !view.state.selection.eq(state.selection) || !view.hasFocus)) {
        setFeedback('커서나 문서가 바뀌어 편집을 취소했습니다');
        return;
      }
      if (command === 'cut' || (command === 'paste' && text)) {
        view.dispatch({
          ...state.replaceSelection(command === 'cut' ? '' : Text.of(text.split(/\r\n?|\n/))),
          userEvent: command === 'cut' ? 'delete.cut' : 'input.paste', scrollIntoView: true,
        });
      }
      setFeedback(command === 'copy' ? '선택한 내용을 복사했습니다' : command === 'cut' ? '선택한 내용을 잘라냈습니다' : text ? '붙여넣었습니다' : '붙여넣을 텍스트가 없습니다');
    } catch {
      if (editor.current === view) setFeedback('처리하지 못했습니다. 편집기를 선택한 뒤 다시 시도하십시오.');
    }
  };
  const onContextMenu = (event: MouseEvent, view: EditorView) => {
    event.preventDefault();
    view.focus();
    const state = view.state;
    const requestId = String(++editorMenuSequence);
    menuRequest.current = { requestId, state };
    void window.desktop.showEditorMenu({ requestId, canUndo: undoDepth(state) > 0, canRedo: redoDepth(state) > 0, hasSelection: state.selection.ranges.some(range => !range.empty) }).catch(() => {
      if (editor.current === view) setFeedback('편집 메뉴를 열지 못했습니다');
    });
    return true;
  };
  const onUpdate = (view: EditorView) => setInfo(editorInfo(view.state));
  const callbacks = useRef({ onChange, onSave, onUpdate, onContextMenu });
  callbacks.current = { onChange, onSave, onUpdate, onContextMenu };
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 3500);
    return () => clearTimeout(timer);
  }, [feedback]);
  useEffect(() => {
    if (!host.current) return;
    const instance = Symbol(documentId);
    activeEditors.set(documentId, instance);
    const cached = savedEditors.get(documentId);
    const restored = cached?.resetKey === resetKey && cached.state.sliceDoc() === initialValue ? cached : undefined;
    savedEditors.delete(documentId);
    const view = new EditorView({
      parent: host.current,
      scrollTo: restored?.scrollSnapshot,
      state: restored?.state ?? EditorState.create({ doc: initialValue, extensions: [
        EditorState.lineSeparator.of(initialValue.includes('\r\n') ? '\r\n' : '\n'),
        lineNumbers(), history(), drawSelection({ drawRangeCursor: true }), dropCursor(), highlightSpecialChars(), highlightActiveLine(), highlightActiveLineGutter(),
        markdown({ codeLanguages: languages }), syntaxHighlighting(defaultHighlightStyle),
        bracketMatching(), highlightSelectionMatches(), EditorView.lineWrapping,
        EditorView.clipboardInputFilter.of((text, state) => text.replace(/\r\n?|\n/g, state.lineBreak)),
        EditorView.domEventHandlers({ contextmenu: (event, view) => callbackTargets.get(view)?.current.onContextMenu(event, view) ?? false }),
        keymap.of([{ key: 'Mod-s', run: editor => { callbackTargets.get(editor)?.current.onSave(); return true; } }, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        EditorView.updateListener.of(update => {
          const target = callbackTargets.get(update.view)?.current;
          if (update.docChanged) target?.onChange(update.state.sliceDoc());
          if (update.docChanged || update.selectionSet) target?.onUpdate(update.view);
        }),
        EditorView.contentAttributes.of({ 'aria-label': '마크다운 편집기', 'aria-multiline': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
        EditorState.phrases.of({
          'Find': '찾기', 'Replace': '바꾸기', 'next': '다음', 'previous': '이전', 'all': '모두 선택',
          'match case': '대소문자 구분', 'regexp': '정규식', 'by word': '단어 단위',
          'replace': '바꾸기', 'replace all': '모두 바꾸기', 'close': '닫기',
          'current match': '선택한 검색 결과', 'replaced $ matches': '$개를 바꿨습니다',
          'replaced match on line $': '$줄을 바꿨습니다', 'on line': '줄',
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px', backgroundColor: '#fcfcfa' },
          '.cm-scroller': { overflow: 'auto', fontFamily: '"SFMono-Regular", Consolas, monospace', lineHeight: '1.85' },
          '.cm-content': { padding: '22px 0' }, '.cm-line': { padding: '0 24px 0 12px' },
          '.cm-gutters': { backgroundColor: '#fcfcfa', color: '#92988a', borderRight: 'none', padding: '0 2px 0 12px' },
          // Selection is painted behind the text. An opaque active-line fill hides it.
          '.cm-activeLine': { backgroundColor: 'rgba(98, 115, 68, 0.055)' },
          '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#4f6335', fontWeight: '600' },
          '&.cm-focused': { outline: 'none' },
          '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#245aaf', borderLeftWidth: '2px' },
          '& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: '#c7d5e8' },
          '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: '#9ec5ff' },
          '.cm-selectionMatch': { backgroundColor: 'transparent', outline: '1px solid #a8b5c7' },
          '.cm-panels': { backgroundColor: '#f4f6ef', color: '#47553c' },
          '.cm-search': { padding: '8px 10px', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', fontSize: '12px' },
          '.cm-textfield': { background: '#fff', border: '1px solid #bac5ae', borderRadius: '4px', maxWidth: '100%' },
          '.cm-button': { backgroundImage: 'none', backgroundColor: '#fff', border: '1px solid #c9d2bf', borderRadius: '4px', textTransform: 'none' },
        }),
      ] }),
    });
    callbackTargets.set(view, callbacks);
    editor.current = view;
    callbacks.current.onUpdate(view);
    const unsubscribeMenu = window.desktop.onEditorMenuAction(({ requestId, action }) => {
      const request = menuRequest.current;
      if (!request || request.requestId !== requestId) return;
      menuRequest.current = null;
      if (editor.current !== view || request.state.doc !== view.state.doc || !request.state.selection.eq(view.state.selection)) return;
      if (action === 'copy' || action === 'cut' || action === 'paste') void clipboard(action);
      else run(action === 'undo' ? undo : action === 'redo' ? redo : selectAll);
    });
    view.focus();
    if (restored) {
      view.scrollDOM.scrollTop = restored.scrollTop;
      view.requestMeasure({
        read: () => restored.scrollTop,
        write: scrollTop => {
          if (activeEditors.get(documentId) === instance) view.scrollDOM.scrollTop = scrollTop;
        },
      });
    }
    return () => {
      if (activeEditors.get(documentId) === instance) {
        savedEditors.set(documentId, {
          resetKey,
          state: view.state,
          scrollTop: view.scrollDOM.scrollTop,
          scrollSnapshot: view.scrollSnapshot(),
        });
        activeEditors.delete(documentId);
      }
      callbackTargets.delete(view);
      unsubscribeMenu();
      menuRequest.current = null;
      if (editor.current === view) editor.current = null;
      view.destroy();
    };
  }, [documentId, resetKey]);
  return <div className="editor-shell">
    <div className="editor-tools" role="toolbar" aria-label="문서 편집 도구" onMouseDown={event => event.preventDefault()}>
      <button data-testid="editor-undo" aria-label="실행 취소" title="실행 취소 (⌘Z)" disabled={!info.canUndo} onClick={() => run(undo)}><Undo2 size={15} /></button>
      <button data-testid="editor-redo" aria-label="다시 실행" title="다시 실행 (⌘⇧Z)" disabled={!info.canRedo} onClick={() => run(redo)}><Redo2 size={15} /></button>
      <span className="editor-tool-divider" />
      <button data-testid="editor-select-all" title="전체 선택 (⌘A)" onClick={() => run(selectAll)}><TextSelect size={14} />전체 선택</button>
      <button data-testid="editor-copy" title="선택한 내용 복사 (⌘C)" disabled={!info.selected} onClick={() => void clipboard('copy')}><Copy size={14} />복사</button>
      <button data-testid="editor-cut" title="선택한 내용 잘라내기 (⌘X)" disabled={!info.selected} onClick={() => void clipboard('cut')}><Scissors size={14} />잘라내기</button>
      <button data-testid="editor-paste" title="커서 또는 선택 영역에 붙여넣기 (⌘V)" onClick={() => void clipboard('paste')}><ClipboardPaste size={14} />붙여넣기</button>
      <button data-testid="editor-find" title="찾기 및 바꾸기 (⌘F)" onClick={() => run(openSearchPanel)}><Search size={14} />찾기</button>
    </div>
    <div ref={host} className="editor-host" />
    <div className={`editor-status ${info.selected ? 'has-selection' : ''}`}>
      <div data-testid="editor-selection-status"><span>{info.position}</span><strong>{info.selected ? `${info.selected.toLocaleString()}자 선택 · ${info.range}` : '선택한 내용 없음'}</strong></div>
      <span className="editor-feedback" role="status">{feedback}</span>
    </div>
  </div>;
}
