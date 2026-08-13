#!/usr/bin/env node
/**
 * Unit checks for the Spectrum token extractor.
 *
 * The extractor turns @spectrum-css/tokens into the six literal colours the
 * panel needs, at `npm run setup`, so UXP's CSS parser never sees a var()
 * chain. Its failure mode is the dangerous kind: a stylesheet that is merely
 * *incomplete* still loads, and the panel then falls back to inherited colours
 * in a way that reads as a CSS mistake rather than a build one. So most of
 * what is checked here is that it throws instead of guessing.
 *
 * The fake filesystem is the point — these run with no node_modules and no
 * network. The last case is the one exception, and it is skipped rather than
 * failed when the package is not installed.
 *
 *   node tools/test-tokens.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildThemeCss, layerPaths, makeResolver, parseDeclarations, TOKENS,
} from "../scripts/spectrum-theme.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(46)}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}

function throws(name, fn, pattern) {
  let message = null;
  try {
    fn();
  } catch (err) {
    message = err.message;
  }
  const ok = message !== null && pattern.test(message);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(46)}${ok ? "" : `\n       got ${message === null ? "no throw" : message}`}`);
}

/* ------------------------------------------------------------- parsing */

check("parses a flat rule",
  [...parseDeclarations(".spectrum { --a: 1px; --b: rgb(1, 2, 3); }")],
  [["--a", "1px"], ["--b", "rgb(1, 2, 3)"]]);

check("tolerates no whitespace after the colon",
  [...parseDeclarations("--a:1px;")], [["--a", "1px"]]);

check("ignores a file that is not there",
  [...parseDeclarations(null)], []);

/* ----------------------------------------------------------- resolving */

const layers = (...sources) => sources.map(parseDeclarations);

check("resolves a var() chain to its literal",
  makeResolver(layers("--a: var(--b); --b: var(--c); --c: 4px;"))("--a"),
  "4px");

// The form UXP may not parse, and the whole reason this runs at build time.
check("expands rgba(var(--x-rgb)) into rgb()",
  makeResolver(layers("--g: rgba(var(--g-rgb)); --g-rgb: 198, 198, 198;"))("--g"),
  "rgb(198, 198, 198)");

// 103 tokens in 15.2.0 use this form. None of the six need it today, but
// mangling it would be silent, so it is pinned.
check("keeps the alpha on rgba(var(--x-rgb), a)",
  makeResolver(layers("--o: rgba(var(--k-rgb), 0.06); --k-rgb: 0, 0, 0;"))("--o"),
  "rgba(0, 0, 0, 0.06)");

check("resolves through a colour that is itself an alias",
  makeResolver(layers("--acc: var(--blue); --blue: rgba(var(--blue-rgb)); --blue-rgb: 2, 101, 220;"))("--acc"),
  "rgb(2, 101, 220)");

// The spectrum/ overlay is what makes accent blue rather than indigo; if layer
// order regressed, the panel would silently take Express's palette.
check("a later layer wins over an earlier one",
  makeResolver(layers("--accent: var(--indigo); --indigo: 1;", "--accent: var(--blue); --blue: 2;"))("--accent"),
  "2");

check("an earlier layer still supplies what a later one omits",
  makeResolver(layers("--base: 7; --x: var(--base);", "--x: var(--base);"))("--x"),
  "7");

throws("unknown token throws rather than resolving to nothing",
  () => makeResolver(layers("--a: var(--missing);"))("--a"), /unknown token --missing/);

throws("unknown top-level token throws",
  () => makeResolver(layers("--a: 1;"))("--nope"), /unknown token --nope/);

// Without the `seen` guard this hangs npm run setup instead of reporting.
throws("a cycle throws rather than hanging",
  () => makeResolver(layers("--a: var(--b); --b: var(--a);"))("--a"), /cycle resolving/);

throws("a self-reference throws",
  () => makeResolver(layers("--a: var(--a);"))("--a"), /cycle resolving/);

/* ------------------------------------------------------------- layering */

check("consults base then spectrum overlay, least specific first",
  layerPaths("dark"),
  ["global-vars.css", "spectrum/global-vars.css",
    "medium-vars.css", "spectrum/medium-vars.css",
    "dark-vars.css", "spectrum/dark-vars.css"]);

/* ------------------------------------------------------------- building */

const FAKE = {
  "global-vars.css": "--ui-src: var(--ramp); --radius: 4px;",
  "spectrum/global-vars.css": "--ramp: rgba(var(--ramp-rgb));",
  "light-vars.css": "--ramp-rgb: 1, 2, 3;",
  "dark-vars.css": "--ramp-rgb: 4, 5, 6;",
};
const fakeRead = (path) => FAKE[path] ?? null;
const built = buildThemeCss(fakeRead, {
  version: "test", tokens: { "--ui-x": "--ui-src", "--ui-r": "--radius" },
});

check("emits one rule per theme",
  [built.includes(".spectrum--light {"), built.includes(".spectrum--dark {")], [true, true]);
check("emits resolved literals, never a var()", /var\(/.test(built), false);
check("light and dark differ", [built.includes("rgb(1, 2, 3)"), built.includes("rgb(4, 5, 6)")], [true, true]);
check("names its source token in a comment", built.includes("/* --ui-src */"), true);
check("says it is generated", built.startsWith("/* Generated by"), true);
check("records the package version", built.includes("@spectrum-css/tokens test"), true);

// The layout moved between 13.x, 15.x and 16.x. An unattended bump that leaves
// the paths pointing at nothing must fail setup, not write an empty rule.
throws("a layout change with no declarations throws",
  () => buildThemeCss(() => null, { tokens: { "--ui-x": "--a" } }),
  /no token declarations found for "light"/);

/* ------------------------------------------------- the installed package */

const installed = join(root, "node_modules", "@spectrum-css", "tokens");
if (!existsSync(installed)) {
  console.log("  skip the real 15.2.0 package (run `npm install`)");
} else {
  const version = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version;
  check("the pin is still 15.2.0 — 16.x is Spectrum 2", version, "15.2.0");

  const read = (path) => {
    const file = join(installed, "dist", "css", path);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  };
  const real = buildThemeCss(read, { version });

  // Spectrum 1's accent is blue; Spectrum 2's is indigo rgb(59, 99, 251). And
  // 4px is what panel.css had already picked by hand, which is the evidence
  // that these are the ramps InDesign 21.4 is painting with.
  check("light accent is Spectrum 1 blue", real.includes("--ui-accent: rgb(2, 101, 220);"), true);
  check("radius is 4px, matching the hand-picked value", /--ui-radius: 4px;/.test(real), true);
  check("every alias is present in both themes",
    Object.keys(TOKENS).every((alias) => real.split(`${alias}:`).length === 3), true);
  check("no var() survives into the shipped file", /var\(/.test(real), false);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
