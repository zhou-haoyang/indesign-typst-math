#!/usr/bin/env node
/**
 * End-to-end geometry test against a live InDesign.
 *
 * Renders real expressions with the Typst CLI, places the resulting PDFs into a
 * scratch document exactly as the plugin does, and checks the whole chain that
 * inline anchoring depends on:
 *
 *   1. the PDF's page box becomes the frame's size   (crop + fit are right)
 *   2. at Y offset 0 the frame's bottom edge sits on the text baseline
 *   3. the offset moves the frame relative to the baseline, and by how much
 *   4. with the offset applied, the maths baseline lands on the text baseline
 *
 * Both a first line and a later line are covered, because they behave
 * differently: on a first line a tall object is pinned and the *baseline* moves
 * instead. That difference is the reason first-row equations were misaligned,
 * and nothing outside InDesign can reproduce it.
 *
 * The scratch document is closed without saving; the open document is untouched.
 *
 *   node tools/test-indesign.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { idJson, isAvailable } from "./id.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TOLERANCE = 0.05; // points

const CASES = [
  { body: "x^2", size: 12 },
  { body: "y = x^2", size: 12 },
  { body: "(d y)/(d x)", size: 12 },          // tall: pins against the frame top
  { body: "sum_(i=1)^n x_i / 2", size: 12 },
  { body: "cases(x &> 0, y &<= 1)", size: 12 },
];

if (!(await isAvailable())) {
  console.error("InDesign is not running, or is not answering AppleScript.");
  console.error("Open InDesign and allow automation, then re-run.");
  process.exit(1);
}

const { buildSource } = await import(join(ROOT, "webview", "template.js"));
const work = await mkdtemp(join(tmpdir(), "idt-e2e-"));

/** Render one expression to PDF and read back its metrics, via the CLI. */
async function render(spec) {
  const src = buildSource({ body: spec.body, mode: "inline", size: spec.size });
  const stem = join(work, spec.body.replace(/\W+/g, "_"));
  const typ = `${stem}.typ`;
  const pdf = `${stem}.pdf`;
  await writeFile(typ, src.source);
  await exec("typst", ["compile", typ, pdf]);
  const out = await exec("typst", ["query", typ, "<idt-metrics>", "--field", "value"]);
  const m = JSON.parse(out)[0];
  return { pdf, width: m.w, height: m.h, depth: m.d };
}

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `${cmd} failed`))));
  });
}

const rendered = [];
for (const spec of CASES) {
  if (!existsSync("/opt/homebrew/bin/typst") && !existsSync("/usr/local/bin/typst")) break;
  rendered.push({ ...spec, ...(await render(spec)) });
}
if (!rendered.length) {
  console.error("the typst CLI is required for this test");
  process.exit(1);
}

// One scratch document, both line positions, all expressions.
const script = `
var result = "null";
var doc = app.documents.add(false);
try {
  doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
  doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
  app.pdfPlacePreferences.pdfCrop = PDFCrop.CROP_MEDIA;
  app.pdfPlacePreferences.transparentBackground = true;

  var page = doc.pages[0];
  var frame = page.textFrames.add();
  frame.geometricBounds = [72, 72, 500, 480];
  frame.contents = "AAAA BBBB CCCC\\rDDDD EEEE FFFF";
  frame.parentStory.texts[0].pointSize = 12;

  var cases = ${JSON.stringify(rendered.map((r) => ({ body: r.body, pdf: r.pdf, w: r.width, h: r.height, d: r.depth })))};
  var out = [];

  function baselineOf(o) { try { return o.parent.baseline; } catch (e) { return null; } }
  function storyOf(o) { try { return o.parent.parentStory; } catch (e) { return null; } }
  function settle(o) { var s = storyOf(o); if (s) s.recompose(); }

  for (var c = 0; c < cases.length; c++) {
    for (var lineIdx = 0; lineIdx < 2; lineIdx++) {
      // Insertion point 2 characters into the chosen line.
      var ipIndex = (lineIdx === 0) ? 2 : 18;
      var ip = frame.parentStory.insertionPoints[ipIndex];
      var placed = ip.place(File(cases[c].pdf))[0];
      var box = placed.parent;

      // Mirrors src/id/frame.js. Stroke weight is alignment-critical, not just
      // cosmetic: InDesign anchors the stroke-inclusive bottom edge, so any
      // weight shifts the equation by half of it, even with colour None. And
      // assigning weight 0 *creates* a 1pt stroke unless the colour is set
      // afterwards — so only touch it when dirty, and finish with the colour.
      var noneSwatch = doc.swatches.itemByName("None");
      if (box.strokeWeight > 0 || String(box.strokeColor.name) !== "None") {
        box.strokeWeight = 0;
        box.strokeColor = noneSwatch;
      }
      box.fit(FitOptions.FRAME_TO_CONTENT);
      var aos = box.anchoredObjectSettings;
      aos.anchoredPosition = AnchorPosition.INLINE_POSITION;

      settle(box);
      var gb = box.geometricBounds;
      var sized = { w: gb[3] - gb[1], h: gb[2] - gb[0] };

      aos.anchorYoffset = 0; settle(box);
      var atZero = box.geometricBounds[2] - baselineOf(box);

      // The plugin solves for this; here we assert the relationship it relies on.
      aos.anchorYoffset = cases[c].d; settle(box);
      var atPlus = box.geometricBounds[2] - baselineOf(box);
      aos.anchorYoffset = -cases[c].d; settle(box);
      var atMinus = box.geometricBounds[2] - baselineOf(box);

      out.push({
        body: cases[c].body, line: lineIdx,
        parent: box.parent.constructor.name,
        wantW: cases[c].w, wantH: cases[c].h, depth: cases[c].d,
        gotW: sized.w, gotH: sized.h, strokeWeight: box.strokeWeight,
        relAtZero: atZero, relAtPlus: atPlus, relAtMinus: atMinus
      });
      box.remove();
    }
  }
  result = J(out);
} catch (e) {
  result = J({ error: String(e.message || e), line: e.line });
} finally {
  doc.close(SaveOptions.NO);
}
result;
`;

const rows = await idJson(script);
await rm(work, { recursive: true, force: true });

if (rows.error) {
  console.error("InDesign script error:", rows.error, "line", rows.line);
  process.exit(1);
}

let failures = 0;
const fail = (msg) => { failures++; console.log(`     ✗ ${msg}`); };
const near = (a, b) => Math.abs(a - b) < TOLERANCE;

for (const r of rows) {
  console.log(`\n[line ${r.line + 1}] ${r.body}  depth ${r.depth.toFixed(2)} pt`);
  console.log(`     frame ${r.gotW.toFixed(2)} × ${r.gotH.toFixed(2)} pt` +
    `   bottom−baseline: at 0 ${r.relAtZero.toFixed(2)}, ` +
    `at +d ${r.relAtPlus.toFixed(2)}, at −d ${r.relAtMinus.toFixed(2)}`);

  if (r.parent !== "Character") fail(`anchored frame's parent is ${r.parent}, not Character`);
  if (r.strokeWeight !== 0) {
    fail(`stroke weight ${r.strokeWeight} shifts anchoring by half of it`);
  }
  if (!near(r.gotW, r.wantW)) fail(`width ${r.gotW.toFixed(2)} but Typst said ${r.wantW.toFixed(2)}`);
  if (!near(r.gotH, r.wantH)) fail(`height ${r.gotH.toFixed(2)} but Typst said ${r.wantH.toFixed(2)}`);
  // The invariant the whole design rests on.
  if (!near(r.relAtZero, 0)) fail(`at offset 0 the frame bottom is ${r.relAtZero.toFixed(2)} pt off the baseline`);
  // Exactly one of the two signs must put the maths baseline on the text baseline.
  const solved = near(r.relAtPlus, r.depth) ? "+" : near(r.relAtMinus, r.depth) ? "−" : null;
  if (!solved) {
    fail(`neither offset aligns: wanted bottom−baseline ${r.depth.toFixed(2)}, ` +
      `got ${r.relAtPlus.toFixed(2)} / ${r.relAtMinus.toFixed(2)}`);
  } else {
    console.log(`     aligns with a ${solved}depth offset`);
  }
}

console.log(failures ? `\n${failures} failure(s)` : `\nall good — ${rows.length} placements verified in InDesign`);
process.exit(failures ? 1 : 0);
