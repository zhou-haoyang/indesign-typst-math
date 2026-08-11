#!/usr/bin/env node
/**
 * Unit checks for the anchored-object Y offset decision.
 *
 * InDesign anchors a frame's *bottom edge* to the text baseline, so an
 * equation must be pushed down by the depth of its artwork below its own
 * baseline. Which sign of `anchorYoffset` means "down" is not clearly
 * documented, so the code measures it — and this checks that the measurement
 * lands on a correct result under *either* convention, plus the degenerate
 * cases where the frame will not answer.
 *
 * This logic has been wrong twice: once silently reset by a later object-style
 * application, once left on an unverified guess that only looked right because
 * the sole hand-tested expression had a depth of 0.11pt.
 *
 *   node tools/test-baseline-offset.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { chooseOffset } = require(join(root, "src/id/baseline.js"));

const BASELINE = 100;

/**
 * A frame whose bottom edge sits on the text baseline at offset 0 and moves
 * according to the convention under test.
 */
function mockFrame({ positiveMovesDown, refuse = false, unmeasurable = false }) {
  let offset = 0;
  return {
    get offset() { return offset; },
    setOffset(value) {
      if (refuse) return false;
      offset = value;
      return true;
    },
    getBottom() {
      if (unmeasurable) return null;
      return BASELINE + (positiveMovesDown ? offset : -offset);
    },
  };
}

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// The core property: whatever the convention, the frame ends up with its bottom
// edge at baseline + depth, which is what puts the maths baseline on the text.
for (const positiveMovesDown of [true, false]) {
  for (const depth of [2.46, 0.11, 12.5]) {
    const frame = mockFrame({ positiveMovesDown });
    const r = chooseOffset({
      depthPt: depth,
      positiveIsDown: null,
      setOffset: (v) => frame.setOffset(v),
      getBottom: () => frame.getBottom(),
    });
    const landed = frame.getBottom();
    check(
      `positive=${positiveMovesDown ? "down" : "up"}, depth ${depth}`,
      Math.abs(landed - (BASELINE + depth)) < 0.01,
      `applied ${r.offset}, bottom ${landed.toFixed(2)}, want ${(BASELINE + depth).toFixed(2)}`,
    );
    check(
      `  … learns the convention`,
      r.positiveIsDown === positiveMovesDown,
      `positiveIsDown=${r.positiveIsDown}`,
    );
    check(`  … reports a zero residual`, Math.abs(r.residual) < 0.01, r.note);
  }
}

// A remembered convention must not be trusted blindly if it is wrong.
{
  const frame = mockFrame({ positiveMovesDown: true });
  const r = chooseOffset({
    depthPt: 3, positiveIsDown: false, // deliberately stale/wrong
    setOffset: (v) => frame.setOffset(v),
    getBottom: () => frame.getBottom(),
  });
  check("recovers from a wrong cached convention",
    Math.abs(frame.getBottom() - (BASELINE + 3)) < 0.01 && r.positiveIsDown === true,
    r.note);
}

// Negligible depth: no offset, and no probing.
{
  const frame = mockFrame({ positiveMovesDown: true });
  const r = chooseOffset({
    depthPt: 0, positiveIsDown: null,
    setOffset: (v) => frame.setOffset(v),
    getBottom: () => frame.getBottom(),
  });
  check("zero depth applies no offset", r.offset === 0 && r.note === "0", r.note);
}

// The frame refuses the property: report it rather than pretending.
{
  const frame = mockFrame({ positiveMovesDown: true, refuse: true });
  const r = chooseOffset({
    depthPt: 3, positiveIsDown: null,
    setOffset: (v) => frame.setOffset(v),
    getBottom: () => frame.getBottom(),
  });
  check("refused assignment is reported", r.note === "refused" && r.offset === null, r.note);
}

// Bounds unreadable: still apply something, but admit it is unverified.
{
  const frame = mockFrame({ positiveMovesDown: true, unmeasurable: true });
  const r = chooseOffset({
    depthPt: 3, positiveIsDown: null,
    setOffset: (v) => frame.setOffset(v),
    getBottom: () => frame.getBottom(),
  });
  check("unmeasurable bounds still applies an offset",
    Math.abs(Math.abs(r.offset) - 3) < 0.01 && /could not measure/.test(r.note), r.note);
  check("  … does not cache a guess", r.positiveIsDown === null, `${r.positiveIsDown}`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
