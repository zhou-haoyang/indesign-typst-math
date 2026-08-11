/**
 * Choosing the anchored-object Y offset that puts the maths baseline on the
 * text baseline.
 *
 * Kept free of InDesign imports — it talks to the frame through two accessors —
 * so the decision can be tested against both possible sign conventions
 * (tools/test-baseline-offset.mjs). This is the most consequential geometry in
 * the plugin and it has been wrong twice.
 *
 * The trick that makes it measurable rather than a matter of documentation:
 * at offset 0 InDesign puts the frame's *bottom edge* on the text baseline, so
 * that reading is the baseline itself, expressed in the same coordinate space
 * as the frame's bounds. The target is then simply `baseline + depth`.
 */

/** Close enough that no one could see the difference. */
const TOLERANCE_PT = 0.05;

/**
 * @param {object} io
 * @param {() => boolean} io.setOffset      apply a Y offset; false if refused
 * @param {() => number|null} io.getBottom  the frame's bottom edge, after layout
 * @param {number} io.depthPt               baseline to bottom of the artwork
 * @param {boolean|null} io.positiveIsDown  cached from an earlier call, or null
 * @returns {{offset: number|null, sign: number|null, residual: number|null,
 *            positiveIsDown: boolean|null, note: string}}
 */
function chooseOffset({ setOffset, getBottom, depthPt, positiveIsDown = null }) {
  if (!(depthPt > 0.005)) {
    const applied = setOffset(0);
    return {
      offset: applied ? 0 : null,
      sign: null,
      residual: 0,
      positiveIsDown,
      note: applied ? "0" : "refused",
    };
  }

  if (!setOffset(0)) {
    return { offset: null, sign: null, residual: null, positiveIsDown, note: "refused" };
  }
  const baseline = getBottom();
  const target = baseline === null ? null : baseline + depthPt;

  const residualFor = (sign) => {
    if (!setOffset(sign * depthPt) || target === null) return null;
    const now = getBottom();
    return now === null ? null : now - target;
  };

  // Try the remembered sign first; it is almost always right after the first
  // measurement, which keeps a re-render pass to one probe per equation.
  const order = positiveIsDown === false ? [-1, 1] : [1, -1];
  let best = null;
  for (const sign of order) {
    const residual = residualFor(sign);
    if (residual === null) {
      best = best || { sign, residual: null };
      break;
    }
    if (best === null || Math.abs(residual) < Math.abs(best.residual)) {
      best = { sign, residual };
    }
    if (Math.abs(residual) < TOLERANCE_PT) break;
  }

  if (!best) {
    return { offset: null, sign: null, residual: null, positiveIsDown, note: "refused" };
  }

  const offset = best.sign * depthPt;
  setOffset(offset);
  const settled = best.residual !== null && Math.abs(best.residual) < TOLERANCE_PT;
  return {
    offset,
    sign: best.sign,
    residual: best.residual,
    positiveIsDown: settled ? best.sign > 0 : positiveIsDown,
    note: `${best.sign > 0 ? "+" : "-"}${depthPt.toFixed(2)}` +
      (best.residual === null
        ? " (could not measure)"
        : `, off by ${best.residual.toFixed(2)}`),
  };
}

module.exports = { chooseOffset, TOLERANCE_PT };
