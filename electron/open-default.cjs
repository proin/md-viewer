const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const execute = promisify(execFile);
const applicationInfoScript = `
ObjC.import('AppKit');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const application = argv[1] === 'application' ? url : $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL(url);
  if (!application || application.isNil()) return '';
  const bundle = $.NSBundle.bundleWithURL(application);
  return JSON.stringify({ path: application.path.js, bundleIdentifier: bundle.bundleIdentifier.js || '' });
}`;

async function applicationInfo(filePath, kind, runner = execute) {
  const { stdout } = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', applicationInfoScript, filePath, kind], { timeout: 5000, maxBuffer: 16 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function isThisApp(info, appId, executable = process.execPath) {
  if (!info) return false;
  return info.bundleIdentifier === appId || path.resolve(info.path) === path.resolve(path.dirname(executable), '../..');
}

async function openDocument(filePath, options) {
  const { shell, dialog, window, appId, platform = process.platform, runner = execute, inspectApplication = applicationInfo } = options;
  if (platform === 'darwin') {
    const defaultApp = await inspectApplication(filePath, 'document', runner);
    if (isThisApp(defaultApp, appId)) {
      const choice = await dialog.showOpenDialog(window, {
        title: '다른 앱으로 열기', buttonLabel: '이 앱으로 열기',
        message: 'Markdown Viewer가 기본 앱으로 지정되어 있습니다. 파일을 열 다른 앱을 선택해 주십시오.',
        defaultPath: '/Applications', properties: ['openFile'], filters: [{ name: '응용 프로그램', extensions: ['app'] }],
      });
      if (choice.canceled || !choice.filePaths[0]) return;
      const selected = await fs.realpath(choice.filePaths[0]);
      if (path.extname(selected).toLowerCase() !== '.app' || !(await fs.stat(selected)).isDirectory()) throw new Error('응용 프로그램을 선택해 주십시오.');
      const selectedApp = await inspectApplication(selected, 'application', runner);
      if (!selectedApp?.bundleIdentifier || isThisApp(selectedApp, appId)) throw new Error('Markdown Viewer 이외의 앱을 선택해 주십시오.');
      await runner('/usr/bin/open', ['-a', selected, '--', filePath], { timeout: 5000 });
      return;
    }
  }
  const error = await shell.openPath(filePath);
  if (error) throw new Error(error);
}

module.exports = { applicationInfo, isThisApp, openDocument };
