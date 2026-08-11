/**
 * Small helpers over the InDesign DOM: units, undo grouping, safe property
 * access.
 */
const idsn = require("indesign");
const { app } = idsn;

/**
 * Run `fn` with the document's rulers in points.
 *
 * Every geometric number we exchange with Typst is in points, but
 * `geometricBounds` and `anchorYoffset` are interpreted in whatever the
 * document's current ruler units happen to be. Swapping the units for the
 * duration is the standard way to keep the arithmetic honest.
 */
function withPoints(doc, fn) {
  const view = doc.viewPreferences;
  const h = view.horizontalMeasurementUnits;
  const v = view.verticalMeasurementUnits;
  const points = idsn.MeasurementUnits.POINTS;
  const changed = h !== points || v !== points;
  if (changed) {
    view.horizontalMeasurementUnits = points;
    view.verticalMeasurementUnits = points;
  }
  try {
    return fn();
  } finally {
    if (changed) {
      view.horizontalMeasurementUnits = h;
      view.verticalMeasurementUnits = v;
    }
  }
}

/**
 * Run `fn` as a single undo step.
 *
 * `fn` must be synchronous — doScript cannot await — so compile the expression
 * and write the temp file before calling this.
 */
function asOneUndo(name, fn) {
  try {
    return app.doScript(fn, idsn.ScriptLanguage.UXPSCRIPT, [],
      idsn.UndoModes.ENTIRE_SCRIPT, name);
  } catch (err) {
    // Losing a tidy undo group is much better than losing the edit.
    if (/doScript|argument|ScriptLanguage/i.test(String(err && err.message))) return fn();
    throw err;
  }
}

/** Property read that tolerates the DOM throwing instead of returning null. */
function tryGet(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function activeDocument() {
  const doc = tryGet(() => app.activeDocument, null);
  if (!doc || !tryGet(() => doc.isValid, false)) {
    throw new Error("Open a document first.");
  }
  return doc;
}

module.exports = { withPoints, asOneUndo, tryGet, activeDocument };
