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

/**
 * Whether a DOM object is usable.
 *
 * Deliberately optimistic: not every UXP DOM class exposes `isValid`, and
 * treating a missing property as "invalid" silently disables whole code paths.
 * Only an explicit `false` counts as invalid.
 */
function isUsable(object) {
  if (!object) return false;
  let valid;
  try {
    valid = object.isValid;
  } catch {
    return true; // the object exists; it just will not answer that question
  }
  return valid === undefined || valid === null ? true : !!valid;
}

/**
 * Compare a DOM value against an enum member.
 *
 * UXP enum values do not compare with `===` — `swatch.space` and
 * `ColorSpace.CMYK` both print "CMYK" and are still not equal. Comparing them
 * directly silently fails every branch, which is how "match text colour"
 * managed to render everything black. Verified against a live InDesign; see
 * tools/probe-indesign.mjs.
 */
function sameEnum(value, member) {
  if (value === null || value === undefined) return false;
  return String(value) === String(member);
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
  if (!isUsable(doc)) {
    throw new Error("Open a document first.");
  }
  return doc;
}

module.exports = { withPoints, asOneUndo, tryGet, isUsable, sameEnum, activeDocument };
