/**
 * Run code inside a live InDesign, from the shell.
 *
 * InDesign's AppleScript `do script` will execute an ExtendScript file and hand
 * back its value, which gives a direct experimental channel into the DOM —
 * enough to answer "does this property exist" and "which way does this move"
 * in seconds instead of by screenshot.
 *
 * Two caveats worth remembering:
 *   - This is ExtendScript, not UXP. Layout behaviour is identical (same
 *     engine), but which *properties are exposed* can differ, so treat property
 *     existence findings as indicative rather than proof for the plugin.
 *   - It drives the user's running InDesign. Every helper here works on its own
 *     scratch document and closes it without saving; never touch app.activeDocument.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Minimal JSON serialiser: ExtendScript has no JSON object. */
const PREAMBLE = `
function J(v){
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t === "number") return isFinite(v) ? String(v) : "null";
  if (t === "boolean") return String(v);
  if (t === "string") return '"' + v.replace(/\\\\/g,"\\\\\\\\").replace(/"/g,'\\\\"').replace(/\\n/g,"\\\\n") + '"';
  if (v instanceof Array) { var a=[]; for (var i=0;i<v.length;i++) a.push(J(v[i])); return "[" + a.join(",") + "]"; }
  var o=[]; for (var k in v) { if (v.hasOwnProperty(k)) o.push(J(String(k)) + ":" + J(v[k])); }
  return "{" + o.join(",") + "}";
}
/** Does reading this property work, and what does it give? */
function probe(fn){ try { var v = fn(); return { ok:true, value: (v===undefined?"undefined":(v===null?"null":String(v))) }; }
                    catch(e){ return { ok:false, error: String(e.message || e) }; } }
`;

/**
 * Execute ExtendScript in InDesign and parse its returned JSON.
 * The snippet's last expression must be a JSON string, e.g. `J({...})`.
 */
export async function idJson(snippet) {
  const text = await idRaw(snippet);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`InDesign did not return JSON:\n${text}`);
  }
}

/** Execute ExtendScript in InDesign and return its value as a string. */
export async function idRaw(snippet) {
  const dir = await mkdtemp(join(tmpdir(), "idt-jsx-"));
  const file = join(dir, "snippet.jsx");
  await writeFile(file, PREAMBLE + "\n" + snippet);
  try {
    const { stdout } = await run("osascript", [
      "-e",
      `tell application id "com.adobe.InDesign" to do script (POSIX file ${JSON.stringify(file)}) language javascript`,
    ], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    const message = (err.stderr || err.message || "").trim();
    throw new Error(`InDesign script failed:\n${message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run a snippet against a throwaway document, then close it without saving.
 *
 * The snippet body can use `doc`, `page`, `frame` (a text frame with `story`
 * text already in it) and must end by returning a JSON string.
 */
export async function inScratchDocument(body, { text = "text text ", pointSize = 12 } = {}) {
  return idJson(`
var result = "null";
var doc = app.documents.add(false);
try {
  doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
  doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
  var page = doc.pages[0];
  var frame = page.textFrames.add();
  frame.geometricBounds = [72, 72, 400, 500];
  frame.contents = ${JSON.stringify(text)};
  frame.parentStory.texts[0].pointSize = ${pointSize};
  result = (function(){
${body}
  })();
} catch (e) {
  result = J({ error: String(e.message || e), line: e.line });
} finally {
  doc.close(SaveOptions.NO);
}
result;
`);
}

/** True if InDesign is running and answering. */
export async function isAvailable() {
  try {
    await idRaw('J({ version: app.version })');
    return true;
  } catch {
    return false;
  }
}
