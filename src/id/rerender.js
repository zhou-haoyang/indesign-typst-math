/**
 * Re-render every equation in the document.
 *
 * This is what turns baked-in size and colour back into something that tracks
 * the text: an equation recorded as `auto` re-reads the point size and fill of
 * the text it is anchored in, so restyling the body copy and running this pass
 * brings the maths along. It is also how a preamble change propagates.
 *
 * Everything is compiled and written to disk first, then applied in a single
 * synchronous pass, so the whole sweep is one undo step.
 */
const { withPoints, asOneUndo, isUsable } = require("./doc");
const { findAll, makeRecord } = require("./label");
const { readAt } = require("./context");
const {
  prepareAsset, discardAsset, replaceIn, lastAlignmentResidual,
} = require("./insert");
const { anchorCharacter } = require("./anchor");

/** Does this stored colour say anything, in either of the two shapes? */
function hasColor(color) {
  return !!color && !!(color.values || color.typst);
}

/**
 * Work out what an existing equation should be rendered as right now.
 * `auto` fields are re-read from the text; `fixed` fields keep their record.
 */
function specForExisting(frame, record, preamble) {
  const spec = {
    body: record.body,
    mode: record.mode,
    size: (record.size && record.size.pt) || 10,
    // Either shape counts as a colour to keep: a swatch ({space, values}) read
    // off the text when it was inserted, or the Typst expression ({typst}) that
    // was typed into the panel's colour box.
    color: hasColor(record.color) ? record.color : undefined,
    preamble,
  };
  const wantsSize = !record.size || record.size.mode === "auto";
  const wantsColor = !record.color || record.color.mode === "auto";
  const anchor = (wantsSize || wantsColor) ? anchorCharacter(frame) : null;
  if (anchor) {
    const at = readAt(anchor);
    if (wantsSize && at.size) spec.size = at.size;
    if (wantsColor) spec.color = at.color;
  }
  return spec;
}

/**
 * The colour to store back: whichever shape the render actually used.
 *
 * A `{typst}` expression must not be flattened into a swatch here — it is the
 * only copy of what the user typed, and losing it would leave the next re-render
 * with nothing to render a fixed colour from.
 */
function colorFor(record, spec) {
  const mode = (record.color && record.color.mode) || "auto";
  if (spec.color && spec.color.typst) return { mode, typst: spec.color.typst };
  return {
    mode,
    space: spec.color ? spec.color.space : "CMYK",
    values: spec.color ? spec.color.values : [0, 0, 0, 100],
  };
}

/** The record to store back after a re-render, preserving the auto/fixed modes. */
function recordFor(record, spec, metrics, preamble, engine) {
  return makeRecord({
    body: spec.body,
    mode: spec.mode,
    size: { mode: (record.size && record.size.mode) || "auto", pt: spec.size },
    color: colorFor(record, spec),
    preamble,
    metrics,
    engine,
  });
}

/**
 * @param {object} args doc, render(spec, want), preamble, engine, onProgress
 * @returns {Promise<{total: number, updated: number, failures: object[]}>}
 */
async function rerenderAll({ doc, render, preamble, engine, onProgress }) {
  const found = findAll(doc);
  const jobs = [];
  const failures = [];

  for (let i = 0; i < found.length; i++) {
    const { frame, record } = found[i];
    if (onProgress) onProgress(i, found.length);
    if (!isUsable(frame)) continue;

    const spec = specForExisting(frame, record, preamble);
    let result;
    try {
      result = await render(spec, { pdf: true });
    } catch (err) {
      failures.push({ body: record.body, message: String((err && err.message) || err) });
      continue;
    }
    if (!result.ok || !result.asset) {
      const first = (result.diagnostics || [])[0];
      failures.push({ body: record.body, message: first ? first.message : "render failed" });
      continue;
    }
    jobs.push({
      frame,
      path: await prepareAsset(result.asset),
      metrics: result.metrics,
      record: recordFor(record, spec, result.metrics, preamble, engine),
    });
  }

  let applied = 0;
  // Alignment is measured per frame; a batch is exactly where a silent
  // regression would hide, so the worst residual is reported rather than
  // assumed to be zero.
  let worstResidual = null;
  let unmeasured = 0;
  if (jobs.length) {
    asOneUndo("Re-render Typst equations", () => withPoints(doc, () => {
      for (const job of jobs) {
        try {
          replaceIn(doc, job.frame, job.path, job.metrics, job.record);
          applied++;
          const residual = lastAlignmentResidual();
          if (residual === null) unmeasured++;
          else if (worstResidual === null || Math.abs(residual) > Math.abs(worstResidual)) {
            worstResidual = residual;
          }
        } catch (err) {
          failures.push({ body: job.record.body, message: String((err && err.message) || err) });
        }
      }
    }));
  }

  await Promise.all(jobs.map((job) => discardAsset(job.path)));
  return { total: found.length, updated: applied, failures, worstResidual, unmeasured };
}

module.exports = { rerenderAll };
