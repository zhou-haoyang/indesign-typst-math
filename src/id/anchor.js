/**
 * Finding the text an anchored frame hangs from.
 *
 * `PageItem.storyOffset` appears in InDesign scripting references but **does not
 * exist in this DOM** — reading it throws "Object does not support the property
 * or method 'storyOffset'". So does `PageItem.parentStory`. Verified against a
 * live InDesign 21.4 by reflection; see tools/probe-indesign.mjs.
 *
 * That mattered a great deal, because every use of it was wrapped in a
 * tolerant read: the throw was swallowed, the result was null, and three
 * features quietly did nothing — anchored frames were never recognised as
 * anchored, the text baseline could never be read, and "match text" could never
 * see the text it was supposed to match.
 *
 * The anchor is simply the frame's `parent`, which is a `Character` for an
 * anchored object and a Spread or Page otherwise.
 */
const { tryGet } = require("./doc");

const NOT_TEXT = new Set(["Spread", "Page", "MasterSpread", "Document", "Application"]);

/** The Character an anchored frame is attached to, or null if it is floating. */
function anchorCharacter(frame) {
  const parent = tryGet(() => frame.parent, null);
  if (!parent) return null;
  if (NOT_TEXT.has(tryGet(() => parent.constructor.name, ""))) return null;
  // Text-like parents answer to one of these; page items do not.
  const textish = tryGet(() => parent.insertionPoints, null) !== null
    || typeof tryGet(() => parent.baseline, null) === "number";
  return textish ? parent : null;
}

function isAnchored(frame) {
  return anchorCharacter(frame) !== null;
}

/** The y coordinate of the baseline the frame sits on, or null. */
function anchorBaseline(frame) {
  const anchor = anchorCharacter(frame);
  if (!anchor) return null;
  const direct = tryGet(() => anchor.baseline, null);
  if (typeof direct === "number") return direct;
  const line = tryGet(() => anchor.lines.item(0), null);
  const viaLine = line ? tryGet(() => line.baseline, null) : null;
  return typeof viaLine === "number" ? viaLine : null;
}

/** The story to recompose so anchored geometry settles before measuring. */
function anchorStory(frame) {
  const anchor = anchorCharacter(frame);
  return anchor ? tryGet(() => anchor.parentStory, null) : null;
}

module.exports = { anchorCharacter, anchorBaseline, anchorStory, isAnchored };
