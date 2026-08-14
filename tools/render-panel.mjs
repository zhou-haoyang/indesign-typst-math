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
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(args[at + 1]);
};
const WIDTH = flag("width", 420);
// Height matters as much as width now that the panel and the dialog both share
// their spare height out rather than pooling it. Cropping a tall shot is not
// the same picture: the flex shares are computed from the viewport, so a
// 720-tall layout cropped to 520 shows proportions no user will ever see.
// Worth checking: the panel at its 320 manifest minimum, and the dialog at the
// 520 and 360 that showSettings asks for.
const HEIGHT = flag("height", 720);

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
<link rel="stylesheet" href="vendor/spectrum-theme.css">
<link rel="stylesheet" href="src/ui/panel.css">
<style>
  /* Stand in for InDesign's dark panel chrome, so contrast is judged fairly.
     The explicit width matters: --window-size sets the screenshot canvas but
     not the layout viewport, so without it the page lays out wide and the
     screenshot merely *crops*, which reads as right-aligned controls having
     vanished. */
  /* #535353 is InDesign's actual chrome at uiBrightnessPreference 0.5,
     measured off a screenshot rather than guessed. The text colour is NOT set
     here: panel.css takes it from --ui-text, and letting the real token show is
     the point of loading the generated stylesheet above. */
  body { background: #535353; width: ${WIDTH}px; margin: 0; }
  webview { background: #fff; display: block; }
  /* Chrome has no sp-* widgets, so they come out as empty inline elements.
     These stand-ins keep the shots readable and say nothing whatever about
     how the real components look. The sizes are the ones measured in UXP
     (label 25px tall, detail 16, textarea per the panel), so at least the
     vertical rhythm here is not a fiction. */
  sp-textarea {
    background: #2b2b2b; color: #eee; border: 1px solid #777; border-radius: 4px;
    box-sizing: border-box; padding: 6px; font-size: 11px;
  }
  sp-textarea::after { content: attr(placeholder); color: #999; }
  /* Deliberately NOT inheriting: the real widgets ignore an inherited colour,
     so a stand-in that inherited would hide the one trap that matters. */
  sp-label { color: #d1d1d1; font-size: 11px; line-height: 25px; }
  sp-detail { color: #ebebeb; font-size: 11px; font-weight: bold; line-height: 16px; }
  sp-divider { display: block; height: 1px; background: #707070; }
  textarea, select, input, button { font-size: 11px; }
  ${variant === "dialog"
    // Two overrides, both standing in for the host rather than restyling:
    //   - Chrome's UA rule `dialog:not([open])` is display:none and outranks a
    //     bare `dialog` selector, so the flex column panel.css sets has to be
    //     restated here. Using `display: block` instead would silently defeat
    //     the pinned footer and the shot would show it floating mid-dialog.
    //   - Chrome paints a <dialog> white; UXP gives it the host chrome, so
    //     without this the dark-theme stand-ins sit on white and the section
    //     titles read as unreadable when they are fine in the app.
    ? `html, body { height: 100%; }
       dialog { display: flex; position: static; height: 100%;
                background: #535353; color: var(--ui-text); }`
    : ""}
</style></head><body class="spectrum spectrum--medium spectrum--dark theme-dark">
<script>
  window.__variant = ${JSON.stringify(variant)};
  window.__preamble = ${preamble};
</script>
</body></html>`;
}

/** Pull the panel or the dialog out of the real index.html, so this cannot drift. */
async function build(variant) {
  const html = await (await import("node:fs/promises")).readFile(join(ROOT, "index.html"), "utf8");

  // Match the opening tag rather than splitting on the literal "<body>": a
  // comment in <head> that merely mentioned the tag used to capture the split,
  // leaving an empty extract and three screenshots of blank chrome — with no
  // error, because every step downstream is happy to slice an empty string.
  const open = /<body[^>]*>/.exec(html);
  const close = html.lastIndexOf("</body>");
  if (!open || close < 0) throw new Error("index.html: could not find the body element");
  const body = html.slice(open.index + open[0].length, close)
    .replace(/<script[\s\S]*?<\/script>/g, "");
  if (!body.trim()) throw new Error("index.html: body extracted empty");

  let content = body;
  if (variant === "dialog") {
    // The first <dialog>, whichever id it currently carries — the id changes
    // whenever the dialog is resized, since UXP remembers geometry against it.
    const start = content.indexOf("<dialog");
    if (start < 0) throw new Error("index.html: no <dialog> to extract");
    const end = content.indexOf("</dialog>", start) + "</dialog>".length;
    content = content.slice(start, end);
  } else {
    // Only the panel, with the dialogs dropped.
    const start = content.indexOf("<dialog");
    if (start < 0) throw new Error("index.html: no <dialog> marking the end of the panel");
    content = content.slice(0, start);
    if (variant === "preamble") {
      // What the view does on a tab switch, by hand: the active tab, the
      // preamble's buttons, and which of the two stacked editors is on stage.
      content = content
        .replace('id="tab-equation" class="tab active"', 'id="tab-equation" class="tab"')
        .replace('id="tab-preamble" class="tab"', 'id="tab-preamble" class="tab active"')
        .replace('id="preamble-actions" class="row hidden"', 'id="preamble-actions" class="row"')
        .replace('id="editor" placeholder', 'id="editor" class="offstage" placeholder')
        .replace('id="preamble-editor" class="offstage"', 'id="preamble-editor"');
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
