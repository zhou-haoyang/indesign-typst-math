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
 *   reset it to the defaults.
 *
 *   node tools/test-spec.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The webview's own module, imported rather than mirrored: the panel keeps a
// copy of its colour literal, and this is where the two are held to each other.
// Plain browser-free ESM, so node loads it as it stands.
import { buildSource } from "../webview/template.js";

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
  sizeMode: "auto", sizePt: 10, colorMode: "auto", colorText: "black", editing: null,
};

/* --------------------------------------------------------- wantsContext */

check("auto size needs a read", spec.wantsContext({ ...base, colorMode: "fixed" }), true);
check("auto colour needs a read", spec.wantsContext({ ...base, sizeMode: "fixed" }), true);
check("both fixed needs no read at all",
  spec.wantsContext({ ...base, sizeMode: "fixed", colorMode: "fixed" }), false);

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
  const got = spec.resolveTypography({ ...base, colorMode: "fixed" }, at, BLACK);
  check("a fixed colour ignores the text", got.color, { typst: "black" });
  check("while auto size still reads it", got.size, 24);
}

{
  // The box holds a Typst expression, not a swatch: it reaches the backend as
  // one, and nothing on the way tries to parse or validate it.
  const at = { size: 24, color: RED, notes: [] };
  const state = { ...base, colorMode: "fixed", colorText: 'rgb("#cc0000")' };
  check("a fixed colour is handed over as typed",
    spec.resolveTypography(state, at, BLACK).color, { typst: 'rgb("#cc0000")' });
}

{
  // Empty is what the box says while it is being cleared and retyped, and it
  // has to render as something rather than as a compile error.
  const empty = { ...base, colorMode: "fixed", colorText: "   " };
  check("an empty colour box falls back to black",
    spec.resolveTypography(empty, null, BLACK).color, { typst: "black" });
  const pasted = { ...base, colorMode: "fixed", colorText: "cmyk(0%,\n100%, 0%, 0%)" };
  check("a pasted newline is collapsed, not left to break the set line",
    spec.resolveTypography(pasted, null, BLACK).color, { typst: "cmyk(0%, 100%, 0%, 0%)" });
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

/* ------------------------------------------------------ colorExpression */

check("CMYK reads back as a Typst cmyk literal",
  spec.colorExpression(BLACK), "cmyk(0%, 0%, 0%, 100%)");
check("RGB reads back as hex", spec.colorExpression(RED), 'rgb("#ff0000")');
check("grey reads back as luma", spec.colorExpression({ space: "GRAY", values: [50] }), "luma(128)");
check("a typed colour comes back as typed, without the template's parens",
  spec.colorExpression({ typst: ' rgb("#cc0000") ' }), 'rgb("#cc0000")');
check("and no colour at all is black", spec.colorExpression(null), 'rgb("#000000")');

{
  // The panel holds a second copy of the template's `colorLiteral` — CommonJS
  // and ESM cannot share a module — and the panel now *shows* its copy in the
  // colour box. So the check that matters is not the format but that the two
  // agree: a divergence would tell the user one colour and render another.
  const emitted = (color) => {
    const line = /fill: (.*?), top-edge/.exec(buildSource({ body: "x", color }).source);
    return line && line[1];
  };
  for (const color of [BLACK, RED, { space: "RGB", values: [12, 34, 56] },
    { space: "GRAY", values: [50] }, { space: "SOMETHING", values: [1, 2, 3] }, null]) {
    check(`the template emits the same for ${JSON.stringify(color)}`,
      emitted(color), spec.colorExpression(color));
  }
}

/* --------------------------------------------------------- matchedFrom */

{
  const typography = { size: 24, color: RED, notes: [] };
  check("a matched box reads back what the render resolved",
    spec.matchedFrom(base, typography),
    { matchedSizePt: 24, matchedColorText: 'rgb("#ff0000")' });
  // A fixed box shows what the user typed, which lives elsewhere in the state
  // and must survive a spell in "Match text" untouched.
  check("a fixed box is left to the user's own text",
    spec.matchedFrom({ ...base, sizeMode: "fixed", colorMode: "fixed" }, typography),
    { matchedSizePt: null, matchedColorText: "" });
  check("only the auto one of the pair is filled in",
    spec.matchedFrom({ ...base, colorMode: "fixed" }, typography),
    { matchedSizePt: 24, matchedColorText: "" });
  check("an InDesign float is rounded to something the box can show",
    spec.matchedFrom(base, { ...typography, size: 12.000000000000002 }).matchedSizePt, 12);
  // With no text to read, resolveTypography falls back to the fixed values, so
  // the box still shows what is about to be rendered.
  check("a fallback is reported as faithfully as a match",
    spec.matchedFrom(base, spec.resolveTypography(base, null, BLACK)),
    { matchedSizePt: 10, matchedColorText: "cmyk(0%, 0%, 0%, 100%)" });
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
check("a non-auto colour is a fixed one",
  spec.stateFromRecord({ color: { mode: "whatever" } }).colorMode, "fixed");
check("and a stored expression comes back into the box",
  spec.stateFromRecord({ color: { mode: "fixed", typst: "red" } }).colorText, "red");
// Records written before the box existed: the only fixed colour on offer then
// was black, so that is what the box should say.
check("a legacy black record loads as the word black",
  spec.stateFromRecord({ color: { mode: "black", space: "CMYK", values: [0, 0, 0, 100] } }),
  { body: "", mode: "inline", colorMode: "fixed", colorText: "black" });
// Selecting a match-text equation must not overwrite what the user has typed:
// its stored colour is the swatch it was rendered from, not an expression.
check("an auto colour leaves the box alone",
  Object.keys(spec.stateFromRecord({ color: { mode: "auto", space: "RGB", values: [1, 2, 3] } })).sort(),
  ["body", "colorMode", "mode"]);

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
