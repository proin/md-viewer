const path = require('node:path');
const { absolutePath, isInside, isMarkdown } = require('./files.cjs');

function savedFilePaths(saved) {
  // An explicitly empty list means the user closed every document.
  const values = Array.isArray(saved.filePaths) ? saved.filePaths : [saved.filePath];
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
}

function watchLocations(state) {
  const locations = new Map();
  if (state.root) locations.set(state.root.path, true);
  for (const filePath of state.filePaths) {
    if (!state.root || !isInside(state.root.path, filePath)) locations.set(path.dirname(filePath), false);
  }
  return locations;
}

async function validateSession(access, currentPaths, selection) {
  if (!selection || !Array.isArray(selection.paths) ||
    !selection.paths.every(value => typeof value === 'string') ||
    (selection.activePath !== null && typeof selection.activePath !== 'string')) {
    throw new Error('열린 파일 목록이 올바르지 않습니다.');
  }
  const knownPaths = new Set(currentPaths);
  const canonicalPaths = new Map();
  for (const value of selection.paths) {
    const requested = absolutePath(value);
    if (!isMarkdown(requested)) throw new Error('마크다운 파일만 열 수 있습니다.');
    // A deleted document may still have an unsaved editor. Retaining an already
    // opened path grants no additional access and lets the other tabs close.
    const canonical = knownPaths.has(requested) ? requested : (await access.readFile(requested)).path;
    canonicalPaths.set(value, canonical);
  }
  const filePaths = [...new Set(canonicalPaths.values())];
  const filePath = selection.activePath === null ? null : canonicalPaths.get(selection.activePath);
  if (filePath === undefined || (filePaths.length === 0 && filePath !== null)) {
    throw new Error('선택한 파일이 열린 파일 목록에 없습니다.');
  }
  return { filePaths, filePath };
}

module.exports = { savedFilePaths, watchLocations, validateSession };
