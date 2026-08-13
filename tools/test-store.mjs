#!/usr/bin/env node
/**
 * Unit checks for the panel's state store and status rules.
 *
 * Both modules exist so that behaviour which used to be spread through an
 * 875-line controller — and asserted nowhere — can be stated as a table. The
 * two cases worth reading are:
 *
 *   "no notify when nothing changed", which is why typing in the editor does
 *   not have its caret yanked to the start every 700 ms by the selection poll;
 *
 *   the status block, which is CLAUDE.md's paragraph on what the panel is
 *   allowed to say, turned into assertions.
 *
 *   node tools/test-store.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { createStore, changed } = require(join(root, "src/ui/store.js"));
const status = require(join(root, "src/ui/status.js"));

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(56)}${ok ? "\n" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}\n`}`);
}

/* -------------------------------------------------------------------- store */

{
  const store = createStore({ tab: "equation", body: "", busy: false });
  check("get returns the initial state", store.get().tab, "equation");
  check("set reports a real change", store.set({ body: "x^2" }), true);
  check("set merges shallowly", store.get(), { tab: "equation", body: "x^2", busy: false });
  check("set leaves untouched keys alone", store.get().tab, "equation");
}

{
  // The caret bug, in three lines. The selection poll re-derives most of the
  // state every 700 ms; if an identical patch counted as a change, every tick
  // would run a view pass and every view pass writes .value on the editor.
  const store = createStore({ body: "x^2", sizePt: 10 });
  const seen = [];
  store.subscribe((next) => seen.push(next.body));
  check("no notify when nothing changed", store.set({ body: "x^2" }), false);
  check("no subscriber ran", seen, []);
  check("no notify for an empty patch", store.set({}), false);
  check("no notify for a null patch", store.set(null), false);
  check("a change among no-ops still notifies", store.set({ body: "x^2", sizePt: 12 }), true);
  check("subscriber ran exactly once", seen.length, 1);
}

{
  const store = createStore({ n: NaN, z: 0 });
  check("NaN settles rather than looking like a change", store.set({ n: NaN }), false);
  check("-0 does not masquerade as a change", store.set({ z: -0 }), true);
}

{
  const store = createStore({ a: 1 });
  const calls = [];
  store.subscribe((next, previous) => calls.push([previous.a, next.a]));
  store.set({ a: 2 });
  check("subscribers see both states", calls, [[1, 2]]);
}

{
  // A broken settings dialog must not silently kill the live preview: the panel
  // is one JS context and there is nothing else to catch this.
  const store = createStore({ a: 1 });
  const survived = [];
  const errors = [];
  const realError = console.error;
  console.error = (line) => errors.push(String(line));
  store.subscribe(() => { throw new Error("boom"); });
  store.subscribe(() => survived.push("ran"));
  const changedOk = store.set({ a: 2 });
  console.error = realError;
  check("a throwing subscriber does not stop the others", survived, ["ran"]);
  check("set still reports the change", changedOk, true);
  check("the failure is reported, not swallowed", errors.length, 1);
}

{
  const store = createStore({ a: 1 });
  const seen = [];
  const off = store.subscribe(() => seen.push("x"));
  store.set({ a: 2 });
  off();
  store.set({ a: 3 });
  check("unsubscribe stops notifications", seen.length, 1);
}

{
  // A subscriber that removes itself mid-notify must not cause its neighbour to
  // be skipped, which is what iterating the live set would do.
  const store = createStore({ a: 1 });
  const seen = [];
  const off = store.subscribe(() => { seen.push("first"); off(); });
  store.subscribe(() => seen.push("second"));
  store.set({ a: 2 });
  check("self-removal does not skip the next subscriber", seen, ["first", "second"]);
}

check("changed detects one key", changed({ a: 1, b: 2 }, { a: 1, b: 3 }, "b"), true);
check("changed ignores keys not asked about", changed({ a: 1, b: 2 }, { a: 1, b: 3 }, "a"), false);
check("changed accepts several keys", changed({ a: 1, b: 2 }, { a: 9, b: 2 }, "a", "b"), true);

/* ------------------------------------------------------------------- status */

const T0 = 1_000_000;

{
  const quiet = status.next(status.EMPTY, { text: "", kind: "" }, T0);
  check("success says nothing", quiet.text, "");
}

{
  // A placement result must survive the preview that inserting itself triggers.
  const placed = status.next(status.EMPTY, { text: "Inserted on the page.", sticky: true }, T0);
  const routine = status.next(placed, { text: "A spot colour was approximated." }, T0 + 200);
  check("a sticky result resists a routine update", routine.text, "Inserted on the page.");
  check("ignoring returns the identical object, so no view pass", routine === placed, true);

  const later = status.next(placed, { text: "A spot colour was approximated." }, T0 + status.STICKY_MS + 1);
  check("stickiness expires", later.text, "A spot colour was approximated.");

  const error = status.next(placed, { text: "Could not render.", kind: "error" }, T0 + 200);
  check("an error beats a sticky message", error.text, "Could not render.");
  check("errors are themselves sticky", error.stickyUntil, T0 + 200 + status.STICKY_MS);

  const busy = status.next(placed, { text: "Inserting…", kind: "busy" }, T0 + 200);
  check("progress interrupts a sticky message", busy.text, "Inserting…");
  check("but progress does not become sticky", busy.stickyUntil, 0);
}

{
  // setBusy(false) has to take down its own message, or a silent success leaves
  // "Inserting…" standing and reading as a hang.
  const busy = status.next(status.EMPTY, { text: "Inserting…", kind: "busy" }, T0);
  check("clearBusy takes down progress", status.clearBusy(busy).text, "");

  const error = status.next(status.EMPTY, { text: "No document open.", kind: "error" }, T0);
  check("clearBusy leaves an error standing", status.clearBusy(error).text, "No document open.");
  check("clearBusy leaves an error object untouched", status.clearBusy(error) === error, true);

  const note = status.next(status.EMPTY, { text: "Preamble has moved on." }, T0);
  check("clearBusy leaves a note standing", status.clearBusy(note).text, "Preamble has moved on.");
}

{
  check("busy carries its kind", status.className({ text: "x", kind: "busy" }), "status busy");
  check("error carries its kind", status.className({ text: "x", kind: "error" }), "status error");
  check("a plain note carries none", status.className({ text: "x", kind: "" }), "status");
}

{
  check("errors are logged", status.worthLogging({ text: "x", kind: "error", stickyUntil: 0 }), true);
  check("sticky results are logged", status.worthLogging({ text: "x", kind: "", stickyUntil: T0 }), true);
  check("routine notes are not", status.worthLogging({ text: "x", kind: "", stickyUntil: 0 }), false);
  check("nothing is not", status.worthLogging(status.EMPTY), false);
}

{
  const same = status.next(status.EMPTY, { text: "", kind: "" }, T0);
  check("an unchanged status returns the identical object", same === status.EMPTY, true);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
