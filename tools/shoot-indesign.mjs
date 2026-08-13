#!/usr/bin/env node
/**
 * Screenshot the running InDesign.
 *
 * The panel's real appearance is the one thing no headless tool can report:
 * tools/render-panel.mjs draws in Chrome, which has none of UXP's widgets, its
 * CSS subset or its layout engine. And the panel's own `getComputedStyle` is
 * not a resolved-value API — it hands back specified values, so `backgroundColor`
 * reads "initial" and every sp-* element reports the same font and colour
 * whether or not the host implements it. Anything about how the panel *looks*
 * therefore has to be measured with an eye.
 *
 *   node tools/shoot-indesign.mjs [label]
 *
 * This cannot reload the plugin: UXP Developer Tools is the only thing that
 * can, and a manifest.json change needs remove-and-re-add rather than Reload.
 * So the sequence is always: edit, reload by hand, then run this.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOTS = join(ROOT, ".ui-shots");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0
      ? resolve(out.trim())
      : reject(new Error(`${command} exited ${code}: ${err.trim() || out.trim()}`))));
  });
}

const label = (process.argv[2] || "panel").replace(/[^\w.-]/g, "-");
await mkdir(SHOTS, { recursive: true });
const file = join(SHOTS, `app-${label}.png`);

try {
  await run("osascript", ["-e", 'tell application "Adobe InDesign 2026" to activate']);
} catch (err) {
  console.error(`Could not bring InDesign forward: ${err.message}`);
  console.error("Is it running, and is it named \"Adobe InDesign 2026\"?");
  process.exit(1);
}
// A moment for the window to come forward; without it the shot catches
// whatever was on top before.
await new Promise((r) => setTimeout(r, 900));

// -x silences the shutter, -o drops the window shadow. Full screen rather than
// a window id: the panel is docked inside the application window, so there is
// no separate window to target.
await run("screencapture", ["-x", "-o", file]);
console.log(file);
