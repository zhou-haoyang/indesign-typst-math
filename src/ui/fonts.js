/**
 * User-supplied fonts.
 *
 * Typst's own defaults (New Computer Modern, Libertinus, DejaVu Sans Mono) are
 * embedded in the compiler wasm, so this is only about the extra faces someone
 * needs to make maths match a document set in something else. The panel reads
 * the bytes and hands them to the compiler; the webview cannot reach the
 * filesystem itself.
 *
 * Persistent tokens are kept in localStorage so the list survives a restart.
 */
const { localFileSystem, formats } = require("uxp").storage;

const STORAGE_KEY = "indesign-typst.fonts";
const FONT_TYPES = ["otf", "ttf", "ttc", "otc"];

function readTokens() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeTokens(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* non-fatal */ }
}

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    bin += String.fromCharCode.apply(null, view.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function readFont(entry) {
  const data = await entry.read({ format: formats.binary });
  return { name: entry.name, data: bytesToBase64(data) };
}

/** Ask the user for font files and add them to the persisted list. */
async function pick() {
  const entries = await localFileSystem.getFileForOpening({
    allowMultiple: true,
    types: FONT_TYPES,
  });
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
  if (!list.length) return null;

  const tokens = readTokens();
  for (const entry of list) {
    const token = localFileSystem.createPersistentToken
      ? await localFileSystem.createPersistentToken(entry)
      : null;
    tokens.push({ name: entry.name, token });
  }
  writeTokens(tokens);
  return list.map((e) => e.name);
}

/**
 * Load every remembered font's bytes.
 * Entries whose file has moved or been deleted are dropped from the list.
 * @returns {Promise<{fonts: Array<{name, data}>, names: string[], dropped: string[]}>}
 */
async function load() {
  const tokens = readTokens();
  const fonts = [];
  const names = [];
  const dropped = [];
  const kept = [];

  for (const item of tokens) {
    if (!item || !item.token) { dropped.push(item && item.name); continue; }
    try {
      const entry = await localFileSystem.getEntryForPersistentToken(item.token);
      fonts.push(await readFont(entry));
      names.push(item.name);
      kept.push(item);
    } catch {
      dropped.push(item.name);
    }
  }
  if (dropped.length) writeTokens(kept);
  return { fonts, names, dropped: dropped.filter(Boolean) };
}

function clear() {
  writeTokens([]);
}

/**
 * Drop one remembered font, by its position in `names()`.
 * By index rather than by name because the same file name can legitimately
 * appear twice, from two different folders.
 */
function remove(index) {
  const tokens = readTokens();
  if (index < 0 || index >= tokens.length) return false;
  tokens.splice(index, 1);
  writeTokens(tokens);
  return true;
}

function names() {
  return readTokens().map((t) => t.name);
}

module.exports = { pick, load, clear, remove, names };
