import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'markdown-viewer-tabs-')));
const userDataDirectory = path.join(temporaryDirectory, 'profile');
const firstFolder = path.join(temporaryDirectory, '첫 폴더');
const secondFolder = path.join(temporaryDirectory, '다른 폴더 # 100%');
const paths = {
  alpha: path.join(firstFolder, 'Alpha.md'),
  beta: path.join(firstFolder, 'Beta.md'),
  sameFirst: path.join(firstFolder, '같은 이름.md'),
  sameSecond: path.join(secondFolder, '같은 이름.md'),
  cleanWatch: path.join(secondFolder, '외부 변경 문서.md'),
  dirtyWatch: path.join(secondFolder, '편집 중인 문서.md'),
  closeSaved: path.join(firstFolder, '저장하고 닫을 문서.md'),
  closeDiscarded: path.join(firstFolder, '저장하지 않을 문서.md'),
  saveAllFirst: path.join(firstFolder, '종료 저장 A.md'),
  saveAllSecond: path.join(secondFolder, '종료 저장 B.md'),
};
const initial = Object.fromEntries(Object.entries(paths).map(([key]) => [key, `# ${key}\n\n원래 내용\n`]));
await mkdir(firstFolder, { recursive: true });
await mkdir(secondFolder, { recursive: true });
for (const [key, filePath] of Object.entries(paths)) await writeFile(filePath, initial[key], 'utf8');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let application;
let page;
let cdp;
const results = [];
const errors = [];

async function eventually(callback, description, timeout = 15_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try { return await callback(); } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${description}: ${lastError?.message || 'timed out'}`, { cause: lastError });
}

async function run(name, callback) {
  await callback();
  results.push(name);
  console.log(`PASS ${name}`);
}

function tab(filePath) {
  return page.getByTestId('document-tab').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`));
}

function tabClose(filePath) {
  return page.getByTestId('tab-close').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`));
}

function treeItem(filePath) {
  return page.getByTestId('tree-item').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`));
}

async function expectActive(filePath) {
  await eventually(async () => {
    assert.equal(await tab(filePath).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByTestId('document-title').getAttribute('title'), filePath);
  }, `Active tab ${path.basename(filePath)}`);
}

async function activate(filePath) {
  await tab(filePath).click();
  await expectActive(filePath);
}

async function chooseFiles(filePaths) {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.__lastPickerProperties = options.properties;
      return { canceled: false, filePaths: selected };
    };
  }, filePaths);
  await page.getByTestId('file-open').click();
  for (const filePath of filePaths) await tab(filePath).waitFor({ state: 'visible' });
  await expectActive(filePaths.at(-1));
}

async function chooseFolder(folderPath) {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, folderPath);
  await page.getByTestId('folder-open').click();
  await eventually(async () => assert.equal((await page.evaluate(() => window.desktop.getInitialState())).root.path, folderPath), 'Selected folder is stored');
}

async function edit(content) {
  if (await page.getByTestId('edit-button').isVisible()) await page.getByTestId('edit-button').click();
  const editor = page.locator('.cm-content:visible');
  await editor.click();
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.insertText(content);
  await eventually(async () => assert.ok((await editor.innerText()).includes(content.trimEnd().split('\n').at(-1))), 'Edited text is retained');
}

async function closeTab(filePath, decision) {
  await tabClose(filePath).click();
  if (decision) await page.getByRole('button', { name: decision, exact: true }).click();
  if (decision !== '취소') await tab(filePath).waitFor({ state: 'detached' });
}

async function dropFiles(filePaths) {
  await page.evaluate(() => {
    document.getElementById('qa-tabs-file-input')?.remove();
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.hidden = true; input.id = 'qa-tabs-file-input';
    document.body.appendChild(input);
  });
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#qa-tabs-file-input' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: filePaths });
  assert.deepEqual(await page.evaluate(() => window.desktop.getDroppedPaths(Array.from(document.getElementById('qa-tabs-file-input').files))), filePaths);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    for (const file of document.getElementById('qa-tabs-file-input').files) transfer.items.add(file);
    document.querySelector('.application').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  for (const filePath of filePaths) await tab(filePath).waitFor({ state: 'visible' });
}

async function nativeClose(response, quit = false) {
  await application.evaluate(({ app, BrowserWindow, dialog }, { answer, quitApplication }) => {
    globalThis.__closePrompts = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.__closePrompts.push(options);
      return { response: answer, checkboxChecked: false };
    };
    if (quitApplication) app.quit();
    else BrowserWindow.getAllWindows()[0].close();
  }, { answer: response, quitApplication: quit });
}

async function menuAction(label, accelerator) {
  // CDP key events bypass the macOS application menu. Exercise the registered
  // native MenuItem and its shortcut binding together; editor keys still use CDP.
  const actual = await application.evaluate(({ Menu }, itemLabel) => {
    const find = menu => {
      for (const item of menu.items) {
        if (item.label === itemLabel) return item;
        if (item.submenu) { const match = find(item.submenu); if (match) return match; }
      }
    };
    const item = find(Menu.getApplicationMenu());
    if (!item) throw new Error(`Missing native menu item: ${itemLabel}`);
    item.click();
    return item.accelerator;
  }, label);
  assert.equal(actual, accelerator);
}

async function launch() {
  application = await electron.launch({
    args: ['.', '--user-data-dir', userDataDirectory],
    cwd: projectDirectory,
    env: { ...process.env, MARKDOWN_VIEWER_USER_DATA: userDataDirectory },
    timeout: 30_000,
  });
  await application.evaluate(({ app, clipboard, dialog, shell }) => {
    app.addRecentDocument = () => {};
    clipboard.writeText = () => {};
    shell.openPath = async () => { throw new Error('External apps must not run during tab tests.'); };
    dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  cdp = await page.context().newCDPSession(page);
}

try {
  await launch();

  await run('여러 Markdown 파일 선택과 파일별 탭 표시', async () => {
    await chooseFiles([paths.alpha, paths.beta]);
    assert.equal(await page.getByTestId('document-tabs').getAttribute('role'), 'tablist');
    assert.equal(await page.getByTestId('document-tab').count(), 2);
    assert.ok((await application.evaluate(() => globalThis.__lastPickerProperties)).includes('multiSelections'));
    await activate(paths.alpha);
    assert.equal(await tab(paths.alpha).getAttribute('role'), 'tab');
  });

  await run('동일한 경로는 기존 탭 선택 및 같은 파일명은 전체 경로로 구별', async () => {
    await chooseFiles([paths.alpha]);
    assert.equal(await page.getByTestId('document-tab').count(), 2);
    await chooseFiles([paths.sameFirst, paths.sameSecond]);
    for (const filePath of [paths.sameFirst, paths.sameSecond]) assert.equal(await tab(filePath).getAttribute('title'), filePath);
    assert.equal(await page.getByTestId('document-tab').count(), 4);
  });

  await run('탭 전환 후 편집 내용·커서 위치·실행 취소 유지', async () => {
    await activate(paths.alpha);
    await edit('# alpha\n\n편집 내용\nTAIL');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await activate(paths.beta);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await activate(paths.alpha);
    assert.match(await page.locator('.cm-content:visible').innerText(), /TAIL/);
    await page.locator('.cm-content:visible').focus();
    await page.keyboard.insertText('MID');
    assert.match(await page.locator('.cm-content:visible').innerText(), /TAMIDIL/);
    await page.keyboard.press(`${modifier}+Z`);
    assert.match(await page.locator('.cm-content:visible').innerText(), /TAIL/);
    assert.doesNotMatch(await page.locator('.cm-content:visible').innerText(), /TAMIDIL/);
    await page.keyboard.press(`${modifier}+Z`);
    await eventually(async () => assert.match(await page.locator('.cm-content:visible').innerText(), /원래 내용/), 'Undo history predates tab switch');
    await edit('# alpha\n\n다른 탭에서도 유지할 편집\n');
    assert.equal(await readFile(paths.alpha, 'utf8'), initial.alpha);
  });

  await run('저장은 선택한 탭만 처리하고 다른 탭의 편집 상태 유지', async () => {
    await activate(paths.beta);
    const betaSaved = '# beta\n\n현재 탭만 저장\n';
    await edit(betaSaved);
    await page.getByTestId('save-button').click();
    await eventually(async () => assert.equal(await readFile(paths.beta, 'utf8'), betaSaved), 'Current tab saved');
    assert.equal(await readFile(paths.alpha, 'utf8'), initial.alpha);
    if (process.platform === 'darwin') await eventually(async () => assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited()), true), 'Inactive dirty tab marks the window edited');
    await closeTab(paths.beta);
    await activate(paths.alpha);
    assert.match(await page.locator('.cm-content:visible').innerText(), /다른 탭에서도 유지할 편집/);
  });

  await run('편집 중인 탭 닫기 취소와 파일명 표시', async () => {
    await tabClose(paths.alpha).click();
    const prompt = page.getByRole('dialog');
    await prompt.waitFor();
    assert.match(await prompt.innerText(), /Alpha\.md/);
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await expectActive(paths.alpha);
    assert.match(await page.locator('.cm-content:visible').innerText(), /다른 탭에서도 유지할 편집/);
    assert.equal(await readFile(paths.alpha, 'utf8'), initial.alpha);
  });

  await run('활성 탭을 저장하고 닫기 및 비활성 탭을 저장하지 않고 닫기', async () => {
    await chooseFiles([paths.closeSaved]);
    await activate(paths.closeSaved);
    const content = '# closeSaved\n\n탭 닫기로 저장한 내용\n';
    await edit(content);
    await closeTab(paths.closeSaved, '저장하고 닫기');
    assert.equal(await readFile(paths.closeSaved, 'utf8'), content);
    await chooseFiles([paths.closeDiscarded]);
    await activate(paths.closeDiscarded);
    await edit('# closeDiscarded\n\n저장하지 않을 편집\n');
    await activate(paths.sameFirst);
    await closeTab(paths.closeDiscarded, '저장하지 않고 닫기');
    await expectActive(paths.sameFirst);
    assert.equal(await readFile(paths.closeDiscarded, 'utf8'), initial.closeDiscarded);
  });

  await run('이전 저장 완료가 다른 문서의 닫기 확인창을 닫지 않음', async () => {
    await chooseFiles([paths.closeSaved, paths.closeDiscarded]);
    await activate(paths.closeSaved);
    const delayedContent = '# closeSaved\n\n지연된 저장 완료\n';
    await edit(delayedContent);
    await activate(paths.closeDiscarded);
    await edit('# closeDiscarded\n\n두 번째 확인창에서 유지할 내용\n');
    await activate(paths.closeSaved);
    await application.evaluate(({ ipcMain }, delayedPath) => {
      const original = ipcMain._invokeHandlers.get('files:save-file');
      globalThis.__originalSaveHandler = original;
      globalThis.__delayedSaveReady = false;
      ipcMain.removeHandler('files:save-file');
      ipcMain.handle('files:save-file', async (...args) => {
        if (args[1] === delayedPath) await new Promise(resolve => {
          globalThis.__delayedSaveReady = true;
          globalThis.__releaseDelayedSave = resolve;
        });
        return original(...args);
      });
    }, paths.closeSaved);
    try {
      await tabClose(paths.closeSaved).click();
      await page.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
      await eventually(async () => assert.equal(await application.evaluate(() => globalThis.__delayedSaveReady), true), 'First file save waits in the native handler');
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await tabClose(paths.closeDiscarded).click();
      assert.match(await page.getByRole('dialog').innerText(), /저장하지 않을 문서\.md/);
      await application.evaluate(() => globalThis.__releaseDelayedSave());
      await eventually(async () => {
        assert.equal(await readFile(paths.closeSaved, 'utf8'), delayedContent);
        assert.equal(await tab(paths.closeSaved).locator('.tab-dirty').count(), 0);
      }, 'Earlier save completes while the second confirmation remains pending');
      assert.match(await page.getByRole('dialog').innerText(), /저장하지 않을 문서\.md/);
      assert.equal(await tab(paths.closeSaved).count(), 1);
      assert.equal(await tab(paths.closeDiscarded).count(), 1);
      await page.getByRole('button', { name: '취소', exact: true }).click();
      await activate(paths.closeDiscarded);
      assert.match(await page.locator('.cm-content:visible').innerText(), /두 번째 확인창에서 유지할 내용/);
      assert.equal(await readFile(paths.closeDiscarded, 'utf8'), initial.closeDiscarded);
    } finally {
      await application.evaluate(({ ipcMain }) => {
        globalThis.__releaseDelayedSave?.();
        ipcMain.removeHandler('files:save-file');
        ipcMain.handle('files:save-file', globalThis.__originalSaveHandler);
      });
    }
    await closeTab(paths.closeSaved);
    await closeTab(paths.closeDiscarded, '저장하지 않고 닫기');
  });

  await run('저장 중 실행 취소로 원문으로 돌아가도 탭 닫기 전 확인', async () => {
    await chooseFiles([paths.closeSaved]);
    const original = await readFile(paths.closeSaved, 'utf8');
    const writing = '# closeSaved\n\n저장 중인 변경 내용\n';
    await edit(writing);
    await application.evaluate(({ ipcMain }, delayedPath) => {
      const handler = ipcMain._invokeHandlers.get('files:save-file');
      globalThis.__originalSaveHandler = handler;
      globalThis.__delayedSaveReady = false;
      ipcMain.removeHandler('files:save-file');
      ipcMain.handle('files:save-file', async (...args) => {
        if (args[1] === delayedPath) await new Promise(resolve => {
          globalThis.__delayedSaveReady = true;
          globalThis.__releaseDelayedSave = resolve;
        });
        return handler(...args);
      });
    }, paths.closeSaved);
    try {
      await page.getByTestId('save-button').click();
      await eventually(async () => assert.equal(await application.evaluate(() => globalThis.__delayedSaveReady), true), 'Save is paused before disk access');
      await page.locator('.cm-content:visible').focus();
      await page.keyboard.press(`${modifier}+Z`);
      await eventually(async () => assert.ok((await page.locator('.cm-content:visible').innerText()).includes(original.trimEnd().split('\n').at(-1))), 'Undo restores the original draft during save');
      if (process.platform === 'darwin') assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isDocumentEdited()), true);
      await tabClose(paths.closeSaved).click();
      await page.getByRole('dialog').waitFor({ state: 'visible' });
      assert.match(await page.getByRole('dialog').innerText(), /저장하고 닫을 문서\.md/);
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      await application.evaluate(() => globalThis.__releaseDelayedSave());
      await eventually(async () => {
        assert.equal(await readFile(paths.closeSaved, 'utf8'), writing);
        assert.equal(await page.getByTestId('save-button').isEnabled(), true);
      }, 'Original draft remains dirty after the earlier save finishes');
      assert.ok((await page.locator('.cm-content:visible').innerText()).includes(original.trimEnd().split('\n').at(-1)));
    } finally {
      await application.evaluate(({ ipcMain }) => {
        globalThis.__releaseDelayedSave?.();
        ipcMain.removeHandler('files:save-file');
        ipcMain.handle('files:save-file', globalThis.__originalSaveHandler);
      });
    }
    await page.getByTestId('save-button').click();
    await eventually(async () => assert.equal(await readFile(paths.closeSaved, 'utf8'), original), 'The restored original draft can be saved afterward');
    await closeTab(paths.closeSaved);
  });

  await run('폴더 변경과 여러 파일 드롭에도 열려 있는 편집 탭 유지', async () => {
    const before = await page.getByTestId('document-tab').count();
    await chooseFolder(secondFolder);
    await treeItem(paths.sameSecond).waitFor();
    assert.equal(await page.getByTestId('document-tab').count(), before);
    await dropFiles([paths.cleanWatch, paths.dirtyWatch, paths.alpha]);
    assert.equal(await page.getByTestId('document-tab').count(), before + 2);
    assert.equal(await tab(paths.alpha).count(), 1);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await activate(paths.alpha);
    assert.match(await page.locator('.cm-content:visible').innerText(), /다른 탭에서도 유지할 편집/);
    await closeTab(paths.alpha, '저장하지 않고 닫기');
  });

  await run('탭 전환·닫기 메뉴 동작과 Ctrl+Tab·Cmd/Ctrl+W 단축키 등록', async () => {
    const openPaths = await page.getByTestId('document-tab').evaluateAll(elements => elements.map(element => element.getAttribute('data-path')));
    await activate(openPaths[0]);
    await menuAction('다음 탭', 'Ctrl+Tab');
    await expectActive(openPaths[1]);
    await menuAction('이전 탭', 'Ctrl+Shift+Tab');
    await expectActive(openPaths[0]);
    await menuAction('파일 닫기', 'CmdOrCtrl+W');
    await tab(openPaths[0]).waitFor({ state: 'detached' });
    assert.equal(page.isClosed(), false);
    await expectActive(openPaths[1]);
  });

  await run('비활성 문서의 외부 변경 반영과 편집 중인 문서 충돌 보존', async () => {
    await activate(paths.dirtyWatch);
    await edit('# dirtyWatch\n\n앱에서 편집 중인 내용\n');
    await activate(paths.sameSecond);
    await writeFile(paths.cleanWatch, '# cleanWatch\n\n외부에서 갱신한 내용\n', 'utf8');
    const changed = '# dirtyWatch\n\n외부에서 변경한 원본\n';
    await writeFile(paths.dirtyWatch, changed, 'utf8');
    // Watch callbacks occur while neither changed file is selected.
    await eventually(async () => {
      await activate(paths.cleanWatch);
      assert.match(await page.getByTestId('markdown-preview').innerText(), /외부에서 갱신한 내용/);
    }, 'Clean inactive tab receives external changes');
    await activate(paths.dirtyWatch);
    assert.match(await page.locator('.cm-content:visible').innerText(), /앱에서 편집 중인 내용/);
    assert.doesNotMatch(await page.locator('.cm-content:visible').innerText(), /외부에서 변경한 원본/);
    await page.getByTestId('save-button').click();
    await eventually(async () => assert.match(await page.locator('body').innerText(), /다른.*변경|외부.*변경|파일이 변경|FILE_CHANGED/), 'Dirty tab reports external conflict');
    assert.equal(await readFile(paths.dirtyWatch, 'utf8'), changed);
  });

  await run('비활성 탭만 편집 중이어도 창 종료 취소', async () => {
    await activate(paths.sameSecond);
    await nativeClose(2, true);
    await eventually(async () => assert.equal((await application.evaluate(() => globalThis.__closePrompts)).length, 1), 'Inactive dirty tab triggers native prompt');
    assert.equal(page.isClosed(), false);
    await expectActive(paths.sameSecond);
    await activate(paths.dirtyWatch);
    assert.match(await page.locator('.cm-content:visible').innerText(), /앱에서 편집 중인 내용/);
  });

  await run('종료 중 비활성 탭 저장 실패 시 창과 편집 내용 보존', async () => {
    await activate(paths.sameSecond);
    await eventually(async () => assert.equal(await page.getByRole('alert').count(), 0), 'Clean active tab has no previous save error');
    await nativeClose(0, true);
    await eventually(async () => assert.match(await page.locator('body').innerText(), /다른.*변경|외부.*변경|파일이 변경|FILE_CHANGED/), 'Save-all failure is displayed');
    assert.equal(page.isClosed(), false);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    assert.equal(await readFile(paths.dirtyWatch, 'utf8'), '# dirtyWatch\n\n외부에서 변경한 원본\n');
    await activate(paths.dirtyWatch);
    assert.match(await page.locator('.cm-content:visible').innerText(), /앱에서 편집 중인 내용/);
    await closeTab(paths.dirtyWatch, '저장하지 않고 닫기');
  });

  await run('마지막 탭을 닫으면 폴더 트리와 파일 열기 화면 유지', async () => {
    for (const filePath of await page.getByTestId('document-tab').evaluateAll(elements => elements.map(element => element.getAttribute('data-path')))) await closeTab(filePath);
    assert.equal(await page.getByTestId('document-title').count(), 0);
    assert.equal(await page.getByTestId('document-tab').count(), 0);
    assert.equal(await page.getByTestId('file-open').isVisible(), true);
    assert.equal(await page.getByTestId('folder-open').isVisible(), true);
    assert.equal(await treeItem(paths.sameSecond).isVisible(), true);
    await eventually(async () => {
      const state = await page.evaluate(() => window.desktop.getInitialState());
      assert.deepEqual(state.filePaths, []);
      assert.equal(state.filePath, null);
      assert.equal(state.root.path, secondFolder);
    }, 'Closed tabs are removed from native session');
  });

  await run('앱 종료 시 여러 폴더의 편집 문서 모두 저장하고 프로세스 종료', async () => {
    await chooseFiles([paths.saveAllFirst, paths.saveAllSecond]);
    await activate(paths.saveAllFirst);
    await edit('# saveAllFirst\n\n첫 문서 종료 저장\n');
    await activate(paths.saveAllSecond);
    await edit('# saveAllSecond\n\n두 번째 문서 종료 저장\n');
    await eventually(async () => {
      const saved = JSON.parse(await readFile(path.join(userDataDirectory, 'last-session.json'), 'utf8'));
      assert.deepEqual(saved.filePaths, [paths.saveAllFirst, paths.saveAllSecond]);
      assert.equal(saved.filePath, paths.saveAllSecond);
    }, 'Tab session is persisted before closing');
    const windowClosed = page.waitForEvent('close', { timeout: 20_000 });
    const applicationClosed = application.waitForEvent('close', { timeout: 20_000 });
    await nativeClose(0, true);
    await windowClosed;
    await applicationClosed;
    assert.equal(await readFile(paths.saveAllFirst, 'utf8'), '# saveAllFirst\n\n첫 문서 종료 저장\n');
    assert.equal(await readFile(paths.saveAllSecond, 'utf8'), '# saveAllSecond\n\n두 번째 문서 종료 저장\n');
    application = null;
  });

  await run('다시 실행하면 열린 탭과 선택 문서 복원 및 닫은 문서 제외', async () => {
    await launch();
    await tab(paths.saveAllFirst).waitFor({ state: 'visible' });
    await tab(paths.saveAllSecond).waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('document-tab').count(), 2);
    await expectActive(paths.saveAllSecond);
    assert.equal(await tab(paths.alpha).count(), 0);
    assert.equal(await tab(paths.closeSaved).count(), 0);
    await closeTab(paths.saveAllFirst);
    await eventually(async () => {
      const saved = JSON.parse(await readFile(path.join(userDataDirectory, 'last-session.json'), 'utf8'));
      assert.deepEqual(saved.filePaths, [paths.saveAllSecond]);
    }, 'Closing one restored tab updates persisted session');
    await application.close();
    application = null;
    await launch();
    await expectActive(paths.saveAllSecond);
    assert.equal(await page.getByTestId('document-tab').count(), 1);
    assert.equal(await tab(paths.saveAllFirst).count(), 0);
    assert.deepEqual(errors, [], 'No unhandled renderer errors');
  });

  console.log(`PASS ${results.length} tab integration checks`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(temporaryDirectory, 'failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 7000));
  }
  console.error(`Failure artifacts retained: ${temporaryDirectory}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (application) {
    if (process.exitCode) application.process().kill('SIGTERM');
    await application.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }); }).catch(() => {});
    await application.close().catch(() => {});
  }
  if (!process.exitCode) await rm(temporaryDirectory, { recursive: true, force: true });
}
