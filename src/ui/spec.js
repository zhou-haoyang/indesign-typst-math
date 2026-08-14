/**
 * Turning panel state into a render request, and back again.
 *
 * Pure: no `require` of a host module, no DOM. That is the point — this holds
 * the decisions worth asserting, and it used to be tangled with the InDesign
 * reads that make them untestable.
 *
 * The tangle was not incidental. `resolveTypography` performed a DOM read,
 * decided a size and colour from it, *and* assigned its explanations to a field
 * on the module's state object as a side effect of what read like a getter.
 * Here the caller does the read and passes what it found, and the notes come
 * back as a return value.
 */

/** What an empty colour box means, and what the old "Black" option meant. */
const DEFAULT_COLOR = "black";

/**
 * Tidy a hand-typed Typst colour expression.
 *
 * Whitespace only: anything more would mean reimplementing Typst's parser here
 * to guess at what is valid. A wrong value is a compile error, and a compile
 * error belongs to the preview, which already draws it under the artwork that
 * failed. The one thing worth collapsing is a newline, which a paste can carry
 * into a single-line field and which would break the `#set text(…)` line it
 * ends up in.
 */
function typstColor(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim() || DEFAULT_COLOR;
}

/**
 * The Typst literal a colour descriptor renders as.
 *
 * A second copy of `colorLiteral` in webview/template.js, which is unavoidable
 * — the panel is CommonJS and the webview is ESM, so the two cannot share a
 * module — and load-bearing: the panel shows this in the colour box while it is
 * on "Match text", so a divergence would tell the user one colour and render
 * another. tools/test-spec.mjs builds a real source through the template and
 * checks the two agree, which is what makes the duplication safe.
 *
 * One deliberate difference: a `{typst}` colour comes back as typed. The
 * template parenthesises it so a stray comma cannot break out of the `#set
 * text(…)` argument list; a box the text came from does not want the parens.
 */
function colorExpression(color) {
  if (color && typeof color.typst === "string" && color.typst.trim()) return color.typst.trim();
  if (!color || !color.values) return 'rgb("#000000")';
  if (color.space === "CMYK") {
    const [c, m, y, k] = color.values;
    return `cmyk(${+c}%, ${+m}%, ${+y}%, ${+k}%)`;
  }
  if (color.space === "GRAY") return `luma(${Math.round((color.values[0] / 100) * 255)})`;
  const [r, g, b] = color.values;
  const hex = [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v)))
    .toString(16).padStart(2, "0")).join("");
  return `rgb("#${hex}")`;
}

/**
 * What the two "Match text" boxes should show.
 *
 * Both are read-only in that mode, so the only useful thing to put in them is
 * the value the render is about to use — which is what `resolveTypography` has
 * just decided, fallbacks and all. Taking it from there rather than from a
 * second read of the document is the point: a box that disagreed with the
 * artwork beside it would be worse than the stale number it replaces.
 *
 * A fixed control gets nothing, because it shows what the user typed. That
 * text lives in `sizePt`/`colorText` and must survive a spell in "Match text"
 * untouched, which is why these are fields of their own.
 *
 * Returned as scalars rather than one object: the store compares with
 * Object.is, so a fresh object every preview would make every pass look like a
 * change and write the controls while someone was in one.
 */
function matchedFrom(state, typography) {
  return {
    // Rounded because InDesign hands back the occasional 12.000000000000002 and
    // the box is five characters wide. The render still uses the exact value;
    // the two cannot differ by enough to see.
    matchedSizePt: state.sizeMode === "auto"
      ? Math.round(Number(typography.size) * 100) / 100
      : null,
    matchedColorText: state.colorMode === "auto" ? colorExpression(typography.color) : "",
  };
}

/**
 * Does anything on screen need reading off the document?
 *
 * Asked before the read, so the caller can skip a DOM round trip entirely when
 * both size and colour are fixed.
 */
function wantsContext(state) {
  return state.sizeMode === "auto" || state.colorMode === "auto";
}

/**
 * The size and colour to render at.
 *
 * `auto` means "read it off the text the equation sits in", so `at` is whatever
 * the caller found there — or null when there was nothing to read, which is a
 * legitimate answer rather than a failure.
 *
 * @param {{size?: number, color?: object, notes?: string[]}|null} at
 * @param {object} black  the fallback colour, injected so this file need not
 *   reach into the InDesign layer for a constant
 * @returns {{size: number, color: object, notes: string[]}}
 */
function resolveTypography(state, at, black) {
  const notes = [];
  let size = state.sizePt;
  // Two shapes, and the backend takes either: a swatch read off the document
  // ({space, values}), or the Typst expression the user typed ({typst}). A
  // fixed colour has nothing to read and nothing to convert — it is already in
  // the language the template speaks. `black` is only the fallback for an
  // `auto` colour with no text to match.
  let color = state.colorMode === "auto" ? black : { typst: typstColor(state.colorText) };

  if (wantsContext(state)) {
    if (at) {
      if (state.sizeMode === "auto" && at.size) size = at.size;
      if (state.colorMode === "auto") color = at.color;
      notes.push(...(at.notes || []));
    } else if (state.sizeMode === "auto" && !state.editing) {
      // Nothing to match against; fall back rather than guess, and say so —
      // silently rendering at 10 pt beside 24 pt text looks like a bug.
      notes.push(`No text cursor; using ${size} pt.`);
    }
  }

  return { size, color, notes };
}

/** The request handed to a rendering backend. */
function toSpec(state, typography) {
  return {
    body: state.body,
    mode: state.mode,
    size: typography.size,
    color: typography.color,
    preamble: state.preamble,
  };
}

/**
 * Compiler diagnostics as one block of text.
 *
 * `info` is dropped: Typst emits them for things that are not wrong, and a
 * status line that reports them reads as a failure. Note that dropping them can
 * leave this empty even though the compile failed — callers must not treat ""
 * as success.
 */
function describeDiagnostics(diagnostics) {
  return (diagnostics || [])
    .filter((d) => d.severity !== "info")
    .map((d) => {
      const where = d.where === "preamble" ? "preamble " : "";
      const at = d.line != null
        ? `${where}${d.line}:${d.column || 1}: `
        : (where ? `${where}: ` : "");
      return `${at}${d.message}`;
    })
    .join("\n");
}

/**
 * A note when the selected equation was built against a different preamble.
 *
 * The artwork is a snapshot, so after a preamble edit the placed equation and
 * the preview legitimately disagree until a re-render. Without saying so, that
 * looks like a bug.
 *
 * @param {(text: string) => string} hashOf  injected to keep this file free of
 *   the label module, which reaches the InDesign DOM
 */
function staleNote(editing, preamble, hashOf) {
  if (!editing) return "";
  const stored = editing.record && editing.record.preambleHash;
  if (!stored || stored === hashOf(preamble)) return "";
  return "Built with a different preamble — re-render to sync.";
}

/**
 * The state a stored record implies.
 *
 * Returns a *partial* patch on purpose: a record written by an older version
 * may carry no `size` or `color`, and absent must mean "leave the toolbar
 * alone" rather than "reset it to the default".
 */
function stateFromRecord(record) {
  const patch = {
    body: record.body || "",
    mode: record.mode === "display" ? "display" : "inline",
  };
  if (record.size) {
    patch.sizeMode = record.size.mode === "fixed" ? "fixed" : "auto";
    patch.sizePt = record.size.pt || 10;
  }
  if (record.color) {
    patch.colorMode = record.color.mode === "auto" ? "auto" : "fixed";
    // The box is written only when the record has something to put in it. An
    // `auto` equation carries the swatch it was rendered from, which is not a
    // Typst expression and must not land in a field the user types into — and
    // selecting one is no reason to throw away what they had typed there.
    // A fixed record from before the box existed has no expression either: the
    // only fixed colour on offer then was black, which is what it now says.
    if (record.color.typst) patch.colorText = typstColor(record.color.typst);
    else if (patch.colorMode === "fixed") patch.colorText = DEFAULT_COLOR;
  }
  return patch;
}

module.exports = {
  wantsContext, resolveTypography, colorExpression, matchedFrom, toSpec,
  describeDiagnostics, staleNote, stateFromRecord,
};
