#!/usr/bin/env node
/**
 * Unit checks for the two storage layers the settings split introduced.
 *
 * `src/ui/prefs.js` holds what is per-user (the default preamble, what a new
 * equation starts as) in localStorage, which Adobe describe as a cache rather
 * than storage — so every read has to survive the key being absent, corrupt, or
 * left over from an older version.
 *
 * `src/id/label.js` holds what is per-document. The interesting case there is
 * telling "this document has never had a preamble" from "this document's
 * preamble is deliberately empty": `extractLabel` returns "" for both, and if
 * they are conflated then a preamble someone cleared on purpose is re-seeded
 * from their default on every panel reload, and the setting appears not to
 * stick.
 *
 *   node tools/test-prefs.mjs
 */
import Module from "node:module";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

// label.js reaches the DOM through doc.js, which requires the host module.
// Stubbing it is what lets the envelope logic be tested without InDesign.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "indesign") return { app: {}, MeasurementUnits: {}, ColorSpace: {} };
  return load.call(this, request, ...rest);
};

// prefs.js touches localStorage lazily, so a stub here is enough to exercise
// the whole round trip rather than just the pure merge.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const prefs = require(join(root, "src/ui/prefs.js"));
const label = require(join(root, "src/id/label.js"));

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/* ------------------------------------------------------------ prefs.merge */

console.log("prefs.merge folds stored values onto the defaults:");
{
  const d = prefs.merge(null);
  check("nothing stored gives the panel's own defaults",
    d.defaultPreamble === "" && d.newEquation.mode === "inline" &&
    d.newEquation.sizeMode === "auto" && d.newEquation.sizePt === 10 &&
    d.newEquation.colorMode === "auto" && d.newEquation.colorText === "black",
    JSON.stringify(d.newEquation));
}
{
  const d = prefs.merge({
    newEquation: {
      mode: "display", sizeMode: "fixed", sizePt: 11,
      colorMode: "fixed", colorText: 'rgb("#cc0000")',
    },
  });
  check("valid values pass through untouched",
    d.newEquation.mode === "display" && d.newEquation.sizeMode === "fixed" &&
    d.newEquation.sizePt === 11 && d.newEquation.colorMode === "fixed" &&
    d.newEquation.colorText === 'rgb("#cc0000")',
    JSON.stringify(d.newEquation));
}
{
  // "black" was the fixed colour before there was a box to type one into.
  // Falling back to "auto" would silently hand someone who chose it a panel set
  // to match the text instead.
  const d = prefs.merge({ newEquation: { colorMode: "black" } });
  check("the old black setting migrates to fixed black",
    d.newEquation.colorMode === "fixed" && d.newEquation.colorText === "black",
    JSON.stringify(d.newEquation));
}
{
  // Only Typst can say whether an expression is one, so nothing here judges it
  // — but a non-string would reach a control that expects one.
  check("a colour expression is stored as typed",
    prefs.merge({ newEquation: { colorText: "  luma(30%) " } }).newEquation.colorText
      === "  luma(30%) ");
  check("a non-string colour falls back to the default",
    prefs.merge({ newEquation: { colorText: { evil: true } } }).newEquation.colorText === "black");
}
{
  const d = prefs.merge({ newEquation: { mode: "nonsense", sizeMode: "", colorMode: 7 } });
  check("unknown enum values fall back rather than reaching the control",
    d.newEquation.mode === "inline" && d.newEquation.sizeMode === "auto" &&
    d.newEquation.colorMode === "auto", JSON.stringify(d.newEquation));
}
{
  // Clamped rather than replaced: 0.5 pt is a typo, and snapping silently back
  // to 10 pt would hide it.
  check("point size below the panel's minimum clamps up",
    prefs.merge({ newEquation: { sizePt: 0 } }).newEquation.sizePt === prefs.MIN_PT);
  check("point size above the panel's maximum clamps down",
    prefs.merge({ newEquation: { sizePt: 1e6 } }).newEquation.sizePt === prefs.MAX_PT);
  check("a non-numeric point size falls back to the default",
    prefs.merge({ newEquation: { sizePt: "abc" } }).newEquation.sizePt === 10);
}
{
  check("a non-string default preamble becomes empty",
    prefs.merge({ defaultPreamble: { evil: true } }).defaultPreamble === "");
  check("garbage in newEquation does not throw",
    prefs.merge({ newEquation: "not an object" }).newEquation.mode === "inline");
}

/* ------------------------------------------------------- prefs round trip */

console.log("\nprefs survive storage being empty, partial or corrupt:");
{
  store.clear();
  check("reading an empty store gives the defaults", prefs.read().newEquation.sizePt === 10);
}
{
  store.clear();
  prefs.write({ newEquation: { sizeMode: "fixed", sizePt: 11 } });
  prefs.write({ defaultPreamble: "#let vb(x) = math.bold(x)" });
  const after = prefs.read();
  check("writing the preamble leaves the equation defaults alone",
    after.newEquation.sizeMode === "fixed" && after.newEquation.sizePt === 11,
    JSON.stringify(after.newEquation));
  check("and the preamble round-trips", after.defaultPreamble === "#let vb(x) = math.bold(x)");
}
{
  prefs.write({ newEquation: { mode: "display" } });
  const after = prefs.read();
  check("a partial newEquation patch keeps the fields it did not mention",
    after.newEquation.mode === "display" && after.newEquation.sizePt === 11,
    JSON.stringify(after.newEquation));
}
{
  store.set(prefs.STORAGE_KEY, "{not json");
  check("corrupt storage reads as the defaults instead of throwing",
    prefs.read().newEquation.sizePt === 10);
}

/* ---------------------------------------------- document preamble envelope */

console.log("\nthe document preamble tells absent from deliberately empty:");

/** Stands in for a Document: insertLabel/extractLabel over a plain object. */
const mockDoc = (initial) => {
  const labels = { ...initial };
  return {
    labels,
    extractLabel: (k) => (k in labels ? labels[k] : ""),
    insertLabel: (k, v) => { labels[k] = v; },
  };
};
const KEY = "indesign-typst:preamble";

{
  const doc = mockDoc({});
  const r = label.readDocumentPreamble(doc);
  check("a document that never had one reports present:false",
    r.present === false && r.text === "", JSON.stringify(r));
}
{
  // The case that makes seeding correct: cleared on purpose must stay cleared.
  const doc = mockDoc({});
  label.writeDocumentPreamble(doc, "");
  const r = label.readDocumentPreamble(doc);
  check("an explicitly emptied preamble reports present:true",
    r.present === true && r.text === "", JSON.stringify(r));
}
{
  const doc = mockDoc({});
  label.writeDocumentPreamble(doc, "#set text(font: \"NCM\")");
  const r = label.readDocumentPreamble(doc);
  check("a written preamble round-trips",
    r.present === true && r.text === "#set text(font: \"NCM\")", JSON.stringify(r));
}
{
  // Documents saved before the envelope hold bare text and must still read.
  const doc = mockDoc({ [KEY]: "#let vb(x) = math.bold(x)" });
  const r = label.readDocumentPreamble(doc);
  check("a legacy bare-text preamble still reads, as present",
    r.present === true && r.text === "#let vb(x) = math.bold(x)", JSON.stringify(r));
}
{
  const doc = mockDoc({ [KEY]: "#let vb(x) = math.bold(x)" });
  label.writeDocumentPreamble(doc, label.readDocumentPreamble(doc).text);
  const r = label.readDocumentPreamble(doc);
  check("and upgrades to the envelope on the next write",
    r.text === "#let vb(x) = math.bold(x)" && doc.labels[KEY].indexOf("{") === 0,
    doc.labels[KEY]);
}
{
  const doc = mockDoc({ [KEY]: "{\"v\":1,\"text\":" });
  const r = label.readDocumentPreamble(doc);
  check("a half-written envelope degrades to bare text rather than throwing",
    r.present === true, JSON.stringify(r));
}

/* ------------------------------------------------------ the staleness hash */

console.log("\nthe preamble hash distinguishes preambles:");
{
  check("same text hashes the same", label.hash("#let a = 1") === label.hash("#let a = 1"));
  check("different text hashes differently", label.hash("#let a = 1") !== label.hash("#let a = 2"));
  check("empty is stable", label.hash("") === label.hash(""));
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
