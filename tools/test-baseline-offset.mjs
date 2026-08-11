#!/usr/bin/env node
/**
 * Unit checks for the anchored-object Y offset decision.
 *
 * InDesign anchors a frame's bottom edge to the text baseline, so an equation
 * must be pushed down by the depth of its artwork below its own baseline. Two
 * things get in the way, and the code measures its way past both:
 *
 *  - which sign of `anchorYoffset` means "down" is not clearly documented;
 *  - on the **first line of a frame**, a tall inline object changes where the
 *    first baseline falls, so the baseline moves when the offset moves.
 *
 * The `feedback` parameter below models that second one: `0` is an ordinary
 * line, `1` is a first line whose baseline tracks the object completely. The
 * previous implementation used the frame's own bottom-at-offset-0 as the
 * baseline reference and could not converge at feedback 1 — which is exactly
 * the "first row is off" symptom.
 *
 *   node tools/test-baseline-offset.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { chooseOffset } = require(join(root, "src/id/baseline.js"));

const BASE = 100;

/**
 * @param positiveMovesDown which sign of the property moves the object down
 * @param feedback          how much the baseline follows the object (0..1)
 * @param exposeBaseline    whether the DOM will tell us the baseline at all
 */
function mockFrame({
  positiveMovesDown = true, feedback = 0, exposeBaseline = true,
  refuse = false, blind = false,
} = {}) {
  let offset = 0;
  const down = () => (positiveMovesDown ? offset : -offset);
  return {
    get offset() { return offset; },
    setOffset(value) {
      if (refuse) return false;
      offset = value;
      return true;
    },
    measure() {
      if (blind) return { bottom: null, baseline: null };
      const baseline = BASE - feedback * down();
      return { bottom: baseline + down(), baseline: exposeBaseline ? baseline : null };
    },
    /** The thing that actually matters: artwork baseline vs text baseline. */
    misalignment(depth) {
      const m = this.measure();
      return (m.bottom - (BASE - feedback * down())) - depth;
    },
  };
}

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const run = (frame, depth) => chooseOffset({
  depthPt: depth,
  setOffset: (v) => frame.setOffset(v),
  measure: () => frame.measure(),
});

console.log("aligns under both sign conventions, ordinary line and first line:");
for (const positiveMovesDown of [true, false]) {
  for (const feedback of [0, 0.5, 1]) {
    for (const depth of [2.46, 0.11, 12.5]) {
      const frame = mockFrame({ positiveMovesDown, feedback });
      const r = run(frame, depth);
      const off = frame.misalignment(depth);
      check(
        `positive=${positiveMovesDown ? "down" : "up"}, feedback ${feedback}, depth ${depth}`,
        Math.abs(off) < 0.05,
        `applied ${r.offset?.toFixed(2)}, misaligned by ${off.toFixed(3)}`,
      );
    }
  }
}

console.log("\nreported residual matches reality:");
for (const feedback of [0, 1]) {
  const frame = mockFrame({ positiveMovesDown: true, feedback });
  const r = run(frame, 3);
  check(`feedback ${feedback}`,
    r.residual !== null && Math.abs(r.residual - frame.misalignment(3)) < 0.01,
    `reported ${r.residual?.toFixed(3)}, actual ${frame.misalignment(3).toFixed(3)}`);
}

console.log("\nfalls back sanely when the layout will not answer:");
{
  // No baseline exposed: still correct on an ordinary line, since the bottom
  // edge at offset 0 *is* the baseline there.
  const frame = mockFrame({ exposeBaseline: false, feedback: 0 });
  const r = run(frame, 3);
  check("no baseline property, ordinary line",
    Math.abs(frame.misalignment(3)) < 0.05, `applied ${r.offset?.toFixed(2)}`);
}
{
  const frame = mockFrame({ blind: true });
  const r = run(frame, 3);
  check("bounds unreadable still applies an offset",
    Math.abs(Math.abs(r.offset) - 3) < 0.01 && /could not measure/.test(r.note), r.note);
  check("  … and admits it is unverified", r.residual === null, `${r.residual}`);
}
{
  const frame = mockFrame({ refuse: true });
  const r = run(frame, 3);
  check("refused assignment is reported", r.note === "refused" && r.offset === null, r.note);
}
{
  const frame = mockFrame();
  const r = run(frame, 0);
  check("zero depth applies no offset", r.offset === 0 && r.note === "0", r.note);
}

console.log("\nsolved offset stays bounded when the layout responds oddly:");
{
  // A frame that barely moves: the solve must not run away.
  const frame = {
    _o: 0,
    setOffset(v) { this._o = v; return true; },
    measure() { return { bottom: BASE + this._o * 0.02, baseline: BASE }; },
  };
  const r = chooseOffset({ depthPt: 3, setOffset: (v) => frame.setOffset(v), measure: () => frame.measure() });
  check("weak response does not produce a wild offset",
    Math.abs(r.offset) <= 4 * 3 + 2 + 0.001, `applied ${r.offset}`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
