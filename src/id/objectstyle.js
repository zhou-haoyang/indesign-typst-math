/**
 * A dedicated object style for equation frames.
 *
 * This is the one genuine "let InDesign own it" lever available: with every
 * equation carrying the same style, a user can change how all of them behave
 * from one place instead of touching frames one at a time.
 *
 * Anchored-object options are deliberately left out of the style, because the
 * Y offset is computed per equation and a style that included it would stamp
 * over that.
 */
const idsn = require("indesign");
const { tryGet } = require("./doc");

const STYLE_NAME = "Typst Equation";

function ensureObjectStyle(doc) {
  const existing = doc.objectStyles.itemByName(STYLE_NAME);
  if (tryGet(() => existing.isValid, false)) return existing;

  const style = doc.objectStyles.add({ name: STYLE_NAME });
  const none = doc.swatches.itemByName("None");
  try { style.enableFill = true; style.fillColor = none; } catch { /* ignore */ }
  try { style.enableStroke = true; style.strokeColor = none; style.strokeWeight = 0; } catch { /* ignore */ }
  try {
    style.enableTextWrapAndOthers = true;
    style.textWrapPreferences.textWrapMode = idsn.TextWrapModes.NONE;
  } catch { /* ignore */ }
  // Keep the style out of the business of positioning anchored objects.
  try { style.enableAnchoredObjectOptions = false; } catch { /* ignore */ }
  try { style.enableFrameFittingOptions = false; } catch { /* ignore */ }
  return style;
}

module.exports = { ensureObjectStyle, STYLE_NAME };
