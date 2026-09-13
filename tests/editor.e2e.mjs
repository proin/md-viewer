import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { _electron as electron } from 'playwright';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenshotDirectory = path.join(projectDirectory, 'artifacts', 'screenshots');
const temporaryDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'markdown-viewer-editor-')));
const profile = path.join(temporaryDirectory, 'profile');
const filePath = path.join(temporaryDirectory, '텍스트 선택과 편집.md');
const otherPath = path.join(temporaryDirectory, '다른 편집 탭.md');
const windowsPath = path.join(temporaryDirectory, 'Windows 줄바꿈.md');
const initial = '# 편집 검사\n\nAlpha beta gamma delta.\n한글 문장을 선택합니다.\nSecond line stays intact.\n';
const windowsInitial = '# Windows\r\n\r\nBefore PLACEHOLDER after.\r\nEnd\r\n';
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
await writeFile(filePath, initial, 'utf8');
await writeFile(otherPath, '# 다른 편집 탭\n\n전환 검사\n', 'utf8');
await writeFile(windowsPath, windowsInitial, 'utf8');
let application;
let page;
let clipboardCaptured = false;
const results = [];
const errors = [];

async function eventually(callback, description, timeout = 12_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try { return await callback(); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  throw new Error(`${description}: ${lastError?.message || 'timed out'}`, { cause: lastError });
}

async function run(name, callback) {
  await callback();
  results.push(name);
  console.log(`PASS ${name}`);
}

function editor() { return page.locator('.cm-content:visible'); }
function selection() { return page.evaluate(() => window.getSelection()?.toString() || ''); }

async function reset(content = initial) {
  await editor().focus();
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.insertText(content);
  await eventually(async () => assert.ok((await editor().innerText()).includes(content.trimEnd().split('\n').at(-1))), 'Editor received replacement document');
}

async function textPoint(lineText, offset) {
  const line = page.locator('.cm-line').filter({ hasText: lineText }).filter({ hasNot: page.locator('.cm-widgetBuffer') });
  return line.evaluate((element, position) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    let left = position;
    while ((node = walker.nextNode())) {
      if (left <= node.textContent.length) {
        const range = document.createRange();
        range.setStart(node, left); range.collapse(true);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y + rect.height / 2 };
      }
      left -= node.textContent.length;
    }
    throw new Error('Text offset is outside the rendered line.');
  }, offset);
}

async function mouseSelect(lineText, start, end) {
  const from = await textPoint(lineText, start);
  const to = await textPoint(lineText, end);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await eventually(async () => assert.equal(await selection(), lineText.slice(start, end)), 'Mouse selects the exact text range');
}

async function expectSelectionStatus(count) {
  await eventually(async () => {
    const status = await page.getByTestId('editor-selection-status').innerText();
    assert.match(status, new RegExp(`(?:${count}\\s*자.*선택|선택.*${count}\\s*자)`));
  }, 'Selection count is visible');
}

function decodePNG(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG');
  let width, height, colorType;
  const compressed = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const name = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (name === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9];
      assert.equal(data[8], 8, 'Screenshot uses 8-bit pixels');
      assert.equal(data[12], 0, 'Screenshot is not interlaced');
    }
    if (name === 'IDAT') compressed.push(data);
    offset += length + 12;
  }
  assert.ok(colorType === 2 || colorType === 6);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const packed = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(width * height * channels);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const type = packed[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const a = x >= channels ? pixels[at - channels] : 0;
      const b = y ? pixels[at - stride] : 0;
      const c = y && x >= channels ? pixels[at - stride - channels] : 0;
      const filter = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      pixels[at] = (packed[y * (stride + 1) + 1 + x] + filter) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function parseRGB(value) {
  const numbers = value.match(/[\d.]+/g)?.map(Number);
  assert.ok(numbers?.length >= 3, `Expected a painted RGB color, got ${value}`);
  return numbers.slice(0, 3);
}

function contrast(a, b) {
  const luminance = rgb => rgb.map(channel => {
    const n = channel / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

async function expectPaintedSelection(focused) {
  await eventually(async () => assert.ok(await page.locator('.cm-selectionBackground').count()), 'Selection layer exists');
  await eventually(async () => assert.equal(await page.locator('.cm-editor:visible').evaluate(element => element.classList.contains('cm-focused')), focused), 'CodeMirror updates its focus styling');
  const data = await page.locator('.cm-selectionBackground').first().evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const editor = element.closest('.cm-editor');
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      color: getComputedStyle(element).backgroundColor, background: getComputedStyle(editor).backgroundColor,
      focused: editor.classList.contains('cm-focused') };
  });
  assert.equal(data.focused, focused);
  const selectedColor = parseRGB(data.color);
  const background = parseRGB(data.background);
  assert.ok(contrast(selectedColor, background) >= (focused ? 1.6 : 1.35), 'Selection color visibly differs from the editor background');
  assert.ok(data.width > 15 && data.height > 8);
  const png = decodePNG(await page.screenshot({
    clip: { x: Math.ceil(data.x), y: Math.ceil(data.y), width: Math.max(1, Math.floor(data.width) - 1), height: Math.max(1, Math.floor(data.height) - 1) },
    scale: 'css',
  }));
  let painted = 0;
  for (let i = 0; i < png.pixels.length; i += png.channels) {
    if (selectedColor.every((channel, offset) => Math.abs(png.pixels[i + offset] - channel) <= 24)) painted++;
  }
  assert.ok(painted / (png.width * png.height) > 0.3, 'Selection color is actually painted instead of hidden by the active-line background');
}

async function snapshotClipboard() {
  await application.evaluate(async ({ clipboard, ClipboardItem }) => {
    const entries = await clipboard.read();
    globalThis.__editorClipboardSnapshot = await Promise.all(entries.map(async item => new ClipboardItem(Object.fromEntries(
      await Promise.all(item.types.map(async type => {
        const payload = await item.getType(type);
        return [type, typeof payload?.arrayBuffer === 'function' ? new Blob([await payload.arrayBuffer()], { type: payload.type }) : payload];
      })),
    ))));
    // Finder URL aliases already reconstruct text/uri-list. Writing the derived
    // MIME value a second time would append duplicate file URLs on macOS.
    globalThis.__editorClipboardRestore = await Promise.all(globalThis.__editorClipboardSnapshot.map(async item => {
      const hasNativeFileURL = item.types.some(type => /format="(?:Apple URL pasteboard type|CorePasteboardFlavorType 0x6675726C)"/.test(type));
      const types = item.types.filter(type => !(hasNativeFileURL && type === 'text/uri-list'));
      return new ClipboardItem(Object.fromEntries(await Promise.all(types.map(async type => [type, await item.getType(type)]))));
    }));
    globalThis.__editorClipboardFingerprint = async items => JSON.stringify((await Promise.all(items.map(async item =>
      JSON.stringify(await Promise.all([...item.types].sort().map(async type => {
        const payload = await item.getType(type);
        if (type === 'text/uri-list') return [type, [...new Set((await payload.text()).split(/\r\n|\r|\n/).filter(Boolean))]];
        return [type, typeof payload?.arrayBuffer === 'function' ? Array.from(new Uint8Array(await payload.arrayBuffer())) :
          Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)))];
      }))),
    ))).sort());
    globalThis.__editorClipboardSummary = async items => Promise.all(items.map(async item => Promise.all([...item.types].sort().map(async type => {
      const payload = await item.getType(type);
      return { type, size: typeof payload?.arrayBuffer === 'function' ? payload.size : null };
    }))));
    globalThis.__editorClipboardBefore = await globalThis.__editorClipboardFingerprint(globalThis.__editorClipboardSnapshot);
  });
  clipboardCaptured = true;
}

async function restoreClipboard() {
  if (!clipboardCaptured) return;
  const restored = await application.evaluate(async ({ clipboard }) => {
    if (globalThis.__editorClipboardRestore.length) await clipboard.write(globalThis.__editorClipboardRestore);
    else await clipboard.clear();
    const afterItems = await clipboard.read();
    const after = await globalThis.__editorClipboardFingerprint(afterItems);
    return { equal: after === globalThis.__editorClipboardBefore,
      ...(after !== globalThis.__editorClipboardBefore ? {
        before: await globalThis.__editorClipboardSummary(globalThis.__editorClipboardSnapshot),
        after: await globalThis.__editorClipboardSummary(afterItems),
      } : {}) };
  });
  assert.equal(restored.equal, true, `Every original clipboard format and payload is restored; format metadata only: ${JSON.stringify(restored)}`);
  clipboardCaptured = false;
}

async function clipboardText() { return application.evaluate(async ({ clipboard }) => await clipboard.readText()); }
async function setClipboard(value) { await application.evaluate(async ({ clipboard }, text) => await clipboard.writeText(text), value); }

async function delayClipboard(channel) {
  await application.evaluate(({ ipcMain }, name) => {
    const original = ipcMain._invokeHandlers.get(name);
    globalThis.__originalClipboardHandler = original;
    globalThis.__clipboardDelayReady = false;
    globalThis.__clipboardDelayCompleted = false;
    ipcMain.removeHandler(name);
    ipcMain.handle(name, async (...args) => {
      const result = await original(...args);
      await new Promise(resolve => {
        globalThis.__clipboardDelayReady = true;
        globalThis.__releaseClipboardDelay = resolve;
      });
      globalThis.__clipboardDelayCompleted = true;
      return result;
    });
  }, channel);
}

async function finishClipboardDelay(channel) {
  await application.evaluate(({ ipcMain }, name) => {
    globalThis.__releaseClipboardDelay?.();
    ipcMain.removeHandler(name);
    ipcMain.handle(name, globalThis.__originalClipboardHandler);
  }, channel);
}

async function releaseClipboardDelay() {
  await application.evaluate(() => globalThis.__releaseClipboardDelay());
  await eventually(async () => assert.equal(await application.evaluate(() => globalThis.__clipboardDelayCompleted), true), 'Delayed clipboard operation returns');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function nativeRole(role) {
  await application.evaluate(({ BrowserWindow, Menu }, requested) => {
    const find = menu => {
      for (const item of menu.items) {
        if (item.role?.toLowerCase() === requested.toLowerCase()) return item;
        if (item.submenu) { const match = find(item.submenu); if (match) return match; }
      }
    };
    const window = BrowserWindow.getAllWindows()[0];
    const item = find(Menu.getApplicationMenu());
    if (!item) throw new Error(`Missing native role ${requested}`);
    // Calling MenuItem.click outside a native menu changes macOS focus handling.
    // Exercise the native webContents command used by the verified menu role.
    window.webContents[requested]();
  }, role);
}

try {
  application = await electron.launch({
    args: ['.', '--file', filePath, '--user-data-dir', profile], cwd: projectDirectory,
    env: { ...process.env, MARKDOWN_VIEWER_USER_DATA: profile }, timeout: 30_000,
  });
  page = await application.firstWindow();
  await application.evaluate(({ app, BrowserWindow, dialog }) => {
    app.addRecentDocument = () => {};
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    const window = BrowserWindow.getAllWindows()[0];
    window.show(); window.focus(); window.webContents.focus();
  });
  page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByTestId('edit-button').click();

  await run('마우스로 부분 선택한 글자와 선택 글자 수 표시', async () => {
    await mouseSelect('Alpha beta gamma delta.', 6, 10);
    await expectSelectionStatus(4);
    await expectPaintedSelection(true);
  });

  await run('도구 모음으로 포커스를 옮겨도 선택 영역 표시', async () => {
    await page.getByTestId('editor-copy').focus();
    await expectSelectionStatus(4);
    await expectPaintedSelection(false);
  });

  await run('Shift+방향키 선택과 Cmd/Ctrl+A 전체 선택', async () => {
    await mouseSelect('Alpha beta gamma delta.', 6, 6);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await selection(), 'beta');
    await expectSelectionStatus(4);
    await page.keyboard.press(`${modifier}+A`);
    assert.equal((await selection()).trimEnd(), initial.trimEnd());
    await expectSelectionStatus(initial.length);
  });

  await snapshotClipboard();

  await run('복사 버튼으로 선택한 글자만 실제 클립보드에 복사', async () => {
    await setClipboard('copy has not executed');
    await mouseSelect('Alpha beta gamma delta.', 6, 10);
    await page.getByTestId('editor-copy').click();
    await eventually(async () => assert.equal(await clipboardText(), 'beta'), 'Toolbar copies exactly the selected substring');
    assert.equal(await readFile(filePath, 'utf8'), initial);
    await expectSelectionStatus(4);
  });

  await run('붙여넣기 버튼은 선택 영역만 교체하고 다른 내용 유지', async () => {
    await setClipboard('교체한 글자');
    await page.getByTestId('editor-paste').click();
    await eventually(async () => assert.match(await editor().innerText(), /Alpha 교체한 글자 gamma delta\./), 'Paste replaces only the selected word');
    assert.match(await editor().innerText(), /한글 문장을 선택합니다\./);
    assert.match(await editor().innerText(), /Second line stays intact\./);
    await page.getByTestId('save-button').click();
    await eventually(async () => assert.equal(await readFile(filePath, 'utf8'), initial.replace('beta', '교체한 글자')), 'Only the selected range changed on disk');
  });

  await run('실행 취소·다시 실행 버튼과 키보드 단축키', async () => {
    await page.getByTestId('editor-undo').click();
    await eventually(async () => assert.match(await editor().innerText(), /Alpha beta gamma delta\./), 'Undo restores the replaced word');
    await page.getByTestId('editor-redo').click();
    await eventually(async () => assert.match(await editor().innerText(), /Alpha 교체한 글자 gamma delta\./), 'Redo reapplies the replacement');
    await editor().focus();
    await page.keyboard.press(`${modifier}+Z`);
    await eventually(async () => assert.match(await editor().innerText(), /Alpha beta gamma delta\./), 'Keyboard undo works');
    await page.keyboard.press(`${modifier}+Shift+Z`);
    await eventually(async () => assert.match(await editor().innerText(), /Alpha 교체한 글자 gamma delta\./), 'Keyboard redo works');
  });

  await run('잘라내기와 붙여넣기로 선택한 글자 이동', async () => {
    await reset();
    await mouseSelect('Alpha beta gamma delta.', 6, 10);
    await page.getByTestId('editor-cut').click();
    await eventually(async () => {
      assert.equal(await clipboardText(), 'beta');
      assert.match(await editor().innerText(), /Alpha  gamma delta\./);
    }, 'Cut copies and removes only the selected word');
    const end = await textPoint('Alpha  gamma delta.', 'Alpha  gamma delta.'.length);
    await page.mouse.click(end.x, end.y);
    await page.getByTestId('editor-paste').click();
    await eventually(async () => assert.match(await editor().innerText(), /Alpha  gamma delta\.beta/), 'Paste inserts at the current caret');
  });

  await run('운영체제 편집 메뉴의 복사·잘라내기·붙여넣기', async () => {
    await reset();
    await mouseSelect('Alpha beta gamma delta.', 6, 10);
    await setClipboard('native copy has not executed');
    await nativeRole('copy');
    await eventually(async () => assert.equal(await clipboardText(), 'beta'), 'Native copy menu uses the editor selection');
    await nativeRole('cut');
    await eventually(async () => assert.match(await editor().innerText(), /Alpha  gamma delta\./), 'Native cut menu updates the document');
    await setClipboard('native');
    await nativeRole('paste');
    await eventually(async () => assert.match(await editor().innerText(), /Alpha native gamma delta\./), 'Native paste menu inserts at the cut location');
  });

  await run('여러 줄을 선택해 복사하고 원래 줄바꿈 유지', async () => {
    await reset();
    const from = await textPoint('Alpha beta gamma delta.', 6);
    const to = await textPoint('한글 문장을 선택합니다.', 5);
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 18 }); await page.mouse.up();
    const expected = 'beta gamma delta.\n한글 문장';
    await eventually(async () => assert.equal(await selection(), expected), 'Multiline drag preserves exact selection boundaries');
    await expectSelectionStatus(expected.length);
    await page.getByTestId('editor-copy').click();
    await eventually(async () => assert.equal(await clipboardText(), expected), 'Copied multiline text preserves newline characters');
  });

  await run('오른쪽 클릭 편집 메뉴에 선택 영역에 맞는 동작 표시', async () => {
    await mouseSelect('Alpha beta gamma delta.', 6, 10);
    await page.keyboard.insertText('CONTEXT');
    await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, otherPath);
    await page.getByTestId('file-open').click();
    await page.getByTestId('document-tab').and(page.locator(`[data-path=${JSON.stringify(otherPath)}]`)).waitFor();
    await page.getByTestId('document-tab').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`)).click();
    await eventually(async () => assert.equal(await page.getByTestId('editor-undo').isEnabled(), true), 'Restored editor publishes its undo history to the toolbar');
    await application.evaluate(({ Menu }) => {
      globalThis.__editorPopup = null;
      globalThis.__originalMenuPopup = Menu.prototype.popup;
      Menu.prototype.popup = function () {
        globalThis.__editorPopupInstance = this;
        globalThis.__editorPopup = this.items.map(item => ({ label: item.label, role: item.role, enabled: item.enabled }));
      };
    });
    try {
      await mouseSelect('Alpha CONTEXT gamma delta.', 6, 13);
      const middle = await textPoint('Alpha CONTEXT gamma delta.', 8);
      await page.mouse.click(middle.x, middle.y, { button: 'right' });
      await eventually(async () => {
        const menu = await application.evaluate(() => globalThis.__editorPopup);
        assert.ok(menu, 'Native context menu receives the right click');
        const labels = { undo: '실행 취소', redo: '다시 실행', copy: '복사', cut: '잘라내기', paste: '붙여넣기', selectAll: '전체 선택' };
        const item = role => menu.find(entry => entry.role?.toLowerCase() === role.toLowerCase() || entry.label === labels[role]);
        for (const role of ['undo', 'redo', 'copy', 'cut', 'paste', 'selectAll']) assert.ok(item(role), `${role} is available in the native editor menu`);
        assert.equal(item('copy').enabled, true);
        assert.equal(item('cut').enabled, true);
        assert.equal(item('undo').enabled, true, 'Restored CodeMirror undo history enables native context undo');
      }, 'Context menu offers native edit actions');
      await expectSelectionStatus(7);
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        globalThis.__editorPopupInstance.items.find(item => item.label === '실행 취소').click(undefined, window, window.webContents);
      });
      await eventually(async () => assert.match(await editor().innerText(), /Alpha beta gamma delta\./), 'Context undo operates on restored CodeMirror history');
      const afterUndo = await textPoint('Alpha beta gamma delta.', 8);
      await page.mouse.click(afterUndo.x, afterUndo.y, { button: 'right' });
      await eventually(async () => {
        const menu = await application.evaluate(() => globalThis.__editorPopup);
        assert.equal(menu.find(item => item.label === '다시 실행').enabled, true);
      }, 'Context redo is enabled after undo');
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        globalThis.__editorPopupInstance.items.find(item => item.label === '다시 실행').click(undefined, window, window.webContents);
      });
      await eventually(async () => assert.match(await editor().innerText(), /Alpha CONTEXT gamma delta\./), 'Context redo restores the undone text');
    } finally {
      await application.evaluate(({ Menu }) => { Menu.prototype.popup = globalThis.__originalMenuPopup; });
    }
  });

  await run('전체 선택 버튼으로 문서 전체를 정확히 복사', async () => {
    await reset();
    await page.getByTestId('editor-select-all').click();
    await expectSelectionStatus(initial.length);
    await page.getByTestId('editor-copy').click();
    await eventually(async () => assert.equal(await clipboardText(), initial), 'Select-all includes the complete document and final newline');
  });

  await run('선택 후 탭을 전환해도 선택 영역과 복사 대상 유지', async () => {
    await mouseSelect('Alpha beta gamma delta.', 6, 10);
    await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, otherPath);
    await page.getByTestId('file-open').click();
    await page.getByTestId('document-tab').and(page.locator(`[data-path=${JSON.stringify(otherPath)}]`)).waitFor();
    await page.getByTestId('document-tab').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`)).click();
    await expectSelectionStatus(4);
    await page.getByTestId('editor-copy').click();
    await eventually(async () => assert.equal(await clipboardText(), 'beta'), 'Selection is restored with the tab');
  });

  await run('붙여넣기를 기다리는 동안 탭을 바꿔도 다른 문서를 수정하지 않음', async () => {
    await mouseSelect('Alpha beta gamma delta.', 6, 10);
    await setClipboard('UNEXPECTED_ASYNC_PASTE');
    await delayClipboard('clipboard:read-text');
    try {
      await page.getByTestId('editor-paste').click();
      await eventually(async () => assert.equal(await application.evaluate(() => globalThis.__clipboardDelayReady), true), 'Clipboard read is paused');
      await page.getByTestId('document-tab').and(page.locator(`[data-path=${JSON.stringify(otherPath)}]`)).click();
      await releaseClipboardDelay();
      assert.equal(await page.getByTestId('document-title').getAttribute('title'), otherPath);
      assert.doesNotMatch(await page.getByTestId('markdown-preview').innerText(), /UNEXPECTED_ASYNC_PASTE/);
      await page.getByTestId('document-tab').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`)).click();
      await eventually(async () => {
        assert.match(await editor().innerText(), /Alpha beta gamma delta\./);
        assert.doesNotMatch(await editor().innerText(), /UNEXPECTED_ASYNC_PASTE/);
      }, 'Restored tab keeps its original text after the delayed clipboard operation');
    } finally { await finishClipboardDelay('clipboard:read-text'); }
  });

  await run('잘라내기를 기다리는 동안 입력한 새 문장을 삭제하지 않음', async () => {
    await mouseSelect('Alpha beta gamma delta.', 6, 10);
    await delayClipboard('clipboard:write-text');
    try {
      await page.getByTestId('editor-cut').click();
      await eventually(async () => assert.equal(await application.evaluate(() => globalThis.__clipboardDelayReady), true), 'Clipboard write is paused');
      await editor().focus();
      await page.keyboard.insertText('USER');
      await releaseClipboardDelay();
      assert.match(await editor().innerText(), /Alpha USER gamma delta\./);
      assert.equal(await clipboardText(), 'beta');
    } finally { await finishClipboardDelay('clipboard:write-text'); }
  });

  await run('여러 줄 붙여넣기 후 Windows CRLF 줄바꿈 보존', async () => {
    await application.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, windowsPath);
    await page.getByTestId('file-open').click();
    await page.getByTestId('document-tab').and(page.locator(`[data-path=${JSON.stringify(windowsPath)}]`)).waitFor();
    await page.getByTestId('edit-button').click();
    await mouseSelect('Before PLACEHOLDER after.', 7, 18);
    await setClipboard('첫 줄\n둘째 줄');
    await page.getByTestId('editor-paste').click();
    await eventually(async () => assert.match(await editor().innerText(), /둘째 줄 after\./), 'Toolbar accepts multiline LF clipboard text');
    await page.getByTestId('save-button').click();
    await eventually(async () => assert.equal(await readFile(windowsPath, 'utf8'), windowsInitial.replace('PLACEHOLDER', '첫 줄\r\n둘째 줄')), 'Toolbar paste saves only CRLF separators');
    await reset(windowsInitial);
    await mouseSelect('Before PLACEHOLDER after.', 7, 18);
    await setClipboard('세 번째\r\n네 번째');
    await nativeRole('paste');
    await eventually(async () => assert.match(await editor().innerText(), /네 번째 after\./), 'Native paste accepts multiline CRLF text');
    await page.getByTestId('save-button').click();
    await eventually(async () => assert.equal(await readFile(windowsPath, 'utf8'), windowsInitial.replace('PLACEHOLDER', '세 번째\r\n네 번째')), 'Native paste does not duplicate carriage returns');
  });

  await run('클립보드 원본 복원과 편집 화면 오류 검사', async () => {
    await restoreClipboard();
    assert.deepEqual(errors, [], 'No unhandled renderer errors');
  });
  await page.getByTestId('document-tab').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`)).click();
  await reset('# 편집 기능 검사\n\n마우스로 글자를 선택하면 선택한 부분이 파란색으로 표시됩니다.\n\n복사 · 잘라내기 · 붙여넣기 · 실행 취소 · 다시 실행\n');
  await mouseSelect('마우스로 글자를 선택하면 선택한 부분이 파란색으로 표시됩니다.', 0, 13);
  await mkdir(screenshotDirectory, { recursive: true });
  const selectedScreenshot = await page.screenshot({ path: path.join(screenshotDirectory, 'markdown-viewer-edit.png') });
  await writeFile(path.join(screenshotDirectory, 'markdown-viewer-editor-selection.png'), selectedScreenshot);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(940, 760));
  await eventually(async () => {
    const tools = await page.locator('.editor-tools').boundingBox();
    assert.ok(tools);
    for (const button of await page.locator('.editor-tools button').all()) {
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.x >= tools.x - 1 && bounds.x + bounds.width <= tools.x + tools.width + 1 && bounds.y + bounds.height <= tools.y + tools.height + 1, 'Editor controls fit within the minimum-width toolbar');
    }
    assert.ok((await page.locator('.editor-host').boundingBox()).height > 150, 'Minimum-width editor retains usable text space');
  }, 'Editor tools wrap without clipping at 940px');
  const minimumScreenshot = path.join(screenshotDirectory, 'markdown-viewer-editor-minimum.png');
  await page.screenshot({ path: minimumScreenshot });
  console.log(`PASS ${results.length} editor integration checks`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(temporaryDirectory, 'failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 5500));
  }
  console.error(`Failure artifacts retained: ${temporaryDirectory}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (application) {
    try { await restoreClipboard(); } catch (error) { console.error('Clipboard restoration failed:', error.message); process.exitCode = 1; }
    if (process.exitCode) application.process().kill('SIGTERM');
    else await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
    await application.close().catch(() => {});
  }
  if (!process.exitCode) await rm(temporaryDirectory, { recursive: true, force: true });
}
