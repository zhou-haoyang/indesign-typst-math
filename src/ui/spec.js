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

/** What the editor shows when a tab is empty. */
const PLACEHOLDER = {
  equation: "Typst math, e.g.  sum_(i=1)^n x_i / 2",
  preamble: "#let vb(x) = math.bold(x)\n#set text(font: \"New Computer Modern\")",
};

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
  let color = black;

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
    patch.colorMode = record.color.mode === "auto" ? "auto" : "black";
  }
  return patch;
}

/** Which buffer the one editor is currently showing. */
function visibleFor(state) {
  return state.tab === "preamble" ? state.preamble : state.body;
}

/**
 * Switching tabs, given what the editor currently shows.
 *
 * One editor serves both tabs — two of them, with the inactive one hidden, left
 * the preamble permanently unfocusable — so a switch means writing the visible
 * text back to the buffer it belongs to before loading the other.
 *
 * @returns {object|null} a patch, or null when already on that tab
 */
function swapTab(state, name, visibleText) {
  if (state.tab === name) return null;
  const patch = { tab: name };
  if (state.tab === "preamble") patch.preamble = visibleText;
  else patch.body = visibleText;
  return patch;
}

module.exports = {
  PLACEHOLDER, wantsContext, resolveTypography, toSpec, describeDiagnostics,
  staleNote, stateFromRecord, visibleFor, swapTab,
};
