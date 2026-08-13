#!/usr/bin/env node
/**
 * Unit checks for finding the selected equation.
 *
 * The rule under test is one sentence and easy to invert by accident: look
 * inside a *text* selection for an anchored equation, but not inside a selected
 * page item. Getting it backwards would mean selecting a text frame silently
 * loaded whichever equation happened to live in it — which reads as the panel
 * editing the wrong thing for no visible reason.
 *
 * Also pinned: comparison by document id rather than object identity, because
 * two reads of the same page item hand back different JS proxies, so `===`
 * would report every poll as a new selection and reload the editor 1.4x a
 * second.
 *
 *   node tools/test-selection.mjs
 */
import Module from "node:module";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// src/id/doc.js reaches the host for its enums; stub it exactly as
// tools/test-prefs.mjs does so this runs under bare node.
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "indesign") return { app: {}, MeasurementUnits: {}, ColorSpace: {} };
  return load.call(this, request, ...rest);
};

const require = createRequire(import.meta.url);
const selection = require(join(root, "src/ui/selection.js"));

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(56)}${ok ? "\n" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}\n`}`);
}

/* Mocks shaped like the InDesign objects: a page item has geometricBounds, a
   text selection does not, and pageItems is a collection with .item(i). */
const equation = (id) => ({ id, __record: { body: `eq${id}` } });
const plain = (id) => ({ id });
const pageItem = (id, children = []) => ({
  id, geometricBounds: [0, 0, 10, 10],
  pageItems: { length: children.length, item: (i) => children[i] },
});
const textRun = (id, children = []) => ({
  id, pageItems: { length: children.length, item: (i) => children[i] },
});
const readRecord = (item) => (item && item.__record) || null;

/* --------------------------------------------------------- findEquation */

check("nothing selected", selection.findEquation([], readRecord), null);
check("null selection does not throw", selection.findEquation(null, readRecord), null);

check("an equation selected directly",
  selection.findEquation([equation(7)], readRecord).record, { body: "eq7" });

check("a plain item with nothing in it",
  selection.findEquation([plain(1)], readRecord), null);

// The reason the search looks one level in at all.
{
  const found = selection.findEquation([textRun(1, [equation(9)])], readRecord);
  check("an equation anchored inside a text selection is found", found && found.record, { body: "eq9" });
  check("and the frame is the inner item, not the selection", found && found.frame.id, 9);
}

// The reason it does not look inside everything.
check("an equation inside a selected page item is NOT found",
  selection.findEquation([pageItem(1, [equation(9)])], readRecord), null);

check("the first equation wins",
  selection.findEquation([equation(1), equation(2)], readRecord).frame.id, 1);

check("searching continues past an item with nothing in it",
  selection.findEquation([plain(1), equation(2)], readRecord).frame.id, 2);

check("a direct hit beats a nested one",
  selection.findEquation([equation(1), textRun(2, [equation(3)])], readRecord).frame.id, 1);

check("an item with no pageItems at all does not throw",
  selection.findEquation([{ id: 1 }], readRecord), null);

{
  // A collection whose length throws is what a stale proxy looks like.
  const hostile = { id: 1, pageItems: { get length() { throw new Error("stale"); } } };
  check("a throwing collection is survived", selection.findEquation([hostile], readRecord), null);
}

/* ---------------------------------------------------------- signatureOf */

check("nothing selected has a stable signature", selection.signatureOf([]), "none");
check("null selection", selection.signatureOf(null), "none");
check("one item", selection.signatureOf([{ id: 5, index: 2 }]), "1:5:2");
check("count is part of it", selection.signatureOf([{ id: 5 }, { id: 6 }]), "2:5:");
check("two reads of the same selection agree",
  selection.signatureOf([{ id: 5, index: 2 }]) === selection.signatureOf([{ id: 5, index: 2 }]), true);
check("a different item shows up",
  selection.signatureOf([{ id: 5 }]) === selection.signatureOf([{ id: 6 }]), false);
{
  const hostile = { get id() { throw new Error("stale"); } };
  check("an unreadable item still yields a signature", selection.signatureOf([hostile]), "1::");
}

/* ------------------------------------------------------- isSameEquation */

check("nothing being edited", selection.isSameEquation(null, { id: 1 }), false);
check("the same document id", selection.isSameEquation({ id: 4 }, { id: 4 }), true);
check("a different id", selection.isSameEquation({ id: 4 }, { id: 5 }), false);
// Identity is deliberately not the test: these are two proxies for one item.
check("a different proxy for the same id still matches",
  selection.isSameEquation({ id: 4 }, { ...{ id: 4 } }), true);
check("an unreadable id counts as different, not the same",
  selection.isSameEquation({ id: 4 }, { get id() { throw new Error("stale"); } }), false);
check("a null id counts as different", selection.isSameEquation({ id: null }, { id: null }), false);

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
