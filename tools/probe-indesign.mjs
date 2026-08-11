#!/usr/bin/env node
/**
 * Ask InDesign directly about the things this plugin has had to guess at.
 *
 * Runs against a scratch document and closes it without saving.
 *
 *   node tools/probe-indesign.mjs
 */
import { inScratchDocument, isAvailable } from "./id.mjs";

if (!(await isAvailable())) {
  console.error("InDesign is not running, or is not answering AppleScript.");
  process.exit(1);
}

const result = await inScratchDocument(`
  var ip = frame.parentStory.insertionPoints[3];

  // A stand-in for an equation: a rectangle anchored inline, 40x20pt.
  var placed = ip.rectangles.add();
  placed.geometricBounds = [0, 0, 20, 40];
  var aos = placed.anchoredObjectSettings;
  aos.anchoredPosition = AnchorPosition.INLINE_POSITION;
  frame.parentStory.recompose();

  function bottom(){ frame.parentStory.recompose(); return placed.geometricBounds[2]; }
  function lineBaseline(){
    try { return frame.lines[0].baseline; } catch (e) { return null; }
  }

  var atZero = null, atPlus = null, atMinus = null;
  aos.anchorYoffset = 0;  atZero  = { bottom: bottom(), baseline: lineBaseline() };
  aos.anchorYoffset = 5;  atPlus  = { bottom: bottom(), baseline: lineBaseline() };
  aos.anchorYoffset = -5; atMinus = { bottom: bottom(), baseline: lineBaseline() };
  aos.anchorYoffset = 0;

  return J({
    properties: {
      "InsertionPoint.isValid":        probe(function(){ return ip.isValid; }),
      "InsertionPoint.baseline":       probe(function(){ return ip.baseline; }),
      "InsertionPoint.constructor":    probe(function(){ return ip.constructor.name; }),
      "Line.baseline":                 probe(function(){ return frame.lines[0].baseline; }),
      "Rectangle.isValid":             probe(function(){ return placed.isValid; }),
      "Rectangle.storyOffset":         probe(function(){ return placed.storyOffset.constructor.name; }),
      "Rectangle.storyOffset.baseline":probe(function(){ return placed.storyOffset.baseline; }),
      "Story.recompose":               probe(function(){ frame.parentStory.recompose(); return "callable"; }),
      "Character.baseline":            probe(function(){ return frame.parentStory.characters[0].baseline; })
    },
    geometry: { atZero: atZero, atPlus: atPlus, atMinus: atMinus }
  });
`);

if (result.error) {
  console.error("script error:", result.error, "line", result.line);
  process.exit(1);
}

console.log("Property availability (ExtendScript DOM):");
for (const [name, r] of Object.entries(result.properties)) {
  console.log(`  ${name.padEnd(32)} ${r.ok ? r.value : "THROWS: " + r.error}`);
}

const g = result.geometry;
console.log("\nGeometry of an inline anchored rectangle:");
for (const [label, m] of Object.entries(g)) {
  console.log(`  ${label.padEnd(8)} bottom ${fmt(m.bottom)}  baseline ${fmt(m.baseline)}` +
    (m.baseline !== null ? `  bottom-baseline ${fmt(m.bottom - m.baseline)}` : ""));
}

const movedByPlus = g.atPlus.bottom - g.atZero.bottom;
console.log(`\nanchorYoffset = +5 moved the frame ${fmt(movedByPlus)} pt ` +
  `(${movedByPlus > 0 ? "DOWN the page" : movedByPlus < 0 ? "UP the page" : "not at all"})`);
if (g.atZero.baseline !== null) {
  console.log(`At offset 0, bottom - baseline = ${fmt(g.atZero.bottom - g.atZero.baseline)} ` +
    `(0 would confirm "bottom edge sits on the baseline")`);
}

function fmt(v) {
  return v === null || v === undefined ? "n/a" : Number(v).toFixed(3).padStart(9);
}
