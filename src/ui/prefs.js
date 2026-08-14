/**
 * User-level preferences.
 *
 * Scope: this machine, this plugin, every document — the counterpart to the
 * per-document preamble on the document's script label and the per-equation
 * record on each frame. What belongs here is what you set once and expect to
 * find again next week: your macro library, and what a new equation should
 * start as.
 *
 * localStorage is a cache rather than storage — Adobe say so, and it goes when
 * the plugin is uninstalled — so nothing here may be load-bearing. Every read
 * has to survive the key being absent or holding something from an older
 * version, which is what `merge` is for.
 */

const STORAGE_KEY = "indesign-typst.prefs";
const VERSION = 1;

const MODES = ["inline", "display"];
const SIZE_MODES = ["auto", "fixed"];
const COLOR_MODES = ["auto", "fixed"];
/**
 * What a fixed colour was called before there was a box beside it to type one
 * into. It meant exactly what "black" in that box means now, so it is migrated
 * rather than discarded — `oneOf` would otherwise hand someone who had chosen
 * black a panel set to "Match text".
 */
const LEGACY_COLOR_MODES = { black: "fixed" };
// The panel's own input bounds (index.html): a value outside them would be
// rejected by the control and then written back, so keep the two in step.
const MIN_PT = 1;
const MAX_PT = 600;

const DEFAULTS = {
  mode: "inline",
  sizeMode: "auto",
  sizePt: 10,
  colorMode: "auto",
  colorText: "black",
};

function oneOf(value, allowed, fallback) {
  return allowed.indexOf(value) === -1 ? fallback : value;
}

/**
 * Fold stored preferences onto the defaults, discarding anything unusable.
 *
 * Pure, and the only part of this module worth testing — the storage around it
 * is deliberately dumb so that this is where the behaviour lives.
 */
function merge(stored) {
  const source = (stored && typeof stored === "object") ? stored : {};
  const eq = (source.newEquation && typeof source.newEquation === "object")
    ? source.newEquation : {};
  const pt = Number(eq.sizePt);
  return {
    v: VERSION,
    defaultPreamble: typeof source.defaultPreamble === "string" ? source.defaultPreamble : "",
    newEquation: {
      mode: oneOf(eq.mode, MODES, DEFAULTS.mode),
      sizeMode: oneOf(eq.sizeMode, SIZE_MODES, DEFAULTS.sizeMode),
      // Clamped, not rejected: 0.5 pt is a typo, not a request for 10 pt, and
      // silently snapping back to the default would hide that.
      sizePt: Number.isFinite(pt) ? Math.min(MAX_PT, Math.max(MIN_PT, pt)) : DEFAULTS.sizePt,
      colorMode: oneOf(LEGACY_COLOR_MODES[eq.colorMode] || eq.colorMode,
        COLOR_MODES, DEFAULTS.colorMode),
      // Any string, unvalidated: this is a Typst expression, and only Typst can
      // say whether it is one. An empty box is left empty rather than reset —
      // src/ui/spec.js decides what emptiness renders as, so the two places do
      // not have to agree on a default.
      colorText: typeof eq.colorText === "string" ? eq.colorText : DEFAULTS.colorText,
    },
  };
}

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return merge(raw ? JSON.parse(raw) : null);
  } catch {
    return merge(null);
  }
}

/**
 * Apply a partial update and return the stored result.
 * `newEquation` merges field by field, so a caller can set one control without
 * having to hand back the other three.
 */
function write(patch) {
  const current = read();
  const next = merge({
    ...current,
    ...patch,
    newEquation: { ...current.newEquation, ...(patch && patch.newEquation) },
  });
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
  return next;
}

module.exports = { read, write, merge, STORAGE_KEY, MIN_PT, MAX_PT };
