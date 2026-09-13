import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'markdown-viewer-e2e-')));
const fixtureDirectory = path.join(temporaryDirectory, '문서 모음');
const userDataDirectory = path.join(temporaryDirectory, 'profile');
const readmePath = path.join(fixtureDirectory, '프로젝트 노트.md');
const otherPath = path.join(fixtureDirectory, '다른 문서.md');
const windowsPath = path.join(fixtureDirectory, 'Windows 문서.md');
const bomPath = path.join(fixtureDirectory, 'BOM 문서.md');
const nestedDirectory = path.join(fixtureDirectory, '회의록');
const nestedPath = path.join(nestedDirectory, '첫 회의.md');
const screenshotPath = process.env.MARKDOWN_VIEWER_SCREENSHOT
  || path.join(projectDirectory, 'artifacts', 'screenshots', 'markdown-viewer-preview.png');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

const documentContent = String.raw`# 프로젝트 노트

폴더에서 문서를 찾고, 내용을 읽고, 필요한 부분을 바로 수정합니다.

## 진행 상황

| 기능 | 상태 |
| --- | --- |
| 폴더와 파일 탐색 | 완료 |
| 마크다운 읽기와 편집 | 완료 |
| 파일 저장 | 완료 |

### 작업 목록

- [x] 문서 내용 확인
- [ ] 다음 회의 준비

> 표, 코드, 수식과 다이어그램을 문서 안에서 확인합니다.

## 코드 예제

~~~javascript
const greeting = '안녕하세요';
console.log(greeting);
~~~

## 수식

피타고라스 정리: $a^2 + b^2 = c^2$

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

## 문서 작업 순서

~~~mermaid
flowchart LR
  A[폴더 열기] --> B[문서 읽기]
  B --> C[편집하기]
  C --> D[저장하기]
~~~

## 첨부 자료

![상대 경로 이미지](./images/pixel.png)

[첫 회의](./회의록/첫%20회의.md)
`;

const unsafeContent = String.raw`# HTML 보안 검사

<script>window.__markdownProbe = 'script';</script>
<img src="invalid:image" onerror="window.__markdownProbe = 'onerror'">
<a href="javascript:window.__markdownProbe='link'">위험한 링크</a>
<iframe srcdoc="<script>parent.__markdownProbe='iframe'</script>"></iframe>
<p><strong>일반 HTML 표시</strong></p>
`;

await mkdir(path.join(fixtureDirectory, 'images'), { recursive: true });
await mkdir(nestedDirectory, { recursive: true });
await writeFile(readmePath, documentContent, 'utf8');
await writeFile(otherPath, '# 다른 문서\n\n두 번째 문서입니다.\n', 'utf8');
await writeFile(windowsPath, '# Windows 문서\r\n\r\n원래 내용\r\n', 'utf8');
await writeFile(bomPath, '\uFEFF# BOM 문서\n\n원래 내용\n', 'utf8');
await writeFile(nestedPath, '# 첫 회의\n\n중첩 폴더에 있는 회의록입니다.\n', 'utf8');
const unsafePath = path.join(fixtureDirectory, 'HTML 검사.md');
await writeFile(unsafePath, unsafeContent, 'utf8');
// A local PNG is intentional: it exercises app-protocol image loading, not an HTTP dependency.
await writeFile(path.join(fixtureDirectory, 'images', 'pixel.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1kAAAAASUVORK5CYII=',
  'base64',
));

let application;
let page;
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

function treeItem(filePath) {
  return page.getByTestId('tree-item').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`));
}

function tabClose(filePath) {
  return page.getByTestId('tab-close').and(page.locator(`[data-path=${JSON.stringify(filePath)}]`));
}

async function openDocument(filePath, expectedTitle) {
  await treeItem(filePath).click();
  await eventually(async () => {
    assert.equal(path.basename((await page.getByTestId('document-title').innerText()).trim()), expectedTitle);
  }, `open ${expectedTitle}`);
  await page.getByTestId('markdown-preview').waitFor({ state: 'visible' });
}

async function replaceEditor(content) {
  const editor = page.locator('.cm-content:visible');
  await editor.waitFor({ state: 'visible' });
  await editor.click();
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.insertText(content);
  await eventually(async () => {
    const finalLine = content.trimEnd().split('\n').at(-1);
    assert.ok((await editor.innerText()).includes(finalLine), 'Edited final line is visible');
  }, 'CodeMirror receives edited text');
}

async function expectEditorEnd(pattern) {
  const editor = page.locator('.cm-content:visible');
  await editor.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await eventually(async () => assert.match(await editor.innerText(), pattern), 'The end of the virtualized editor retains edited text');
}

async function dialogButton(name) {
  const button = page.getByRole('button', { name, exact: true });
  await button.waitFor({ state: 'visible' });
  return button;
}

try {
  application = await electron.launch({
    args: ['.', '--folder', fixtureDirectory, '--user-data-dir', userDataDirectory],
    cwd: projectDirectory,
    env: { ...process.env, MARKDOWN_VIEWER_USER_DATA: userDataDirectory },
    timeout: 30_000,
  });
  await application.evaluate(({ app, clipboard, dialog, shell }) => {
    globalThis.__openedPaths = [];
    globalThis.__copiedTexts = [];
    globalThis.__applicationPickers = [];
    shell.openPath = async (filePath) => { globalThis.__openedPaths.push(filePath); return ''; };
    clipboard.writeText = (text) => { globalThis.__copiedTexts.push(text); };
    // Installing the app can make it the .md default. That branch must ask for a
    // different app without opening a native picker during an automated test.
    dialog.showOpenDialog = async (_window, options) => {
      globalThis.__applicationPickers.push({ title: options.title, message: options.message });
      return { canceled: true, filePaths: [] };
    };
    app.addRecentDocument = () => {};
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');

  await run('초기 폴더, 파일 트리, 기본 읽기 화면', async () => {
    await treeItem(readmePath).waitFor({ state: 'visible' });
    await openDocument(readmePath, '프로젝트 노트.md');
    assert.equal(await page.locator('.cm-editor:visible').count(), 0);
    assert.equal(await page.getByTestId('markdown-preview').locator('h1').innerText(), '프로젝트 노트');
    await page.getByTestId('edit-button').waitFor({ state: 'visible' });
  });

  await run('표, 구문 강조, 작업 목록, 수식, Mermaid, 상대 경로 PNG', async () => {
    const preview = page.getByTestId('markdown-preview');
    assert.equal(await preview.locator('table tbody tr').count(), 3);
    assert.equal(await preview.locator('input[type="checkbox"]').count(), 2);
    assert.equal(await preview.locator('input[type="checkbox"]').first().isChecked(), true);
    assert.match(await preview.locator('pre code').first().innerText(), /console\.log\(greeting\)/);
    assert.ok(await preview.locator('pre code span').count() > 0, 'Code syntax has highlight spans');
    await preview.locator('.katex').first().waitFor();
    await preview.locator('.markdown-diagram .diagram-output > svg').first().waitFor({ timeout: 30_000 });
    assert.ok((await preview.locator('.markdown-diagram .diagram-output > svg').first().textContent()).includes('문서 읽기'), 'Mermaid node labels are present');
    await preview.locator('img[alt="상대 경로 이미지"]').scrollIntoViewIfNeeded();
    await eventually(async () => {
      assert.equal(await preview.locator('img[alt="상대 경로 이미지"]').evaluate(
        (image) => image.complete && image.naturalWidth > 0,
      ), true);
    }, 'Relative PNG is decoded');
  });

  await run('코드와 다이어그램의 정확한 복사 및 완료 표시', async () => {
    const preview = page.getByTestId('markdown-preview');
    const codeButton = preview.getByRole('button', { name: '코드 복사', exact: true });
    const code = "const greeting = '안녕하세요';\nconsole.log(greeting);\n";
    await codeButton.click();
    await eventually(async () => {
      assert.deepEqual(await application.evaluate(() => globalThis.__copiedTexts), [code]);
      assert.equal(await codeButton.innerText(), '복사됨');
    }, 'Code is sent to the native clipboard API unchanged');

    const diagramButton = preview.getByRole('button', { name: '다이어그램 코드 복사', exact: true });
    const diagram = 'flowchart LR\n  A[폴더 열기] --> B[문서 읽기]\n  B --> C[편집하기]\n  C --> D[저장하기]\n';
    await diagramButton.click();
    await eventually(async () => {
      assert.deepEqual(await application.evaluate(() => globalThis.__copiedTexts), [code, diagram]);
      assert.equal(await diagramButton.innerText(), '복사됨');
    }, 'Diagram source is copied unchanged');
  });

  await run('중첩 폴더 펼치기와 파일 열기', async () => {
    await treeItem(nestedDirectory).click();
    await openDocument(nestedPath, '첫 회의.md');
    assert.match(await page.getByTestId('markdown-preview').innerText(), /중첩 폴더/);
  });

  await run('파일 검색', async () => {
    const filter = page.getByTestId('file-filter');
    await filter.fill('다른');
    await treeItem(otherPath).waitFor({ state: 'visible' });
    await eventually(async () => { assert.equal(await treeItem(readmePath).isVisible(), false); }, 'Filter hides unmatched root files');
    await filter.fill('');
    await treeItem(readmePath).waitFor({ state: 'visible' });
  });

  let savedContent;
  await run('편집, 저장, 읽기 전환과 실제 파일 저장', async () => {
    await openDocument(readmePath, '프로젝트 노트.md');
    await page.getByTestId('edit-button').click();
    savedContent = documentContent + '\n## 저장 검사\n\n편집한 내용이 파일에 저장되었습니다.\n';
    await replaceEditor(savedContent);
    await page.getByTestId('save-button').click();
    await eventually(async () => { assert.equal(await readFile(readmePath, 'utf8'), savedContent); }, 'Saved bytes match editor');
    await page.getByTestId('preview-button').click();
    await eventually(async () => { assert.match(await page.getByTestId('markdown-preview').innerText(), /편집한 내용이 파일에 저장되었습니다/); }, 'Saved text is rendered');
  });

  await run('저장하지 않은 편집을 탭에 유지하고 닫기 취소·저장하지 않고 닫기', async () => {
    await page.getByTestId('edit-button').click();
    await replaceEditor(savedContent + '\n저장하지 않을 내용\n');
    await treeItem(otherPath).click();
    await eventually(async () => assert.equal((await page.getByTestId('document-title').innerText()).trim(), '다른 문서.md'), 'Opening another file preserves the dirty tab');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await treeItem(readmePath).click();
    await tabClose(readmePath).click();
    await (await dialogButton('취소')).click();
    assert.equal((await page.getByTestId('document-title').innerText()).trim(), '프로젝트 노트.md');
    await expectEditorEnd(/저장하지 않을 내용/);
    await tabClose(readmePath).click();
    await (await dialogButton('저장하지 않고 닫기')).click();
    await eventually(async () => assert.equal(await tabClose(readmePath).count(), 0), 'Discard closes only the selected tab');
    await openDocument(otherPath, '다른 문서.md');
    assert.equal(await readFile(readmePath, 'utf8'), savedContent);
  });

  await run('저장하지 않은 편집: 저장하고 탭 닫기', async () => {
    await openDocument(readmePath, '프로젝트 노트.md');
    await page.getByTestId('edit-button').click();
    savedContent += '\n이동 전에 저장한 내용\n';
    await replaceEditor(savedContent);
    await tabClose(readmePath).click();
    await (await dialogButton('저장하고 닫기')).click();
    await eventually(async () => {
      assert.equal(await tabClose(readmePath).count(), 0);
      assert.equal(await readFile(readmePath, 'utf8'), savedContent);
    }, 'Save-and-close persists file');
    await openDocument(otherPath, '다른 문서.md');
  });

  await run('외부 변경과 저장 충돌 시 원본 보존', async () => {
    await openDocument(readmePath, '프로젝트 노트.md');
    await page.getByTestId('edit-button').click();
    await replaceEditor(savedContent + '\n앱에서 수정한 내용\n');
    const externallyEditedContent = savedContent + '\n외부 프로그램에서 수정한 내용\n';
    await writeFile(readmePath, externallyEditedContent, 'utf8');
    await page.getByTestId('save-button').click();
    await eventually(async () => {
      assert.match(await page.locator('body').innerText(), /다른.*(변경|수정)|외부.*(변경|수정)|충돌|파일이 변경|FILE_CHANGED/);
    }, 'File conflict is reported');
    assert.equal(await readFile(readmePath, 'utf8'), externallyEditedContent);
    assert.match(await page.locator('.cm-content:visible').innerText(), /앱에서 수정한 내용/);
    await tabClose(readmePath).click();
    await (await dialogButton('저장하지 않고 닫기')).click();
    await openDocument(otherPath, '다른 문서.md');
  });

  await run('기본 앱으로 문서 열기 또는 다른 앱 선택', async () => {
    await page.getByTestId('external-open').click();
    await eventually(async () => {
      const { openedPaths, pickers } = await application.evaluate(() => ({
        openedPaths: globalThis.__openedPaths, pickers: globalThis.__applicationPickers,
      }));
      if (pickers.length) {
        assert.deepEqual(openedPaths, []);
        assert.equal(pickers.length, 1);
        assert.equal(pickers[0].title, '다른 앱으로 열기');
        assert.match(pickers[0].message, /Markdown Viewer가 기본 앱/);
      } else {
        assert.deepEqual(openedPaths, [otherPath]);
      }
    }, 'OS opener receives the document or asks for another app when this app is the default');
  });

  await run('편집 전 외부 변경 시 편집기와 미리보기 동기화', async () => {
    await page.getByTestId('edit-button').click();
    const externallyUpdated = '# 다른 문서\n\n외부에서 불러온 새 내용\n';
    await writeFile(otherPath, externallyUpdated, 'utf8');
    await eventually(async () => {
      assert.match(await page.locator('.cm-content:visible').innerText(), /외부에서 불러온 새 내용/);
      assert.match(await page.getByTestId('markdown-preview').innerText(), /외부에서 불러온 새 내용/);
    }, 'Clean editor and preview both reload external changes');
    const editedContent = externallyUpdated + '\n다시 편집한 내용\n';
    await replaceEditor(editedContent);
    await page.getByTestId('save-button').click();
    await eventually(async () => { assert.equal(await readFile(otherPath, 'utf8'), editedContent); }, 'Editing preserves externally reloaded text');
    await page.getByTestId('preview-button').click();
  });

  await run('Windows CRLF 줄바꿈 형식 보존', async () => {
    await openDocument(windowsPath, 'Windows 문서.md');
    await page.getByTestId('edit-button').click();
    await page.locator('.cm-content:visible').click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
    await page.keyboard.insertText('추가한 줄');
    await page.getByTestId('save-button').click();
    await eventually(async () => {
      assert.equal(await readFile(windowsPath, 'utf8'), '# Windows 문서\r\n\r\n원래 내용\r\n추가한 줄');
    }, 'Saved document keeps CRLF line endings');
    await page.getByTestId('preview-button').click();
  });

  await run('UTF-8 BOM 보존과 저장 완료 상태', async () => {
    await openDocument(bomPath, 'BOM 문서.md');
    await page.getByTestId('edit-button').click();
    const editedContent = '# BOM 문서\n\n수정한 내용\n';
    await replaceEditor(editedContent);
    await page.getByTestId('save-button').click();
    await eventually(async () => {
      assert.equal(await readFile(bomPath, 'utf8'), '\uFEFF' + editedContent);
      assert.equal((await page.getByTestId('save-status').innerText()).trim(), '저장됨');
      assert.equal(await page.getByTestId('save-button').isDisabled(), true);
    }, 'BOM is preserved and saved document becomes clean');
    await page.getByTestId('preview-button').click();
  });

  await run('문서 HTML에서 스크립트, 이벤트, iframe 실행 차단', async () => {
    await openDocument(unsafePath, 'HTML 검사.md');
    const preview = page.getByTestId('markdown-preview');
    assert.equal(await preview.locator('script, iframe, [onerror], a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__markdownProbe), undefined);
    assert.equal(await preview.locator('strong').innerText(), '일반 HTML 표시');
  });

  await run('파일 메뉴와 안전한 renderer 설정', async () => {
    const desktopState = await application.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const preferences = window.webContents.getLastWebPreferences();
      const labels = [];
      function collect(menu) {
        if (!menu) return;
        for (const item of menu.items) { labels.push(item.label); collect(item.submenu); }
      }
      collect(Menu.getApplicationMenu());
      return { labels, nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation };
    });
    assert.equal(desktopState.nodeIntegration, false);
    assert.equal(desktopState.contextIsolation, true);
    assert.ok(desktopState.labels.some((label) => /폴더.*열기|Open Folder/.test(label)), 'Folder menu exists');
    assert.ok(desktopState.labels.some((label) => /저장|Save/.test(label)), 'Save menu exists');
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  });

  await run('폴더 열기와 파일 열기 버튼의 선택 결과 반영', async () => {
    await application.evaluate(({ dialog }, paths) => {
      globalThis.__pickerKinds = [];
      dialog.showOpenDialog = async (_window, options) => {
        const folder = options.properties.includes('openDirectory');
        globalThis.__pickerKinds.push(folder ? 'folder' : 'file');
        return { canceled: false, filePaths: [folder ? paths.folder : paths.file] };
      };
    }, { folder: fixtureDirectory, file: readmePath });
    await page.getByTestId('folder-open').click();
    await eventually(async () => {
      assert.deepEqual(await application.evaluate(() => globalThis.__pickerKinds), ['folder']);
    }, 'Folder picker is invoked');
    await treeItem(readmePath).waitFor({ state: 'visible' });
    await page.getByTestId('file-open').click();
    await eventually(async () => {
      assert.equal((await page.getByTestId('document-title').innerText()).trim(), '프로젝트 노트.md');
      assert.deepEqual(await application.evaluate(() => globalThis.__pickerKinds), ['folder', 'file']);
    }, 'File picker selection is opened');
  });

  await run('운영체제의 마크다운 파일 열기 요청', async () => {
    await application.evaluate(({ app }, filePath) => {
      app.emit('open-file', { preventDefault() {} }, filePath);
    }, nestedPath);
    await eventually(async () => {
      assert.equal(path.basename((await page.getByTestId('document-title').innerText()).trim()), '첫 회의.md');
    }, 'OS open-file event selects the requested document');
  });

  await openDocument(readmePath, '프로젝트 노트.md');
  await page.getByTestId('markdown-preview').locator('.markdown-diagram .diagram-output > svg').first().waitFor({ timeout: 30_000 });
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });
  assert.deepEqual(errors, [], 'No renderer page errors');
  console.log(`PASS ${results.length} integration checks`);
  console.log(`Screenshot: ${screenshotPath}`);
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
    // A failed edit assertion must not strand a native unsaved-change prompt.
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }).catch(() => {});
    await application.close();
  }
  if (!process.exitCode) await rm(temporaryDirectory, { recursive: true, force: true });
}
