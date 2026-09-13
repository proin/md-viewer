import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'markdown-viewer-drop-')));
const userDataDirectory = path.join(temporaryDirectory, 'profile');
const outsideDirectory = path.join(temporaryDirectory, '독립 문서 # 100%');
const folderDirectory = path.join(temporaryDirectory, '드롭 폴더 # 50%');
const nestedDirectory = path.join(folderDirectory, '하위 폴더');
const standalonePath = path.join(outsideDirectory, '한글 문서 # 100%.md');
const droppedPath = path.join(outsideDirectory, '드롭 문서 # 50%.markdown');
const nestedPath = path.join(nestedDirectory, '하위 문서.md');
const unsupportedPath = path.join(outsideDirectory, '실행 파일.command');
const missingPath = path.join(outsideDirectory, '없는 문서.md');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const initialContent = '# 독립 문서\n\n폴더를 열지 않고 선택한 문서입니다.\n';
let savedContent = initialContent;

await mkdir(outsideDirectory, { recursive: true });
await mkdir(nestedDirectory, { recursive: true });
await writeFile(standalonePath, initialContent, 'utf8');
await writeFile(droppedPath, '# 드롭 문서\n\n다른 폴더에 있는 문서입니다.\n', 'utf8');
await writeFile(nestedPath, '# 하위 문서\n\n폴더 드롭으로 연 문서입니다.\n', 'utf8');
await writeFile(unsupportedPath, 'echo "must never run"\n', 'utf8');

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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${description}: ${lastError?.message || 'timed out'}`, { cause: lastError });
}

async function run(name, callback) {
  await callback();
  results.push(name);
  console.log(`PASS ${name}`);
}

async function expectDocument(filePath, heading) {
  await eventually(async () => {
    assert.equal(await page.getByTestId('document-title').getAttribute('title'), filePath);
    assert.equal(await page.getByTestId('markdown-preview').locator('h1').innerText(), heading);
  }, `Document loaded: ${path.basename(filePath)}`);
}

async function chooseFile(filePath) {
  // Only the native picker is stubbed; file authorization, reading, and saving use real IPC.
  await application.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, filePath);
  await page.getByTestId('file-open').click();
}

async function replaceEditor(content) {
  const editor = page.locator('.cm-content:visible');
  await editor.waitFor({ state: 'visible' });
  await editor.click();
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.insertText(content);
  await eventually(async () => {
    assert.ok((await editor.innerText()).includes(content.trimEnd().split('\n').at(-1)));
  }, 'CodeMirror receives all edited text');
}

async function prepareDrop(filePaths) {
  await page.evaluate(() => {
    document.getElementById('qa-file-drop-input')?.remove();
    const input = document.createElement('input');
    input.id = 'qa-file-drop-input';
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    document.body.appendChild(input);
  });
  // CDP creates actual OS-backed File objects, including directory and missing-path drops.
  // A new File([...], name) would not carry an OS path through Electron webUtils.
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#qa-file-drop-input' });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: filePaths });
  assert.deepEqual(await page.evaluate(() => window.desktop.getDroppedPaths(
    Array.from(document.getElementById('qa-file-drop-input').files),
  )), filePaths, 'Preload resolves native File objects to their actual OS paths');
}

async function dispatchDropEvent(type) {
  return page.evaluate((eventType) => {
    const transfer = new DataTransfer();
    for (const file of document.getElementById('qa-file-drop-input').files) transfer.items.add(file);
    const event = new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: transfer });
    return !document.querySelector('.application').dispatchEvent(event);
  }, type);
}

async function dropPaths(filePaths) {
  await prepareDrop(filePaths);
  await dispatchDropEvent('dragenter');
  assert.equal(await dispatchDropEvent('dragover'), true, 'File dragover prevents browser navigation');
  assert.equal(await dispatchDropEvent('drop'), true, 'File drop prevents browser navigation');
}

function treeItem(filePath) {
  return page.getByTestId('tree-item').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`));
}

function tabClose(filePath) {
  return page.getByTestId('tab-close').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`));
}

try {
  application = await electron.launch({
    args: ['.', '--user-data-dir', userDataDirectory],
    cwd: projectDirectory,
    env: { ...process.env, MARKDOWN_VIEWER_USER_DATA: userDataDirectory },
    timeout: 30_000,
  });
  await application.evaluate(({ app, shell }) => {
    app.addRecentDocument = () => {};
    globalThis.__unexpectedOpenPaths = [];
    shell.openPath = async (filePath) => { globalThis.__unexpectedOpenPaths.push(filePath); return ''; };
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  cdp = await page.context().newCDPSession(page);

  await run('폴더 없이 한글·공백·#·% 경로의 Markdown 파일 열기', async () => {
    assert.equal((await page.evaluate(() => window.desktop.getInitialState())).root, null);
    await chooseFile(standalonePath);
    await expectDocument(standalonePath, '독립 문서');
    assert.equal(await page.locator('.cm-editor:visible').count(), 0);
    assert.equal(await page.getByTestId('file-open').count(), 1);
    assert.equal(await page.getByTestId('folder-open').count(), 1);
    assert.equal(await page.getByTestId('file-open').isVisible(), true);
    assert.equal(await page.getByTestId('folder-open').isVisible(), true);
    assert.doesNotMatch(await page.locator('body').innerText(), /파일을 찾을 수 없습니다/);
  });

  await run('독립 파일 편집과 원래 경로에 실제 저장', async () => {
    await page.getByTestId('edit-button').click();
    savedContent += '\n독립 파일에 저장한 문장\n';
    await replaceEditor(savedContent);
    await page.getByTestId('save-button').click();
    await eventually(async () => assert.equal(await readFile(standalonePath, 'utf8'), savedContent), 'Standalone file is saved');
    await page.getByTestId('preview-button').click();
    await expectDocument(standalonePath, '독립 문서');
  });

  await run('사이드바를 접어도 파일·폴더 열기 버튼 표시', async () => {
    await page.getByRole('button', { name: '사이드바 표시 전환', exact: true }).click();
    assert.equal(await page.getByTestId('file-open').isVisible(), true);
    assert.equal(await page.getByTestId('folder-open').isVisible(), true);
    await page.getByRole('button', { name: '사이드바 표시 전환', exact: true }).click();
  });

  await run('파일 드래그 안내 표시와 드래그 취소', async () => {
    await prepareDrop([droppedPath]);
    await dispatchDropEvent('dragenter');
    await page.getByTestId('drop-overlay').waitFor({ state: 'visible' });
    await dispatchDropEvent('dragleave');
    await page.getByTestId('drop-overlay').waitFor({ state: 'hidden' });
    await expectDocument(standalonePath, '독립 문서');
  });

  await run('Markdown 파일 드롭으로 읽기 화면 열기', async () => {
    const originalURL = page.url();
    await dropPaths([droppedPath]);
    await expectDocument(droppedPath, '드롭 문서');
    assert.equal(page.url(), originalURL);
    assert.equal(await page.locator('.cm-editor:visible').count(), 0);
    await page.getByTestId('drop-overlay').waitFor({ state: 'hidden' });
  });

  await run('폴더 드롭과 하위 폴더의 Markdown 파일 열기', async () => {
    await dropPaths([folderDirectory]);
    await treeItem(nestedDirectory).waitFor({ state: 'visible' });
    assert.equal((await page.evaluate(() => window.desktop.getInitialState())).root.path, folderDirectory);
    await treeItem(nestedDirectory).click();
    await treeItem(nestedPath).click();
    await expectDocument(nestedPath, '하위 문서');
  });

  await run('열린 폴더 밖의 Markdown 파일 드롭', async () => {
    await dropPaths([standalonePath]);
    await expectDocument(standalonePath, '독립 문서');
    assert.equal((await page.evaluate(() => window.desktop.getInitialState())).root.path, folderDirectory);
  });

  await run('다른 파일을 드롭해도 편집 내용 유지 및 탭 닫기 취소', async () => {
    await page.getByTestId('edit-button').click();
    await replaceEditor(savedContent + '\n드롭 취소 후 유지할 문장\n');
    await dropPaths([droppedPath]);
    await expectDocument(droppedPath, '드롭 문서');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await dropPaths([standalonePath]);
    await tabClose(standalonePath).click();
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await expectDocument(standalonePath, '독립 문서');
    assert.match(await page.locator('.cm-content:visible').innerText(), /드롭 취소 후 유지할 문장/);
    assert.equal(await readFile(standalonePath, 'utf8'), savedContent);
    assert.equal((await page.evaluate(() => window.desktop.getInitialState())).filePath, standalonePath);
  });

  await run('편집한 탭을 저장하고 닫은 후 파일 드롭', async () => {
    savedContent += '\n드롭 취소 후 유지할 문장\n';
    await tabClose(standalonePath).click();
    await page.getByRole('button', { name: '저장하고 닫기', exact: true }).click();
    await eventually(async () => assert.equal(await tabClose(standalonePath).count(), 0), 'Saved tab closes');
    await dropPaths([droppedPath]);
    await expectDocument(droppedPath, '드롭 문서');
    assert.equal(await readFile(standalonePath, 'utf8'), savedContent);
  });

  await run('폴더 드롭에도 편집 중인 탭 유지 및 저장하지 않고 닫기', async () => {
    const originalContent = await readFile(droppedPath, 'utf8');
    await page.getByTestId('edit-button').click();
    await replaceEditor(originalContent + '\n저장하지 않을 내용\n');
    await dropPaths([folderDirectory]);
    await treeItem(nestedDirectory).waitFor({ state: 'visible' });
    await expectDocument(droppedPath, '드롭 문서');
    assert.match(await page.locator('.cm-content:visible').innerText(), /저장하지 않을 내용/);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await tabClose(droppedPath).click();
    await page.getByRole('button', { name: '저장하지 않고 닫기', exact: true }).click();
    assert.equal(await readFile(droppedPath, 'utf8'), originalContent);
    await dropPaths([standalonePath]);
    await expectDocument(standalonePath, '독립 문서');
  });

  await run('존재하지 않는 파일 드롭 오류와 열린 문서 유지', async () => {
    await dropPaths([missingPath]);
    await eventually(async () => assert.match(await page.getByRole('alert').innerText(), /파일을 찾을 수 없습니다|이동되었거나 삭제되었습니다/), 'Missing-file error is understandable');
    await expectDocument(standalonePath, '독립 문서');
    assert.equal((await page.evaluate(() => window.desktop.getInitialState())).filePath, standalonePath);
  });

  await run('지원하지 않는 실행 파일 드롭 오류와 외부 실행 차단', async () => {
    await dropPaths([unsupportedPath]);
    await eventually(async () => assert.match(await page.getByRole('alert').innerText(), /마크다운|Markdown|지원하지 않는/), 'Unsupported-file message identifies allowed files');
    await expectDocument(standalonePath, '독립 문서');
    assert.deepEqual(await application.evaluate(() => globalThis.__unexpectedOpenPaths), []);
  });

  await run('일반 텍스트 드래그는 파일 드롭으로 처리하지 않음', async () => {
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', '일반 텍스트');
      for (const type of ['dragenter', 'dragover', 'drop']) {
        document.querySelector('.application').dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
    });
    assert.equal(await page.getByTestId('drop-overlay').isVisible(), false);
    await expectDocument(standalonePath, '독립 문서');
    assert.deepEqual(errors, [], 'Renderer has no unhandled errors');
  });

  await run('최근 폴더가 삭제되어도 독립 파일을 다시 표시', async () => {
    await rm(folderDirectory, { recursive: true });
    const priorSession = await page.evaluate(() => window.desktop.getInitialState());
    assert.equal(priorSession.root.path, folderDirectory, 'Native session still refers to the removed folder');
    assert.equal(priorSession.filePath, standalonePath, 'Native session retains the independent file');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectDocument(standalonePath, '독립 문서');
    assert.equal(await page.getByTestId('file-open').isVisible(), true);
    assert.deepEqual(errors, [], 'Missing recent folder does not cause an unhandled renderer error');
  });

  console.log(`PASS ${results.length} file-opening and drop integration checks`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(temporaryDirectory, 'failure.png') }).catch(() => {});
    console.error(`Failure artifacts retained: ${temporaryDirectory}`);
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 6000));
  }
  console.error(error);
  process.exitCode = 1;
} finally {
  if (application) {
    if (process.exitCode) application.process().kill('SIGTERM');
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }).catch(() => {});
    await application.close();
  }
  if (!process.exitCode) await rm(temporaryDirectory, { recursive: true, force: true });
}
