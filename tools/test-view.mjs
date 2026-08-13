#!/usr/bin/env node
/**
 * Unit checks for the panel's view.
 *
 * These are the checks that used to be a list of things to try by hand after
 * every reload — type in the editor and watch the caret, type a decimal into
 * the size field, switch tabs, select an equation. They are reachable now only
 * because `panel-view.js` requires nothing but the store and three pure
 * modules, so a small DOM stub is enough to drive it.
 *
 * What a stub cannot tell you stays manual: whether UXP lays any of this out,
 * whether a widget honours a property, and whether the thing is legible. This
 * asserts the *logic* of when a control is written, which is where the
 * regressions live.
 *
 *   node tools/test-view.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* ---------------------------------------------------------------- DOM stub */

class Element {
  constructor(id) {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.className = "";
    this.attributes = {};
    this.listeners = {};
    this.classes = new Set();
    // Counts every write, so a test can prove a control was left alone rather
    // than merely written the same value — which is the whole caret question.
    this.writes = 0;
  }

  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() { globalThis.document.activeElement = this; }

  get classList() {
    return {
      toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }
}

const elements = new Map();
globalThis.document = {
  activeElement: null,
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  },
};

const at = (id) => globalThis.document.getElementById(id);
// Track writes through the property, so "was it written" is answerable.
for (const id of ["editor", "size-pt", "mode", "size-mode", "color-mode"]) {
  const element = at(id);
  let held = "";
  Object.defineProperty(element, "value", {
    get: () => held,
    set(next) { held = next; element.writes++; },
  });
}

// The view mirrors important statuses to the console; that is deliberate
// behaviour, not something these tests need to read.
const realLog = console.log;
const logged = [];
console.log = (...args) => logged.push(args.join(" "));

const require = createRequire(import.meta.url);
const { createStore } = require(join(root, "src/ui/store.js"));
const statusModule = require(join(root, "src/ui/status.js"));
const view = require(join(root, "src/ui/panel-view.js"));

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(56)}${ok ? "\n" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}\n`}`);
}

const INITIAL = {
  tab: "equation", body: "", preamble: "", mode: "inline", sizeMode: "auto",
  sizePt: 10, colorMode: "auto", editing: null, lastMetrics: null, busy: false,
  preambleFromDefault: false, status: statusModule.EMPTY,
};

const calls = [];
function mount(overrides = {}) {
  calls.length = 0;
  globalThis.document.activeElement = null;
  for (const element of elements.values()) {
    element.classes.clear();
    element.writes = 0;
    element.listeners = {};
  }
  const store = createStore({ ...INITIAL, ...overrides });
  const handlers = {};
  for (const name of ["preview", "commit", "revert", "settings", "savePreamble",
    "saveDefaultPreamble", "resetDefaultPreamble"]) {
    handlers[name] = () => calls.push(name);
  }
  const mounted = view.create(store, handlers);
  mounted.paint();
  return store;
}

/* ------------------------------------------------------------- first paint */

{
  mount({ body: "x^2" });
  check("paints the editor from state", at("editor").value, "x^2");
  check("paints the placeholder", at("editor").attributes.placeholder.startsWith("Typst math"), true);
  check("Insert is disabled with no metrics", at("insert").disabled, true);
  check("Insert reads Insert when not editing", at("insert").textContent, "Insert");
  check("Revert is hidden when not editing", at("revert").classList.contains("hidden"), true);
  check("the equation tab is active", at("tab-equation").classList.contains("active"), true);
  check("preamble actions are hidden", at("preamble-actions").classList.contains("hidden"), true);
}

/* ------------------------------------------------------------------ caret */

{
  // The bug this guards: the selection poll re-derives state every 700 ms. If
  // the view wrote the editor on every buffer change, each tick would reset the
  // caret to the start while someone was typing.
  const store = mount({ body: "x^2" });
  at("editor").focus();
  const before = at("editor").writes;
  store.set({ body: "x^2 + 1" });
  check("a focused editor is not rewritten underneath the user",
    at("editor").writes, before);

  globalThis.document.activeElement = null;
  store.set({ body: "y^2" });
  check("an idle editor does take the new text", at("editor").value, "y^2");
}

{
  // Same hazard, worse symptom: parseFloat("1.") is 1, so writing the state
  // back while it is being typed would delete the decimal point.
  const store = mount({ sizeMode: "fixed", sizePt: 10 });
  at("size-pt").focus();
  at("size-pt").value = "1.";
  const before = at("size-pt").writes;
  store.set({ sizePt: 1 });
  check("a focused size field keeps a half-typed decimal",
    [at("size-pt").value, at("size-pt").writes], ["1.", before]);
}

{
  const store = mount({ mode: "inline" });
  const before = at("mode").writes;
  store.set({ sizePt: 12 });   // a change in the same render branch
  check("a control already showing the value is not rewritten", at("mode").writes, before);
}

/* ------------------------------------------------------------------- tabs */

{
  const store = mount({ body: "B", preamble: "P" });
  at("tab-preamble").fire("click");
  check("switching tab loads the other buffer", at("editor").value, "P");
  check("the preamble tab is active", at("tab-preamble").classList.contains("active"), true);
  check("the equation tab is not", at("tab-equation").classList.contains("active"), false);
  check("preamble actions appear", at("preamble-actions").classList.contains("hidden"), false);
  check("the placeholder follows the tab", at("editor").attributes.placeholder.startsWith("#let"), true);
  check("the store agrees", store.get().tab, "preamble");

  at("tab-equation").fire("click");
  check("and back again", at("editor").value, "B");
  check("both buffers survived the round trip",
    [store.get().body, store.get().preamble], ["B", "P"]);
}

{
  // Switching tabs must reload the editor even though the editor is focused —
  // it is focused *because* switchTab focuses it, and a naive idle-guard would
  // then refuse to load the buffer.
  const store = mount({ body: "B", preamble: "P" });
  at("editor").focus();
  at("tab-preamble").fire("click");
  check("a tab switch reloads a focused editor", at("editor").value, "P");
  check("and leaves focus in the editor", globalThis.document.activeElement, at("editor"));
  check("store tab followed", store.get().tab, "preamble");
}

/* --------------------------------------------------------------- selection */

{
  // Selecting a different equation reloads the editor even if focus happens to
  // be in the box; the code this replaced wrote it unconditionally.
  const store = mount({ body: "old" });
  at("editor").focus();
  store.set({ editing: { id: 1, record: {} }, body: "new" });
  check("selecting an equation reloads a focused editor", at("editor").value, "new");
  check("Insert becomes Update", at("insert").textContent, "Update");
  check("Revert appears", at("revert").classList.contains("hidden"), false);

  store.set({ editing: null });
  check("deselecting restores Insert", at("insert").textContent, "Insert");
  check("and hides Revert", at("revert").classList.contains("hidden"), true);
}

/* ------------------------------------------------------------------ status */

{
  const store = mount();
  store.set({ status: { text: "Could not render.", kind: "error", stickyUntil: 0 } });
  check("the status text is drawn", at("status").textContent, "Could not render.");
  check("and carries its kind", at("status").className, "status error");

  store.set({ status: statusModule.EMPTY });
  check("an empty status empties the element", at("status").textContent, "");
  check("and drops the kind", at("status").className, "status");
}

/* ------------------------------------------------------------------ insert */

{
  const store = mount();
  store.set({ lastMetrics: { width: 1 } });
  check("metrics enable Insert", at("insert").disabled, false);
  store.set({ busy: true });
  check("busy disables it again", at("insert").disabled, true);
  store.set({ busy: false });
  check("and finishing re-enables it", at("insert").disabled, false);
  store.set({ lastMetrics: null });
  check("losing the metrics disables it", at("insert").disabled, true);
}

/* ---------------------------------------------------------------- handlers */

{
  const store = mount();
  at("editor").value = "x";
  at("editor").fire("input");
  check("typing updates the body", store.get().body, "x");
  check("and asks for a preview", calls, ["preview"]);

  at("editor").fire("keydown", { metaKey: true, key: "Enter", preventDefault() {} });
  check("cmd+enter commits", calls.includes("commit"), true);

  at("insert").fire("click");
  check("Insert commits", calls.filter((c) => c === "commit").length, 2);

  at("revert").fire("click");
  check("Revert reverts", calls.includes("revert"), true);

  at("settings-toggle").fire("click");
  check("the gear opens settings", calls.includes("settings"), true);
}

{
  const store = mount({ tab: "preamble", preamble: "P" });
  at("editor").value = "P2";
  at("editor").fire("input");
  check("editing the preamble updates that buffer", store.get().preamble, "P2");
  check("and marks it as this document's", store.get().preambleFromDefault, false);
  check("and persists it", calls.includes("savePreamble"), true);

  at("preamble-save-default").fire("click");
  check("save-as-default is wired", calls.includes("saveDefaultPreamble"), true);
  at("preamble-reset-default").fire("click");
  check("reset-to-default is wired", calls.includes("resetDefaultPreamble"), true);
}

{
  const store = mount();
  at("mode").value = "display";
  at("mode").fire("change");
  check("the style control updates state", store.get().mode, "display");
  check("and asks for a preview", calls.includes("preview"), true);

  at("size-mode").value = "fixed";
  at("size-mode").fire("change");
  check("fixed size enables the point field", at("size-pt").disabled, false);
  at("size-mode").value = "auto";
  at("size-mode").fire("change");
  check("auto size disables it again", at("size-pt").disabled, true);
}

/* ---------------------------------------------------------------- preamble */

{
  const store = mount();
  store.set({ preamble: "#let a = 1" });
  check("a document with a preamble shows the dot",
    at("preamble-dot").classList.contains("hidden"), false);
  store.set({ preamble: "   " });
  check("whitespace does not count", at("preamble-dot").classList.contains("hidden"), true);

  store.set({ tab: "preamble", preamble: "x", preambleFromDefault: true });
  check("a seeded preamble explains itself",
    at("preamble-hint").textContent.startsWith("From your default"), true);
  store.set({ preambleFromDefault: false });
  check("and stops once it is this document's", at("preamble-hint").textContent, "");
}

console.log = realLog;
check("an error status is mirrored to the console",
  logged.some((line) => line.includes("[typst] Could not render.")), true);

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
