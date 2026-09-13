const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { fileURLToPath } = require('node:url');

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
]);
const EXTERNAL_FILE_EXTENSIONS = new Set([...MARKDOWN_EXTENSIONS, ...IMAGE_TYPES.keys(), '.pdf', '.txt', '.csv', '.json']);
const MAX_MARKDOWN_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

function fail(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function absolutePath(value) {
  if (typeof value === 'string' && /^file:/i.test(value)) {
    try { value = fileURLToPath(value); }
    catch { throw fail('INVALID_PATH', '올바른 파일 경로가 필요합니다.'); }
  }
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw fail('INVALID_PATH', '올바른 파일 경로가 필요합니다.');
  }
  return path.resolve(value);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isMarkdown(value) {
  return MARKDOWN_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function canOpenDefault(value) {
  return EXTERNAL_FILE_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function versionOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

class FileAccess {
  constructor() {
    this.roots = new Set();
    this.files = new Set();
    this.assetRoots = new Set();
    this.saveQueues = new Map();
  }

  async openFile(value) {
    return (await this.openFiles([value]))[0];
  }

  async openFiles(values) {
    // Validate the complete document before changing the active access grants.
    const selection = new FileAccess();
    const documents = [];
    for (const value of values) {
      const canonical = await selection.authorizeFile(value);
      if (!documents.some(document => document.path === canonical)) documents.push(await selection.readFile(canonical));
    }
    for (const document of documents) {
      this.files.add(document.path);
      this.assetRoots.add(path.dirname(document.path));
    }
    return documents;
  }

  async openPath(value) {
    const canonical = await fs.realpath(absolutePath(value));
    if ((await fs.stat(canonical)).isDirectory()) {
      const selection = new FileAccess();
      const root = await selection.authorizeRoot(canonical);
      await selection.readDirectory(root.path);
      this.roots.add(root.path);
      return { kind: 'directory', root };
    }
    return { kind: 'markdown', file: await this.openFile(canonical) };
  }

  async authorizeRoot(value) {
    const canonical = await fs.realpath(absolutePath(value));
    if (!(await fs.stat(canonical)).isDirectory()) throw fail('NOT_DIRECTORY', '폴더를 선택해 주십시오.');
    this.roots.add(canonical);
    return { path: canonical, name: path.basename(canonical) || canonical };
  }

  async authorizeFile(value) {
    const canonical = await fs.realpath(absolutePath(value));
    if (!isMarkdown(canonical)) throw fail('NOT_MARKDOWN', '마크다운 파일을 선택해 주십시오.');
    if (!(await fs.stat(canonical)).isFile()) throw fail('NOT_FILE', '파일을 선택해 주십시오.');
    this.files.add(canonical);
    this.assetRoots.add(path.dirname(canonical));
    return canonical;
  }

  allows(value, kind) {
    if ([...this.roots].some(root => isInside(root, value))) return true;
    if (kind === 'file') return this.files.has(value);
    if (kind === 'asset') return [...this.assetRoots].some(root => isInside(root, value));
    return false;
  }

  async resolveAuthorized(value, kind = 'file') {
    const requested = absolutePath(value);
    // Finder paths may use a different Unicode form or a filesystem alias.
    // Check access against the real path so those forms refer to the same file.
    const canonical = await fs.realpath(requested);
    if (!this.allows(canonical, kind)) throw fail('ACCESS_DENIED', '파일 또는 해당 폴더를 먼저 열어 주십시오.');
    return canonical;
  }

  async readDirectory(value) {
    const directory = await this.resolveAuthorized(value, 'directory');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .map(entry => ({
        name: entry.name,
        path: path.join(directory, entry.name),
        kind: entry.isDirectory() ? 'directory' : isMarkdown(entry.name) ? 'markdown' : 'file',
      }))
      .sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1)
        || a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' }));
  }

  async readFile(value) {
    const canonical = await this.resolveAuthorized(value);
    if (!isMarkdown(canonical)) throw fail('NOT_MARKDOWN', '마크다운 파일만 열 수 있습니다.');
    const handle = await fs.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw fail('NOT_FILE', '파일을 선택해 주십시오.');
      if (stat.size > MAX_MARKDOWN_BYTES) throw fail('FILE_TOO_LARGE', '20MB 이하의 마크다운 파일을 열 수 있습니다.');
      const buffer = await handle.readFile();
      let content;
      try {
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
      } catch {
        throw fail('INVALID_ENCODING', 'UTF-8로 저장된 마크다운 파일만 열 수 있습니다.');
      }
      return { path: canonical, name: path.basename(canonical), content, version: versionOf(buffer), modifiedAt: stat.mtimeMs };
    } finally {
      await handle.close();
    }
  }

  async saveFile(value, content, expectedVersion) {
    const canonical = await this.resolveAuthorized(value);
    if (!isMarkdown(canonical)) throw fail('NOT_MARKDOWN', '마크다운 파일만 저장할 수 있습니다.');
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES) {
      throw fail('INVALID_CONTENT', '저장할 내용은 20MB 이하여야 합니다.');
    }
    if (typeof expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(expectedVersion)) {
      throw fail('FILE_CHANGED', '파일을 다시 연 다음 저장해 주십시오.');
    }
    const previous = this.saveQueues.get(canonical) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.writeFile(canonical, content, expectedVersion));
    this.saveQueues.set(canonical, operation);
    try {
      return await operation;
    } finally {
      if (this.saveQueues.get(canonical) === operation) this.saveQueues.delete(canonical);
    }
  }

  async writeFile(canonical, content, expectedVersion) {
    const current = await this.readFile(canonical);
    if (current.version !== expectedVersion) throw fail('FILE_CHANGED', '다른 프로그램에서 파일이 변경되었습니다. 파일을 다시 열어 주십시오.');
    const output = current.content.startsWith('\uFEFF') && !content.startsWith('\uFEFF') ? `\uFEFF${content}` : content;
    const stat = await fs.stat(canonical);
    const temporary = path.join(path.dirname(canonical), `.${path.basename(canonical)}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', stat.mode & 0o777);
      await handle.chmod(stat.mode & 0o777);
      await handle.writeFile(output, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      const fresh = await this.readFile(canonical);
      if (fresh.version !== expectedVersion) throw fail('FILE_CHANGED', '저장 중 원본 파일이 변경되었습니다. 파일을 다시 열어 주십시오.');
      await this.resolveAuthorized(canonical);
      await fs.rename(temporary, canonical);
      return await this.readFile(canonical);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }

  async readImage(value) {
    const canonical = await this.resolveAuthorized(value, 'asset');
    const mimeType = IMAGE_TYPES.get(path.extname(canonical).toLowerCase());
    if (!mimeType) throw fail('UNSUPPORTED_IMAGE', '지원하지 않는 이미지 형식입니다.');
    const handle = await fs.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw fail('IMAGE_TOO_LARGE', '이미지를 표시할 수 없습니다.');
      return { bytes: await handle.readFile(), mimeType };
    } finally {
      await handle.close();
    }
  }
}

module.exports = { FileAccess, absolutePath, isInside, isMarkdown, canOpenDefault, MARKDOWN_EXTENSIONS, IMAGE_TYPES };
