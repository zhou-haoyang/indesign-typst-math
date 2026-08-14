#!/usr/bin/env node
/**
 * End-to-end test of the plugin's InDesign layer, running the real modules.
 *
 * A UXP script shares the plugin's module system, so this drives the actual
 * `src/id/*` code inside a live InDesign rather than reimplementing it — the
 * difference between testing the plugin and testing a copy of the plugin.
 *
 * Covered, none of which any headless test can reach:
 *   - inline placement anchors to a Character, sized to the Typst page box
 *   - the baseline solver lands the maths baseline on the text baseline,
 *     on a first line and a later line (they behave differently)
 *   - the frame ends up with no stroke, which is alignment-critical
 *   - the artwork is embedded, so the document has no external dependency
 *   - the label round-trips, which is what makes an equation editable
 *   - updating re-renders into the same frame and stays aligned
 *   - with no text target, placement falls back to a floating frame
 *
 * Expressions are rendered by the Typst CLI, standing in for the wasm compiler
 * the panel uses; both go through webview/template.js, so the metrics are the
 * same ones the plugin would place.
 *
 * Runs in a scratch document, closed without saving.
 *
 *   node tools/test-plugin.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAvailable } from "./id.mjs";
import { ROOT, driver, runUxp } from "./uxp.mjs";

const TOLERANCE = 0.05;
const CASES = [
  { body: "x^2", size: 12 },
  { body: "y = x^2", size: 12 },
  { body: "(d y)/(d x)", size: 12 },
  { body: "cases(x &> 0, y &<= 1)", size: 12 },
];

if (!(await isAvailable())) {
  console.error("InDesign is not running, or is not answering AppleScript.");
  process.exit(1);
}

const { buildSource } = await import(join(ROOT, "webview", "template.js"));
const work = await mkdtemp(join(tmpdir(), "idt-plugin-"));

function exec(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(err || `${cmd} failed`))));
  });
}

/** Render with the CLI, mirroring what the wasm backend would hand the plugin. */
async function render(spec, suffix = "") {
  const src = buildSource({ body: spec.body, mode: "inline", size: spec.size });
  const stem = join(work, spec.body.replace(/\W+/g, "_") + suffix);
  await writeFile(`${stem}.typ`, src.source);
  await exec("typst", ["compile", `${stem}.typ`, `${stem}.pdf`]);
  const m = JSON.parse(await exec("typst",
    ["query", `${stem}.typ`, "<idt-metrics>", "--field", "value"]))[0];
  return { pdf: `${stem}.pdf`, width: m.w, height: m.h, depth: m.d };
}

const cases = [];
for (const spec of CASES) cases.push({ ...spec, ...(await render(spec)) });
// A second render of the first expression, at a different size, for the update path.
const updated = await render({ body: "alpha + beta", size: 18 }, "-upd");

const result = await runUxp(driver(`
  const { app } = require("indesign");
  const idsn = require("indesign");
  const { withPoints } = require("./src/id/doc.js");
  const { placeNew, replaceIn, lastOffset, lastAlignmentResidual,
          lastPlacementWarnings } = require("./src/id/insert.js");
  const { makeRecord, readRecord } = require("./src/id/label.js");
  const { anchorBaseline, isAnchored } = require("./src/id/anchor.js");

  const cases = ${JSON.stringify(cases)};
  const updated = ${JSON.stringify(updated)};
  const results = [];

  const doc = app.documents.add(false);
  try {
    doc.viewPreferences.horizontalMeasurementUnits = idsn.MeasurementUnits.POINTS;
    doc.viewPreferences.verticalMeasurementUnits = idsn.MeasurementUnits.POINTS;
    const page = doc.pages.item(0);
    const frame = page.textFrames.add();
    frame.geometricBounds = [72, 72, 520, 480];
    frame.contents = "AAAA BBBB CCCC\\rDDDD EEEE FFFF";
    frame.parentStory.texts.item(0).pointSize = 12;

    const recordFor = (c) => makeRecord({
      body: c.body, mode: "inline",
      size: { mode: "fixed", pt: c.size },
      color: { mode: "fixed", typst: "black" },
      preamble: "", metrics: { width: c.width, height: c.height, depth: c.depth },
      engine: "test",
    });

    const measure = (box) => {
      const baseline = anchorBaseline(box);
      const gb = box.geometricBounds;
      return {
        width: gb[3] - gb[1], height: gb[2] - gb[0],
        baseline, residual: baseline === null ? null : (gb[2] - baseline) - 0,
        bottom: gb[2],
      };
    };

    for (let i = 0; i < cases.length; i++) {
      for (const line of [0, 1]) {
        const c = cases[i];
        const ip = frame.parentStory.insertionPoints.item(line === 0 ? 2 : 18);
        const record = recordFor(c);
        const placed = withPoints(doc, () =>
          placeNew(doc, c.pdf, { width: c.width, height: c.height, depth: c.depth },
                   record, { kind: "text", insertionPoint: ip }));
        const box = placed.frame;
        const m = measure(box);
        const stored = readRecord(box);
        // An embedded file is still a Link; only its status changes. Checking
        // for the absence of a link would wrongly report every insert as linked.
        let embedded = null;
        try {
          const g = box.allGraphics;
          if (g.length) {
            const link = g[0].itemLink;
            embedded = !link || String(link.status) === String(idsn.LinkStatus.LINK_EMBEDDED);
          }
        } catch (e) { embedded = true; }

        results.push({
          kind: "insert", body: c.body, line,
          anchored: placed.anchored,
          isAnchoredFn: isAnchored(box),
          parent: box.parent.constructor.name,
          strokeWeight: box.strokeWeight,
          wantW: c.width, wantH: c.height, depth: c.depth,
          gotW: m.width, gotH: m.height,
          bottomMinusBaseline: m.baseline === null ? null : m.bottom - m.baseline,
          offsetNote: lastOffset(),
          residual: lastAlignmentResidual(),
          warnings: lastPlacementWarnings(),
          labelBody: stored ? stored.body : null,
          labelDepth: stored && stored.metrics ? stored.metrics.depth : null,
          embedded,
        });

        // Update in place, and confirm the frame and anchoring survive.
        if (line === 0 && i === 0) {
          const before = box.id;
          const rec2 = recordFor({ ...updated, body: "alpha + beta", size: 18 });
          withPoints(doc, () => replaceIn(doc, box, updated.pdf,
            { width: updated.width, height: updated.height, depth: updated.depth }, rec2));
          const m2 = measure(box);
          const stored2 = readRecord(box);
          results.push({
            kind: "update", body: "alpha + beta",
            sameFrame: box.id === before,
            stillAnchored: isAnchored(box),
            strokeWeight: box.strokeWeight,
            wantW: updated.width, wantH: updated.height, depth: updated.depth,
            gotW: m2.width, gotH: m2.height,
            bottomMinusBaseline: m2.baseline === null ? null : m2.bottom - m2.baseline,
            offsetNote: lastOffset(),
            residual: lastAlignmentResidual(),
            labelBody: stored2 ? stored2.body : null,
          });
        }
      }
    }

    // Reading the typographic context: the size and colour "match text" uses.
    // UXP enum comparison is the trap here — see src/id/doc.js sameEnum.
    const { readAt } = require("./src/id/context.js");
    const magenta = doc.colors.add({
      model: idsn.ColorModel.PROCESS, space: idsn.ColorSpace.CMYK,
      colorValue: [0, 100, 0, 0], name: "E2E Magenta",
    });
    const styled = frame.parentStory.characters.itemByRange(0, 3);
    styled.pointSize = 21;
    styled.fillColor = magenta;
    const read = readAt(frame.parentStory.insertionPoints.item(1));
    results.push({
      kind: "context",
      size: read.size,
      colorSpace: read.color ? read.color.space : null,
      colorValues: read.color ? read.color.values : null,
      notes: read.notes,
    });

    // The document preamble, through the real DOM. The unit test mocks
    // insertLabel/extractLabel, and the behaviour that matters is exactly what
    // a mock cannot prove: InDesign returns "" both for a key that was never
    // set and for one holding an empty preamble, so the panel can only tell
    // "never had one" from "cleared on purpose" if the envelope survives a
    // real round trip.
    const labels = require("./src/id/label.js");
    const preambleFresh = labels.readDocumentPreamble(doc);
    labels.writeDocumentPreamble(doc, "");
    const preambleEmptied = labels.readDocumentPreamble(doc);
    labels.writeDocumentPreamble(doc, "#let vb(x) = math.bold(x)");
    const preambleSet = labels.readDocumentPreamble(doc);
    results.push({
      kind: "preamble",
      freshPresent: preambleFresh.present,
      emptiedPresent: preambleEmptied.present,
      emptiedText: preambleEmptied.text,
      setPresent: preambleSet.present,
      setText: preambleSet.text,
    });

    // No text target: must land on the page rather than refuse.
    const c0 = cases[0];
    const floated = withPoints(doc, () =>
      placeNew(doc, c0.pdf, { width: c0.width, height: c0.height, depth: c0.depth },
               recordFor(c0), { kind: "page" }));
    results.push({
      kind: "floating",
      anchored: floated.anchored,
      isAnchoredFn: isAnchored(floated.frame),
      parent: floated.frame.parent.constructor.name,
      labelBody: (readRecord(floated.frame) || {}).body || null,
    });

    // The undo wrapper, which every real insert goes through and none of the
    // cases above did. app.doScript marshals its return value and keeps only
    // scalars — an object arrives with no properties whatever — so placeNew
    // returning {frame, anchored} is not enough on its own: the panel reads
    // that through asOneUndo, and read it as {} for a long time, reporting
    // every inline insert as "on the page".
    const { asOneUndo } = require("./src/id/doc.js");
    const carriedScalar = asOneUndo("Probe scalar", () => 42);
    const carried = asOneUndo("Insert Typst equation", () => withPoints(doc, () =>
      placeNew(doc, c0.pdf, { width: c0.width, height: c0.height, depth: c0.depth },
               recordFor(c0),
               { kind: "text", insertionPoint: frame.parentStory.insertionPoints.item(2) })));
    results.push({
      kind: "undo-result",
      keys: carried && typeof carried === "object" ? Object.keys(carried) : null,
      anchored: carried ? carried.anchored : null,
      frameUsable: !!(carried && carried.frame && carried.frame.isValid),
      scalar: carriedScalar,
    });
  } finally {
    doc.close(idsn.SaveOptions.NO);
  }
  return { results };
`));

await rm(work, { recursive: true, force: true });

if (result.fatal) {
  console.error("UXP driver failed:", result.fatal);
  if (result.stack) console.error(result.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(1);
}

let failures = 0;
const fail = (m) => { failures++; console.log(`     ✗ ${m}`); };
const near = (a, b) => a !== null && Math.abs(a - b) < TOLERANCE;

for (const r of result.results) {
  if (r.kind === "context") {
    console.log(`\n[context] reading the text under the cursor`);
    console.log(`     size ${r.size} pt, colour ${r.colorSpace} ${JSON.stringify(r.colorValues)}`);
    if (r.size !== 21) fail(`point size read as ${r.size}, expected 21`);
    if (r.colorSpace !== "CMYK") fail(`colour space read as ${r.colorSpace}, expected CMYK`);
    if (JSON.stringify(r.colorValues) !== "[0,100,0,0]") {
      fail(`colour values ${JSON.stringify(r.colorValues)}, expected [0,100,0,0]`);
    }
    if (r.notes && r.notes.length) fail(`unexpected notes: ${r.notes.join("; ")}`);
    continue;
  }

  if (r.kind === "preamble") {
    console.log(`\n[preamble] document label, absent vs empty vs set`);
    const before = failures;
    if (r.freshPresent !== false) fail("a fresh document reports a preamble it has never had");
    if (r.emptiedPresent !== true) fail("a deliberately emptied preamble reads as absent, so it would be re-seeded");
    if (r.emptiedText !== "") fail(`emptied preamble read back as ${JSON.stringify(r.emptiedText)}`);
    if (r.setPresent !== true || r.setText !== "#let vb(x) = math.bold(x)") {
      fail(`set preamble read back as ${JSON.stringify(r.setText)}`);
    }
    if (failures === before) console.log("     all three states distinguishable");
    continue;
  }

  if (r.kind === "undo-result") {
    console.log(`\n[undo] what survives app.doScript, which the panel reads`);
    const before = failures;
    if (r.scalar !== 42) fail(`a scalar result came back as ${JSON.stringify(r.scalar)}`);
    if (r.anchored !== true) {
      fail(`anchored came back as ${JSON.stringify(r.anchored)} (keys: ` +
        `${JSON.stringify(r.keys)}) — every inline insert would report itself as on the page`);
    }
    if (!r.frameUsable) fail("the placed frame did not survive, so Update cannot find it");
    if (failures === before) console.log("     {frame, anchored} survives the undo wrapper");
    continue;
  }

  if (r.kind === "floating") {
    console.log(`\n[floating] no text target`);
    if (r.anchored) fail("reported as anchored");
    if (r.isAnchoredFn) fail("isAnchored() true for a page-level frame");
    if (r.parent === "Character") fail("parent is a Character, so it anchored anyway");
    if (r.labelBody !== "x^2") fail(`label did not round-trip (${r.labelBody})`);
    if (!failures) console.log("     placed on the page, labelled, not anchored");
    continue;
  }

  const tag = r.kind === "update" ? "[update]" : `[insert line ${r.line + 1}]`;
  console.log(`\n${tag} ${r.body}   depth ${r.depth.toFixed(2)} pt`);
  console.log(`     ${r.gotW.toFixed(2)} × ${r.gotH.toFixed(2)} pt, ` +
    `bottom−baseline ${r.bottomMinusBaseline === null ? "n/a" : r.bottomMinusBaseline.toFixed(2)}, ` +
    `offset ${r.offsetNote}`);

  if (r.kind === "insert") {
    if (!r.anchored) fail("placement did not anchor");
    if (!r.isAnchoredFn) fail("isAnchored() disagrees with the placement");
    if (r.parent !== "Character") fail(`parent is ${r.parent}, not Character`);
    if (r.embedded === false) fail("artwork is still linked, not embedded");
    if (r.labelBody !== r.body) fail(`label body round-tripped as ${JSON.stringify(r.labelBody)}`);
    if (!near(r.labelDepth, r.depth)) fail(`label depth ${r.labelDepth} != ${r.depth}`);
  } else {
    if (!r.sameFrame) fail("update replaced the frame instead of reusing it");
    if (!r.stillAnchored) fail("update lost the anchor");
    if (r.labelBody !== r.body) fail(`label not updated (${r.labelBody})`);
  }

  if (r.strokeWeight !== 0) fail(`stroke weight ${r.strokeWeight} shifts the baseline by half of it`);
  if (!near(r.gotW, r.wantW)) fail(`width ${r.gotW.toFixed(2)} but Typst said ${r.wantW.toFixed(2)}`);
  if (!near(r.gotH, r.wantH)) fail(`height ${r.gotH.toFixed(2)} but Typst said ${r.wantH.toFixed(2)}`);
  if (!near(r.bottomMinusBaseline, r.depth)) {
    fail(`maths baseline off the text baseline: bottom−baseline ` +
      `${r.bottomMinusBaseline === null ? "unmeasured" : r.bottomMinusBaseline.toFixed(2)}, wanted ${r.depth.toFixed(2)}`);
  }
  if (r.residual !== null && Math.abs(r.residual) >= TOLERANCE) {
    fail(`solver reported residual ${r.residual.toFixed(2)}`);
  }
  if (r.warnings && r.warnings.length) fail(`placement warnings: ${r.warnings.join("; ")}`);
}

console.log(failures
  ? `\n${failures} failure(s)`
  : `\nall good — ${result.results.length} operations through the real plugin code`);
process.exit(failures ? 1 : 0);
