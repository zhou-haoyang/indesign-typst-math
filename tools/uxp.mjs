/**
 * Run a UXP script inside the live InDesign, from the shell.
 *
 * This is the one channel that can exercise the plugin's *actual* modules:
 * a `.idjs` UXP script shares the plugin's module system, so it can
 * `require("./src/id/insert.js")` and call the real code, rather than a test
 * reimplementing the logic and proving only that the reimplementation works.
 *
 * The route is osascript -> ExtendScript -> app.doScript(..., UXPSCRIPT),
 * because AppleScript's own `do script` refuses a .idjs directly
 * ("Incompatible or unsupported scripting language").
 *
 * The driver file must sit in the plugin root for its relative requires to
 * resolve, so it is written there and removed afterwards.
 */
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { idRaw } from "./id.mjs";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let runCounter = 0;

/**
 * @param {string} source  UXP script source. Must end by calling
 *   `require("uxp").script.setResult(JSON.stringify(...))`.
 * @returns {Promise<any>} the parsed result
 */
export async function runUxp(source, prefix = ".uxp-driver", attempts = 3) {
  // Long drivers intermittently start with `app` undefined — the module is
  // there, the property is not, and a moment later it is. Not understood, so it
  // is retried rather than papered over in the driver; a real failure still
  // surfaces after three goes. Note the driver catches its own errors and
  // *returns* them, so the transient has to be detected in the payload too.
  const transient = (text) => /reading 'documents'|app is not defined/.test(String(text));
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await runOnce(source, prefix);
      if (!result || !transient(result.fatal)) return result;
      last = new Error(String(result.fatal));
    } catch (err) {
      if (!transient(err.message)) throw err;
      last = err;
    }
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw last;
}

async function runOnce(source, prefix) {
  // A unique filename per run: UXP caches modules by resolved path, so reusing
  // one name serves a stale driver after every edit — which looks like a
  // baffling intermittent failure rather than a cache.
  const file = join(ROOT, `${prefix}-${process.pid}-${runCounter++}.idjs`);
  await writeFile(file, source);
  try {
    const raw = await idRaw(`
      var out;
      try { out = app.doScript(File(${JSON.stringify(file)}), ScriptLanguage.UXPSCRIPT); }
      catch (e) { out = JSON.stringify({ __hostError: String(e.message || e) }); }
      String(out);
    `);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`UXP script did not return JSON:\n${raw}`);
    }
    if (parsed && parsed.__hostError) {
      throw new Error(`InDesign refused the UXP script: ${parsed.__hostError}`);
    }
    return parsed;
  } finally {
    if (!process.env.IDT_KEEP_DRIVER) await rm(file, { force: true });
  }
}

/**
 * Boilerplate for a driver: collects results, reports thrown errors with a
 * stack rather than losing them, and always calls setResult.
 */
export function driver(body) {
  return `
const script = require("uxp").script;
function main() {
${body}
}
let payload;
try {
  payload = main();
} catch (e) {
  payload = { fatal: String((e && e.message) || e), stack: String((e && e.stack) || "") };
}
script.setResult(JSON.stringify(payload));
`;
}
