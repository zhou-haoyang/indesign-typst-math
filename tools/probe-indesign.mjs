#!/usr/bin/env node
/**
 * Ask the running InDesign a question, right now.
 *
 * Most of this plugin's hard bugs were DOM behaviour that no headless test can
 * reproduce and no documentation states correctly. They were each guessed at
 * several times before someone measured. This is the measuring instrument:
 *
 *   node tools/probe-indesign.mjs                       # standard report
 *   node tools/probe-indesign.mjs 'J({v: app.version})' # arbitrary snippet
 *   node tools/probe-indesign.mjs --scratch 'return J({n: frame.lines.length});'
 *
 * With --scratch the snippet runs inside a throwaway document and can use
 * `doc`, `page` and `frame` (a text frame with some text in it); it must
 * `return` a JSON string. The document is closed without saving. Without
 * --scratch the snippet is plain ExtendScript whose last expression is the
 * result — it runs against whatever is open, so prefer --scratch.
 *
 * Two helpers are always in scope:
 *   J(value)      serialise to JSON (ExtendScript has no JSON object)
 *   probe(fn)     call fn, reporting {ok, value} or {ok:false, error} —
 *                 the way to ask "does this property even exist?"
 */
import { idJson, idRaw, inScratchDocument, isAvailable } from "./id.mjs";

if (!(await isAvailable())) {
  console.error("InDesign is not running, or is not answering AppleScript.");
  console.error("Open it, and approve the automation prompt if macOS shows one.");
  process.exit(1);
}

const args = process.argv.slice(2);
const scratch = args[0] === "--scratch";
const snippet = (scratch ? args[1] : args[0]) || null;

if (snippet) {
  const out = scratch ? await inScratchDocument(snippet) : await idRaw(snippet);
  console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
  process.exit(0);
}

/* ------------------------------------------------- the standard report ---- */

const result = await inScratchDocument(`
  var ip = frame.parentStory.insertionPoints[3];
  var box = ip.rectangles.add();
  box.geometricBounds = [0, 0, 10, 20];
  box.anchoredObjectSettings.anchoredPosition = AnchorPosition.INLINE_POSITION;
  frame.parentStory.recompose();

  function rel(o) {
    o.parent.parentStory.recompose();
    return o.geometricBounds[2] - o.parent.baseline;
  }
  var geometry = [];
  var aos = box.anchoredObjectSettings;
  var offsets = [0, 4, -4];
  for (var i = 0; i < offsets.length; i++) {
    aos.anchorYoffset = offsets[i];
    geometry.push({ offset: offsets[i], rel: rel(box) });
  }
  aos.anchorYoffset = 0;

  // Two starting states, because they behave differently and only one of them
  // shows the trap. A frame from place() arrives in the second state.
  var noneSwatch = doc.swatches.itemByName("None");
  var strokes = [];
  strokes.push({ step: "created (weight 1, Black)", weight: box.strokeWeight, rel: rel(box) });
  box.strokeWeight = 0;
  strokes.push({ step: "  strokeWeight = 0", weight: box.strokeWeight, rel: rel(box) });
  box.strokeColor = noneSwatch;
  strokes.push({ step: "  then strokeColor = None", weight: box.strokeWeight, rel: rel(box) });
  // Now already clean — assigning zero again is the case that misbehaves.
  box.strokeWeight = 0;
  strokes.push({ step: "already clean, weight = 0", weight: box.strokeWeight, rel: rel(box) });
  box.strokeColor = noneSwatch;
  strokes.push({ step: "  then strokeColor = None", weight: box.strokeWeight, rel: rel(box) });

  return J({
    properties: {
      "frame.parent (anchored)":   probe(function(){ return box.parent.constructor.name; }),
      "frame.storyOffset":         probe(function(){ return box.storyOffset; }),
      "frame.parentStory":         probe(function(){ return box.parentStory; }),
      "Character.baseline":        probe(function(){ return box.parent.baseline; }),
      "Line.baseline":             probe(function(){ return frame.lines[0].baseline; }),
      "InsertionPoint.isValid":    probe(function(){ return ip.isValid; }),
      "Character.pointSize":       probe(function(){ return box.parent.pointSize; })
    },
    geometry: geometry,
    strokes: strokes
  });
`);

if (result.error) {
  console.error("script error:", result.error, "line", result.line);
  process.exit(1);
}

console.log("Property availability:");
for (const [name, r] of Object.entries(result.properties)) {
  console.log(`  ${name.padEnd(28)} ${r.ok ? r.value : "THROWS: " + r.error}`);
}

console.log("\nanchorYoffset vs (frame bottom − text baseline):");
for (const g of result.geometry) {
  console.log(`  offset ${String(g.offset).padStart(3)}   ${g.rel.toFixed(3)}`);
}
const slope = (result.geometry[1].rel - result.geometry[0].rel) / 4;
console.log(`  slope ${slope.toFixed(2)} — positive offset moves the object ` +
  `${slope < 0 ? "UP" : "DOWN"} relative to the baseline`);

console.log("\nStroke, and what it does to anchoring:");
for (const s of result.strokes) {
  console.log(`  ${s.step.padEnd(26)} weight ${String(s.weight).padStart(3)}   ` +
    `bottom−baseline ${s.rel.toFixed(3)}`);
}
console.log("  (a stroke shifts anchoring by half its weight, visible or not)");
