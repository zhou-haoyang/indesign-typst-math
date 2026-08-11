/**
 * Placing rendered maths into the document.
 *
 * Division of labour with InDesign:
 *   - InDesign owns line breaking, justification, leading and baseline-grid
 *     alignment once the frame is anchored. We do not touch any of it.
 *   - InDesign anchors the *bottom edge of the frame* to the text baseline and
 *     knows nothing about where the maths baseline sits inside the artwork, so
 *     we shift the object down by the depth Typst reported.
 *   - Point size and colour are already baked into the artwork; InDesign cannot
 *     change either for a placed graphic.
 *
 * The sync `placeNew`/`replaceIn` pair is separate from the async wrappers so a
 * batch (re-render all) can put many frames inside a single undo step: all the
 * compiling and file writing happens first, then one synchronous pass.
 */
const idsn = require("indesign");
const { app } = idsn;
const fs = require("fs");
const { localFileSystem } = require("uxp").storage;

const { withPoints, asOneUndo, tryGet } = require("./doc");
const { writeRecord } = require("./label");
const { neutralize, describeChrome } = require("./frame");

/** Cached once per session: does a positive anchorYoffset move the object down? */
let positiveIsDown = null;

/* --------------------------------------------------------------- temp file */

let tempFolder = null;
let tempCounter = 0;

/** Write an asset somewhere InDesign can place it from. */
async function prepareAsset(asset) {
  if (!tempFolder) tempFolder = await localFileSystem.getTemporaryFolder();
  const base = tempFolder.nativePath;
  const sep = base.endsWith("/") ? "" : "/";
  const path = `${base}${sep}idt-${Date.now()}-${tempCounter++}.${asset.format}`;
  await fs.writeFile(`file:${path}`, asset.bytes);
  return path;
}

/** The artwork is embedded once placed, so the temp file is disposable. */
async function discardAsset(path) {
  try { await fs.unlink(`file:${path}`); } catch { /* the OS will get to it */ }
}

/* ----------------------------------------------------------------- placing */

/**
 * Make PDF placement deterministic: crop to the media box, which is exactly the
 * Typst page box the metrics describe, and keep the background transparent so
 * the equation does not sit on a white tile.
 */
function configurePdfPlacement() {
  const prefs = app.pdfPlacePreferences;
  const before = {
    crop: tryGet(() => prefs.pdfCrop, null),
    transparent: tryGet(() => prefs.transparentBackground, null),
  };
  try { prefs.pdfCrop = idsn.PDFCrop.CROP_MEDIA; } catch { /* enum may differ */ }
  try { prefs.transparentBackground = true; } catch { /* not settable */ }
  return () => {
    if (before.crop !== null) { try { prefs.pdfCrop = before.crop; } catch { /* ignore */ } }
    if (before.transparent !== null) {
      try { prefs.transparentBackground = before.transparent; } catch { /* ignore */ }
    }
  };
}

/** `place()` hands back either the graphic or its frame depending on context. */
function frameOf(placed) {
  const item = Array.isArray(placed) ? placed[0] : placed;
  if (!item) throw new Error("InDesign did not place the graphic.");
  const parent = tryGet(() => item.parent, null);
  if (parent && tryGet(() => parent.geometricBounds, null)) return parent;
  if (tryGet(() => item.geometricBounds, null)) return item;
  throw new Error("Could not find the frame InDesign placed the graphic into.");
}

/** Anything the frame clean-up could not apply, for the panel to report. */
let lastTidyFailures = [];
/** Observed frame state after the most recent placement. */
let lastChrome = "";

function tidyFrame(doc, frame) {
  lastTidyFailures = [];
  // No plugin-owned object style: one added with objectStyles.add() captures
  // the document's default frame attributes and stamps them onto every
  // equation, which is where the 1pt stroke and corner radius came from.
  lastTidyFailures = lastTidyFailures.concat(neutralize(doc, frame));
  try { frame.textWrapPreferences.textWrapMode = idsn.TextWrapModes.NONE; } catch { /* ignore */ }
  // Stroke is cleared first: a stroke would sit outside the geometric bounds
  // the depth calculation is based on.
  frame.fit(idsn.FitOptions.FRAME_TO_CONTENT);
}

/**
 * Final pass, once the frame will not be touched again.
 *
 * Embedding a link replaces the frame's content, and anchoring changes how the
 * frame is treated, either of which can bring default object attributes back.
 * Clearing once up front is therefore not enough — and the readout has to come
 * from here, or it describes a state that no longer exists.
 */
function finishFrame(doc, frame) {
  lastTidyFailures = lastTidyFailures.concat(neutralize(doc, frame));
  lastChrome = describeChrome(frame);
}

/** Problems from the most recent placement, if any. */
function lastPlacementWarnings() {
  return lastTidyFailures;
}

/** What the frame actually looks like after placement — read back, not assumed. */
function lastFrameChrome() {
  return lastChrome;
}

/**
 * Shift the object down by `depth` so the maths baseline lands on the text
 * baseline.
 *
 * The sign convention of `anchorYoffset` is not worth guessing at, so the first
 * insert of a session probes it: nudge by a known amount, see which way the
 * frame actually moved, remember the answer.
 */
function applyBaselineOffset(frame, depthPt) {
  const settings = frame.anchoredObjectSettings;
  if (!depthPt) {
    try { settings.anchorYoffset = 0; } catch { /* ignore */ }
    return;
  }

  if (positiveIsDown === null) {
    const PROBE = 12;
    const before = tryGet(() => frame.geometricBounds[2], null);
    try {
      settings.anchorYoffset = PROBE;
      const after = tryGet(() => frame.geometricBounds[2], null);
      settings.anchorYoffset = 0;
      if (before !== null && after !== null && Math.abs(Math.abs(after - before) - PROBE) < 0.5) {
        positiveIsDown = after > before;
      }
    } catch { /* fall through to the documented convention */ }
  }

  // The UI convention is that a positive Y offset raises the object, so a
  // downward shift is negative. Only relied on if the probe was inconclusive.
  const down = positiveIsDown === null ? false : positiveIsDown;
  try {
    settings.anchorYoffset = down ? depthPt : -depthPt;
  } catch { /* some frames refuse; the equation merely sits a little high */ }
}

function anchorInline(frame, mode, depthPt) {
  const settings = tryGet(() => frame.anchoredObjectSettings, null);
  if (!settings) return;
  try {
    settings.anchoredPosition = mode === "display"
      ? idsn.AnchorPosition.ABOVE_LINE
      : idsn.AnchorPosition.INLINE_POSITION;
  } catch { /* leave InDesign's default */ }

  if (mode === "display") {
    try { settings.anchorXoffset = 0; } catch { /* ignore */ }
    try { settings.anchorYoffset = 0; } catch { /* ignore */ }
    try {
      settings.horizontalAlignment = idsn.HorizontalAlignment.CENTER_ALIGN;
    } catch { /* ignore */ }
  } else {
    applyBaselineOffset(frame, depthPt);
  }
}

/** Embed the artwork so the document does not depend on our temp file. */
function embed(frame) {
  const graphics = tryGet(() => frame.allGraphics, null) || [];
  for (let i = 0; i < graphics.length; i++) {
    const link = tryGet(() => graphics[i].itemLink, null);
    if (link && tryGet(() => link.isValid, false)) {
      try { link.unlink(); } catch { /* stays linked; still renders */ }
    }
  }
}

function clearContent(frame) {
  const graphics = tryGet(() => frame.allGraphics, null) || [];
  for (let i = graphics.length - 1; i >= 0; i--) {
    try { graphics[i].remove(); } catch { /* ignore */ }
  }
}

function isAnchored(frame) {
  const offset = tryGet(() => frame.storyOffset, null);
  return !!(offset && tryGet(() => offset.isValid, false));
}

function placeFloating(doc, path, metrics) {
  const page = tryGet(() => app.activeWindow.activePage, null) || doc.pages.item(0);
  const bounds = page.bounds; // [y1, x1, y2, x2], points
  const cx = (bounds[1] + bounds[3]) / 2;
  const cy = (bounds[0] + bounds[2]) / 2;
  const frame = page.rectangles.add({
    geometricBounds: [
      cy - metrics.height / 2, cx - metrics.width / 2,
      cy + metrics.height / 2, cx + metrics.width / 2,
    ],
  });
  frame.place(path);
  return frame;
}

/* ------------------------------------------ synchronous core (undo-safe) */

/** Place a new equation. Must run inside asOneUndo + withPoints. */
function placeNew(doc, path, metrics, record, target) {
  const restore = configurePdfPlacement();
  try {
    let frame;
    let anchored = false;
    if (target.kind === "text" && tryGet(() => target.insertionPoint.isValid, false)) {
      frame = frameOf(target.insertionPoint.place(path));
      anchored = true;
    } else {
      frame = placeFloating(doc, path, metrics);
    }
    tidyFrame(doc, frame);
    if (anchored) anchorInline(frame, record.mode, metrics.depth);
    embed(frame);
    finishFrame(doc, frame);
    writeRecord(frame, record);
    return { frame, anchored };
  } finally {
    restore();
  }
}

/**
 * Re-render into the frame that is already there, so the anchor point in the
 * text never moves. Must run inside asOneUndo + withPoints.
 */
function replaceIn(doc, frame, path, metrics, record) {
  const restore = configurePdfPlacement();
  try {
    clearContent(frame);
    frame.place(path);
    tidyFrame(doc, frame);
    if (isAnchored(frame)) anchorInline(frame, record.mode, metrics.depth);
    embed(frame);
    finishFrame(doc, frame);
    writeRecord(frame, record);
    return frame;
  } finally {
    restore();
  }
}

/* ---------------------------------------------------- async conveniences */

async function insert({ doc, asset, metrics, record, target }) {
  const path = await prepareAsset(asset);
  try {
    return asOneUndo("Insert Typst equation",
      () => withPoints(doc, () => placeNew(doc, path, metrics, record, target)));
  } finally {
    await discardAsset(path);
  }
}

async function update({ doc, frame, asset, metrics, record }) {
  const path = await prepareAsset(asset);
  try {
    return asOneUndo("Update Typst equation",
      () => withPoints(doc, () => ({ frame: replaceIn(doc, frame, path, metrics, record) })));
  } finally {
    await discardAsset(path);
  }
}

module.exports = {
  insert,
  update,
  prepareAsset,
  discardAsset,
  replaceIn,
  isAnchored,
  lastPlacementWarnings,
  lastFrameChrome,
};
