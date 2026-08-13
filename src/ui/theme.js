/**
 * Which palette the panel paints in, and keeping it current.
 *
 * Every obvious way to ask was measured and found dead in InDesign 21.4.1.4:
 *
 *   uxp.host.theme              undefined (Adobe documents only name, version,
 *                               uiLocale for ID; uxp.versions is {} too)
 *   matchMedia                  does not exist, so no prefers-color-scheme
 *   getComputedStyle(body)      .backgroundColor is "initial" — computed style
 *                               here returns *specified* values, so the old
 *                               luma fallback could never match
 *
 * With all three dead the previous `currentTheme()` returned "light"
 * unconditionally, and the panel served the light palette on a dark host
 * forever. Nothing errored; it just looked like a badly chosen grey.
 *
 * What does answer is the application itself. See `brightness` below.
 */
const { app } = require("indesign");

/**
 * InDesign's Color Theme has four presets and the property *snaps* to them:
 * writing 0.25 stores 0, writing 0.75 stores 0.51. The stored values are
 *
 *   0     Dark          chrome luma 0.61   host labels white
 *   0.5   Medium Dark               0.67                white
 *   0.51  Medium Light              0.86                black
 *   1     Light                     0.95                black
 *
 * so the boundary is the hundredth between 0.5 and 0.51, not the midpoint of
 * the range. Calibrated by setting each value and measuring; do not "tidy" this
 * to 0.75.
 */
const DARK_AT_OR_BELOW = 0.5;

/** Recognised only when the host says something we can actually act on. */
const NAMED = /^(lightest|light|medium|dark|darkest)$/i;

function tryGet(read, fallback) {
  try {
    const value = read();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** @returns {number|null} 0..1, or null when the preference cannot be read. */
function brightness() {
  const value = tryGet(() => Number(app.generalPreferences.uiBrightnessPreference), NaN);
  return Number.isFinite(value) ? value : null;
}

/**
 * Kept as the first tier even though it is undefined today: it costs one read,
 * and a future InDesign implementing it should win over a preference that is
 * only a proxy for the same thing. Guarded by NAMED so that a host returning
 * something unexpected falls through instead of being pattern-matched into a
 * confident wrong answer — which is exactly how this went wrong before.
 */
function hostTheme() {
  const raw = String(tryGet(() => require("uxp").host.theme, ""));
  if (!NAMED.test(raw)) return null;
  return /dark|medium/i.test(raw) ? "dark" : "light";
}

/** @returns {"dark"|"light"} */
function resolve() {
  const named = hostTheme();
  if (named) return named;
  const level = brightness();
  if (level !== null) return level <= DARK_AT_OR_BELOW ? "dark" : "light";
  // Nothing left to ask. Dark is the better guess than light: InDesign ships
  // dark by default, and three of the four presets on a fresh install are.
  return "dark";
}

/**
 * The classes the generated palette keys on, plus `theme-<name>` kept purely as
 * a hook for tools/render-panel.mjs. No colour hangs off `theme-*` any more —
 * see vendor/spectrum-theme.css, built by scripts/spectrum-theme.mjs.
 */
function classesFor(theme) {
  return `spectrum spectrum--medium spectrum--${theme} theme-${theme}`;
}

let applied = null;

/**
 * Idempotent and change-gated, so polling it costs nothing and calling it twice
 * is free.
 *
 * @param {(theme: string) => void} [onChange] told only when it really changed,
 *   so the webview is not sent a message every tick.
 * @returns {boolean} whether anything changed
 */
function apply(theme, onChange) {
  if (theme === applied) return false;
  const first = applied === null;
  applied = theme;
  document.body.className = classesFor(theme);
  // Worth a line because getting this wrong is not an error, just a panel that
  // is hard to read — and the raw reads are what tell you which tier answered.
  console.log(`[typst] theme: ${theme}` +
    ` · uiBrightness ${brightness()} · uxp.host.theme ${JSON.stringify(tryGet(() => require("uxp").host.theme, undefined))}`);
  if (onChange && !first) onChange(theme);
  return true;
}

/**
 * Poll, because there is no event. Cheap: one property read, and the panel is
 * already polling the selection three times as often.
 *
 * Deliberately not folded into that existing interval — the theme has to keep
 * tracking even if selection watching is ever made event-driven, and a wrong
 * palette is a good deal more visible than a stale selection.
 */
function watch(onChange, ms = 2000) {
  return setInterval(() => apply(resolve(), onChange), ms);
}

/** For tests: forget what was applied, so `apply` is testable in isolation. */
function reset() {
  applied = null;
}

module.exports = {
  resolve, apply, watch, brightness, classesFor, reset, DARK_AT_OR_BELOW,
};
