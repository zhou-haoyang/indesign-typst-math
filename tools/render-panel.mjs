#!/usr/bin/env node
/**
 * Screenshot the panel's markup in headless Chrome.
 *
 * **This is not a test of the panel.** UXP has its own layout engine, its own
 * CSS subset and native form controls, and the differences are exactly where
 * this plugin's UI bugs have come from: `gap` that works here and collapses
 * there, a <button> that ignores `background` and draws a native pill, a
 * <textarea> in a hidden subtree that never becomes editable. Chrome will show
 * none of those.
 *
 * What it *is* good for is the class of mistake that is mine rather than UXP's:
 * elements in the wrong order, a section that never closes, a control with no
 * label, text that overflows its box. Catching those here costs seconds instead
 * of a plugin reload.
 *
 *   node tools/render-panel.mjs                 # both states + the dialog
 *   node tools/render-panel.mjs --width 340     # at the docked width
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = join(ROOT, ".ui-shots");

const args = process.argv.slice(2);
const widthArg = args.indexOf("--width");
const WIDTH = widthArg === -1 ? 420 : Number(args[widthArg + 1]);
const HEIGHT = 720;

if (!existsSync(CHROME)) {
  console.error(`no Chrome at ${CHROME}; skipping.`);
  process.exit(0);
}

/**
 * The panel's index.html, with the pieces UXP supplies replaced by stand-ins:
 * the <webview> becomes a plain box, and the dialog is laid out inline rather
 * than shown modally (headless Chrome will not paint a modal into a
 * screenshot).
 */
function page(variant) {
  const preamble = variant === "preamble";
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="src/ui/panel.css">
<style>
  /* Stand in for InDesign's dark panel chrome, so contrast is judged fairly.
     The explicit width matters: --window-size sets the screenshot canvas but
     not the layout viewport, so without it the page lays out wide and the
     screenshot merely *crops*, which reads as right-aligned controls having
     vanished. */
  /* The near-white text colour is not decoration: it is what the panel
     inherits from UXP on the dark theme, and it is why the caret needed
     pinning down. */
  body { background: #4a4a4a; color: #f0f0f0; width: ${WIDTH}px; margin: 0; }
  webview { background: #fff; display: block; }
  /* Chrome has no sp-* widgets, so they come out as empty inline elements.
     These stand-ins keep the shots readable and say nothing whatever about
     how the real components look. */
  sp-textarea {
    background: #2b2b2b; color: #eee; border: 1px solid #777; border-radius: 4px;
    box-sizing: border-box; padding: 6px; font-size: 11px;
  }
  sp-textarea::after { content: attr(placeholder); color: #999; }
  textarea, select, input, button { font-size: 11px; }
  ${variant === "dialog" ? "dialog { display: block; position: static; }" : ""}
</style></head><body class="theme-dark">
<script>
  window.__variant = ${JSON.stringify(variant)};
  window.__preamble = ${preamble};
</script>
</body></html>`;
}

/** Pull the panel or the dialog out of the real index.html, so this cannot drift. */
async function build(variant) {
  const html = await (await import("node:fs/promises")).readFile(join(ROOT, "index.html"), "utf8");
  const body = html.split("<body>")[1].split("</body>")[0].replace(/<script[\s\S]*?<\/script>/g, "");

  let content = body;
  if (variant === "dialog") {
    // The first <dialog>, whichever id it currently carries — the id changes
    // whenever the dialog is resized, since UXP remembers geometry against it.
    const start = content.indexOf("<dialog");
    const end = content.indexOf("</dialog>", start) + "</dialog>".length;
    content = content.slice(start, end);
  } else {
    // Only the panel, with the dialogs dropped.
    content = content.slice(0, content.indexOf("<dialog"));
    if (variant === "preamble") {
      content = content
        .replace('id="tab-equation" class="tab active"', 'id="tab-equation" class="tab"')
        .replace('id="tab-preamble" class="tab"', 'id="tab-preamble" class="tab active"')
        .replace('id="preamble-actions" class="row hidden"', 'id="preamble-actions" class="row"');
    }
  }

  const shell = page(variant).replace("</body>", `${content}</body>`);
  const file = join(ROOT, `.ui-${variant}.html`);
  await writeFile(file, shell);
  return file;
}

async function shoot(variant) {
  const file = await build(variant);
  const profile = await mkdtemp(join(tmpdir(), `idt-ui-${variant}-`));
  const out = join(OUT, `${variant}.png`);
  await new Promise((resolve, reject) => {
    const child = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      // Without a virtual time budget the screenshot mode does not exit.
      "--virtual-time-budget=1500",
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      `--screenshot=${out}`,
      `file://${file}`,
    ], { stdio: "ignore" });
    const kill = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("error", (err) => { clearTimeout(kill); reject(err); });
    child.on("close", () => { clearTimeout(kill); resolve(); });
  });
  await rm(profile, { recursive: true, force: true });
  await rm(file, { force: true });
  return out;
}

await rm(OUT, { recursive: true, force: true });
await (await import("node:fs/promises")).mkdir(OUT, { recursive: true });

for (const variant of ["equation", "preamble", "dialog"]) {
  const out = await shoot(variant);
  console.log(existsSync(out) ? `wrote ${out}` : `FAILED ${variant}`);
}
console.log("\nStructure only — UXP's layout, controls and CSS subset differ.");
