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
  wantsContext, resolveTypography, toSpec, describeDiagnostics,
  staleNote, stateFromRecord,
};
