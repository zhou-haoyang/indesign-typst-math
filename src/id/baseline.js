/**
 * Choosing the anchored-object Y offset that puts the maths baseline on the
 * text baseline.
 *
 * Kept free of InDesign imports — it talks to the frame through accessors — so
 * it can be tested against both sign conventions and against a moving baseline
 * (tools/test-baseline-offset.mjs). This is the most consequential geometry in
 * the plugin and it has been wrong three times.
 *
 * What we are solving: the artwork's own baseline sits `depth` above the bottom
 * of the frame, and InDesign anchors that bottom edge to the text baseline. So
 * the object must end up with
 *
 *     frameBottom - textBaseline == depth
 *
 * Two things make this awkward, and both are handled by *measuring* rather than
 * reasoning:
 *
 *  - The sign of `anchorYoffset` that means "down" is not clearly documented.
 *  - On the **first line of a frame**, a tall inline object changes where the
 *    first baseline falls, so the baseline is not a fixed reference — it moves
 *    when the offset moves. Using the frame's own bottom-at-offset-0 as a stand
 *    in for the baseline therefore fails exactly there, and only there, which is
 *    why misalignment showed up on the first row and nowhere else.
 *
 * So: read the real baseline alongside the bounds, probe both signs, and solve
 * for the offset from the measured slope instead of assuming one.
 */

/** Close enough that no one could see the difference. */
const TOLERANCE_PT = 0.05;

/** A response this weak means the frame is not really moving; do not solve. */
const MIN_SLOPE = 0.1;

/** Guard against a solve running away when the layout responds oddly. */
const MAX_OFFSET_FACTOR = 4;

/**
 * @param {object} io
 * @param {(value: number) => boolean} io.setOffset  apply a Y offset; false if refused
 * @param {() => {bottom: number|null, baseline: number|null}} io.measure
 *        the frame's bottom edge and the text baseline it is anchored to, both
 *        after layout has settled. `baseline` may be null, in which case the
 *        bottom edge at offset 0 stands in for it — correct except on a first
 *        line, where it is the very thing that moves.
 * @param {number} io.depthPt
 * @returns {{offset: number|null, residual: number|null, note: string}}
 */
function chooseOffset({ setOffset, measure, depthPt }) {
  if (!(depthPt > 0.005)) {
    const applied = setOffset(0);
    return { offset: applied ? 0 : null, residual: 0, note: applied ? "0" : "refused" };
  }
  if (!setOffset(0)) {
    return { offset: null, residual: null, note: "refused" };
  }

  const zero = measure();
  if (!zero || zero.bottom === null) {
    // Cannot see anything; apply the conventional direction and say so.
    const applied = setOffset(depthPt);
    return {
      offset: applied ? depthPt : null,
      residual: null,
      note: applied ? `+${depthPt.toFixed(2)} (could not measure)` : "refused",
    };
  }
  // Without a real baseline reading, the bottom edge at offset 0 is the
  // baseline by definition of inline anchoring.
  const fixedBaseline = zero.baseline === null ? zero.bottom : null;

  /** How far the artwork's baseline is from the text baseline, in points. */
  const residualAt = (offset) => {
    if (!setOffset(offset)) return null;
    const now = measure();
    if (!now || now.bottom === null) return null;
    const baseline = fixedBaseline !== null ? fixedBaseline : now.baseline;
    if (baseline === null || baseline === undefined) return null;
    return (now.bottom - baseline) - depthPt;
  };

  const candidates = [];
  const record = (offset) => {
    const residual = residualAt(offset);
    if (residual !== null) candidates.push({ offset, residual });
    return residual;
  };

  const plus = record(depthPt);
  if (plus !== null && Math.abs(plus) < TOLERANCE_PT) {
    return { offset: depthPt, residual: plus, note: describe(depthPt, plus) };
  }
  const minus = record(-depthPt);
  if (minus !== null && Math.abs(minus) < TOLERANCE_PT) {
    return { offset: -depthPt, residual: minus, note: describe(-depthPt, minus) };
  }

  // Neither probe landed. If the two disagree, the layout is responding and we
  // can solve for the offset that zeroes the residual.
  if (plus !== null && minus !== null) {
    const slope = (plus - minus) / (2 * depthPt);
    if (Math.abs(slope) > MIN_SLOPE) {
      const limit = MAX_OFFSET_FACTOR * depthPt + 2;
      const solved = Math.max(-limit, Math.min(limit, depthPt - plus / slope));
      record(solved);
    }
  }

  if (!candidates.length) {
    const applied = setOffset(depthPt);
    return {
      offset: applied ? depthPt : null,
      residual: null,
      note: applied ? `+${depthPt.toFixed(2)} (could not measure)` : "refused",
    };
  }

  const best = candidates.reduce((a, b) => (Math.abs(b.residual) < Math.abs(a.residual) ? b : a));
  setOffset(best.offset);
  return { offset: best.offset, residual: best.residual, note: describe(best.offset, best.residual) };
}

function describe(offset, residual) {
  const sign = offset >= 0 ? "+" : "-";
  return `${sign}${Math.abs(offset).toFixed(2)}, off by ${residual.toFixed(2)}`;
}

module.exports = { chooseOffset };
