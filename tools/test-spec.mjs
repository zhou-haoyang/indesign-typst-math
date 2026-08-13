#!/usr/bin/env node
/**
 * Unit checks for turning panel state into a render request.
 *
 * These decisions used to sit inside an 875-line controller behind a live
 * InDesign, so none of them could be asserted. The ones that matter:
 *
 *   "auto" size and colour fall back rather than guess, and *say* they fell
 *   back — silently rendering at 10 pt beside 24 pt text reads as a bug;
 *
 *   an old record with no size or colour must leave the toolbar alone, not
 *   reset it to the defaults;
 *
 *   the two tab buffers survive a round trip, which is the invariant that keeps
 *   one editor serving both tabs.
 *
 *   node tools/test-spec.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const spec = require(join(root, "src/ui/spec.js"));

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(56)}${ok ? "\n" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}\n`}`);
}

const BLACK = { space: "CMYK", values: [0, 0, 0, 100] };
const RED = { space: "RGB", values: [255, 0, 0] };
const base = {
  tab: "equation", body: "x^2", preamble: "", mode: "inline",
  sizeMode: "auto", sizePt: 10, colorMode: "auto", editing: null,
};

/* --------------------------------------------------------- wantsContext */

check("auto size needs a read", spec.wantsContext({ ...base, colorMode: "black" }), true);
check("auto colour needs a read", spec.wantsContext({ ...base, sizeMode: "fixed" }), true);
check("both fixed needs no read at all",
  spec.wantsContext({ ...base, sizeMode: "fixed", colorMode: "black" }), false);

/* ---------------------------------------------------- resolveTypography */

{
  const at = { size: 24, color: RED, notes: [] };
  const got = spec.resolveTypography(base, at, BLACK);
  check("auto takes both from the text", [got.size, got.color], [24, RED]);
  check("and says nothing when it worked", got.notes, []);
}

{
  const at = { size: 24, color: RED, notes: [] };
  const got = spec.resolveTypography({ ...base, sizeMode: "fixed", sizePt: 12 }, at, BLACK);
  check("fixed size ignores the text", got.size, 12);
  check("but auto colour still reads it", got.color, RED);
}

{
  const at = { size: 24, color: RED, notes: [] };
  const got = spec.resolveTypography({ ...base, colorMode: "black" }, at, BLACK);
  check("black colour ignores the text", got.color, BLACK);
  check("while auto size still reads it", got.size, 24);
}

{
  // No text cursor: fall back, and say so.
  const got = spec.resolveTypography(base, null, BLACK);
  check("no context falls back to the stated size", got.size, 10);
  check("no context falls back to black", got.color, BLACK);
  check("and explains itself", got.notes, ["No text cursor; using 10 pt."]);
}

{
  // Editing an existing equation with nothing readable is not the same thing:
  // the equation has a size already, so there is nothing to warn about.
  const got = spec.resolveTypography({ ...base, editing: { record: {} } }, null, BLACK);
  check("editing stays quiet when there is nothing to read", got.notes, []);
}

{
  const at = { size: 0, color: RED, notes: [] };
  check("a zero size is not adopted", spec.resolveTypography(base, at, BLACK).size, 10);
}

{
  const at = { size: 24, color: RED, notes: ["A spot colour was approximated."] };
  check("notes from the read are passed through",
    spec.resolveTypography(base, at, BLACK).notes, ["A spot colour was approximated."]);
}

{
  const at = { size: 24, color: RED };
  check("a read with no notes field does not throw",
    spec.resolveTypography(base, at, BLACK).notes, []);
}

/* ------------------------------------------------------------- toSpec */

check("the spec carries what the backend needs",
  spec.toSpec({ ...base, preamble: "#let a = 1" }, { size: 24, color: RED }),
  { body: "x^2", mode: "inline", size: 24, color: RED, preamble: "#let a = 1" });

/* ------------------------------------------------ describeDiagnostics */

check("a diagnostic with a position",
  spec.describeDiagnostics([{ severity: "error", line: 3, column: 5, message: "unknown variable" }]),
  "3:5: unknown variable");
check("column defaults to 1",
  spec.describeDiagnostics([{ severity: "error", line: 3, message: "boom" }]), "3:1: boom");
check("a preamble diagnostic says so",
  spec.describeDiagnostics([{ severity: "error", where: "preamble", line: 2, column: 1, message: "boom" }]),
  "preamble 2:1: boom");
check("a preamble diagnostic with no line",
  spec.describeDiagnostics([{ severity: "error", where: "preamble", message: "boom" }]), "preamble : boom");
check("no position at all",
  spec.describeDiagnostics([{ severity: "error", message: "boom" }]), "boom");
check("several are joined by lines",
  spec.describeDiagnostics([{ severity: "error", message: "a" }, { severity: "warning", message: "b" }]),
  "a\nb");
// Typst emits info for things that are not wrong; reporting them reads as
// failure. The consequence is that "" does not mean the compile succeeded.
check("info diagnostics are dropped",
  spec.describeDiagnostics([{ severity: "info", message: "hint" }]), "");
check("no diagnostics at all", spec.describeDiagnostics(null), "");

/* -------------------------------------------------------- staleNote */

const hashOf = (text) => `h:${text}`;
check("nothing selected, nothing to say", spec.staleNote(null, "p", hashOf), "");
check("a record with no stored hash says nothing",
  spec.staleNote({ record: {} }, "p", hashOf), "");
check("a matching hash says nothing",
  spec.staleNote({ record: { preambleHash: "h:p" } }, "p", hashOf), "");
check("a different hash explains the disagreement",
  spec.staleNote({ record: { preambleHash: "h:old" } }, "p", hashOf),
  "Built with a different preamble — re-render to sync.");

/* --------------------------------------------------- stateFromRecord */

check("a full record",
  spec.stateFromRecord({ body: "y", mode: "display", size: { mode: "fixed", pt: 18 }, color: { mode: "auto" } }),
  { body: "y", mode: "display", sizeMode: "fixed", sizePt: 18, colorMode: "auto" });
check("an unknown mode falls back to inline",
  spec.stateFromRecord({ body: "y", mode: "nonsense" }).mode, "inline");
check("a missing body becomes empty", spec.stateFromRecord({}).body, "");
// An older record must not silently reset the toolbar to the defaults.
check("no size means no size keys",
  Object.keys(spec.stateFromRecord({ body: "y" })).sort(), ["body", "mode"]);
check("a size with no pt falls back to 10",
  spec.stateFromRecord({ size: { mode: "fixed" } }).sizePt, 10);
check("a non-auto colour is black",
  spec.stateFromRecord({ color: { mode: "whatever" } }).colorMode, "black");

/* ------------------------------------------------- tab buffers */

check("visible text on the equation tab", spec.visibleFor({ ...base, body: "b", preamble: "p" }), "b");
check("visible text on the preamble tab",
  spec.visibleFor({ ...base, tab: "preamble", body: "b", preamble: "p" }), "p");

check("switching to the tab already shown is a no-op",
  spec.swapTab({ ...base, tab: "equation" }, "equation", "b"), null);
check("leaving the equation tab saves the body",
  spec.swapTab({ ...base, tab: "equation" }, "preamble", "edited"),
  { tab: "preamble", body: "edited" });
check("leaving the preamble tab saves the preamble",
  spec.swapTab({ ...base, tab: "preamble" }, "equation", "edited"),
  { tab: "equation", preamble: "edited" });

{
  // The invariant that lets one editor serve both tabs: a round trip must leave
  // both buffers exactly as they were.
  let state = { ...base, tab: "equation", body: "B", preamble: "P" };
  state = { ...state, ...spec.swapTab(state, "preamble", spec.visibleFor(state)) };
  state = { ...state, ...spec.swapTab(state, "equation", spec.visibleFor(state)) };
  check("a there-and-back tab switch preserves both buffers",
    [state.body, state.preamble, state.tab], ["B", "P", "equation"]);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
