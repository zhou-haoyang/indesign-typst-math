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
for (const id of ["editor", "preamble-editor", "size-pt", "mode", "size-mode",
  "color-mode", "color-text"]) {
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
  sizePt: 10, colorMode: "auto", colorText: "black",
  matchedSizePt: null, matchedColorText: "", editing: null,
  lastMetrics: null, busy: false, preambleFromDefault: false,
  status: statusModule.EMPTY,
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
  for (const name of ["preview", "commit", "revert", "savePreamble",
    "saveDefaultPreamble", "resetDefaultPreamble"]) {
    handlers[name] = () => calls.push(name);
  }
  const mounted = view.create(store, handlers);
  mounted.paint();
  return store;
}

/* ------------------------------------------------------------- first paint */

{
  mount({ body: "x^2", preamble: "#let a = 1" });
  check("paints the equation editor from state", at("editor").value, "x^2");
  check("paints the preamble editor too", at("preamble-editor").value, "#let a = 1");
  check("the preamble editor starts off-stage",
    at("preamble-editor").classList.contains("offstage"), true);
  check("and the equation editor on it", at("editor").classList.contains("offstage"), false);
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
  // The colour box is on the same 700 ms poll, and a half-typed expression is
  // worth more than a half-typed number: rewriting `rgb("#c` back over the
  // user's caret would make the field impossible to type into at all.
  const store = mount({ colorMode: "fixed", colorText: "black" });
  at("color-text").focus();
  at("color-text").value = 'rgb("#c';
  const before = at("color-text").writes;
  store.set({ colorText: "black" });
  check("a focused colour box is not rewritten underneath the user",
    [at("color-text").value, at("color-text").writes], ['rgb("#c', before]);

  globalThis.document.activeElement = null;
  store.set({ colorText: "red" });
  check("an idle one does take the new expression", at("color-text").value, "red");
}

{
  const store = mount({ mode: "inline" });
  const before = at("mode").writes;
  store.set({ sizePt: 12 });   // a change in the same render branch
  check("a control already showing the value is not rewritten", at("mode").writes, before);
}

/* ------------------------------------------------------------- match text */

{
  // On "Match text" both boxes are readouts: they show what the last render
  // resolved off the document, not the fixed value sitting underneath them,
  // which is not what an insert would use.
  const store = mount({ sizePt: 10, colorText: 'rgb("#cc0000")' });
  store.set({ matchedSizePt: 24, matchedColorText: "cmyk(0%, 0%, 0%, 100%)" });
  check("the size box shows the size that was matched", at("size-pt").value, "24");
  check("the colour box shows the colour that was matched",
    at("color-text").value, "cmyk(0%, 0%, 0%, 100%)");
  check("and both stay read-only",
    [at("size-pt").disabled, at("color-text").disabled], [true, true]);
  check("while the fixed values are left where they were",
    [store.get().sizePt, store.get().colorText], [10, 'rgb("#cc0000")']);
}

{
  // Fixed shows what the user typed, whatever the document happens to say.
  const store = mount({ sizeMode: "fixed", colorMode: "fixed", sizePt: 11, colorText: "red" });
  store.set({ matchedSizePt: 24, matchedColorText: "cmyk(0%, 0%, 0%, 100%)" });
  check("a fixed size box keeps the user's number", at("size-pt").value, "11");
  check("a fixed colour box keeps the user's expression", at("color-text").value, "red");
}

{
  // Switching to Fixed holds the value on screen rather than reviving the one
  // underneath it — otherwise the number jumps at the moment the user says
  // "keep this one".
  const store = mount({ sizePt: 10, colorText: "black" });
  store.set({ matchedSizePt: 24, matchedColorText: 'rgb("#ff0000")' });

  at("size-mode").value = "fixed";
  at("size-mode").fire("change");
  check("switching size to Fixed adopts what was matched", store.get().sizePt, 24);
  check("so the box does not jump", at("size-pt").value, "24");

  at("color-mode").value = "fixed";
  at("color-mode").fire("change");
  check("switching colour to Fixed hands over the matched expression",
    store.get().colorText, 'rgb("#ff0000")');
  check("now editable", at("color-text").disabled, false);
}

{
  // Nothing matched yet — the panel has just opened — is not a reason to blank
  // the boxes: the render falls back to these same two values.
  mount({ sizePt: 12, colorText: "red" });
  check("with nothing matched the fixed values stand in",
    [at("size-pt").value, at("color-text").value], ["12", "red"]);
}

/* ------------------------------------------------------------------- tabs */

{
  const store = mount({ body: "B", preamble: "P" });
  at("tab-preamble").fire("click");
  check("switching tab brings its editor on stage",
    [at("editor").classList.contains("offstage"),
      at("preamble-editor").classList.contains("offstage")], [true, false]);
  check("the preamble tab is active", at("tab-preamble").classList.contains("active"), true);
  check("the equation tab is not", at("tab-equation").classList.contains("active"), false);
  check("preamble actions appear", at("preamble-actions").classList.contains("hidden"), false);
  check("the store agrees", store.get().tab, "preamble");

  at("tab-equation").fire("click");
  check("and back again",
    [at("editor").classList.contains("offstage"),
      at("preamble-editor").classList.contains("offstage")], [false, true]);
  check("each editor still holds its own text",
    [at("editor").value, at("preamble-editor").value], ["B", "P"]);
  check("and so do the buffers", [store.get().body, store.get().preamble], ["B", "P"]);
}

{
  // The reason there are two editors: a switch must not read one control's text
  // back into the other's buffer, and it must not rewrite either control. One
  // shared sp-textarea could refuse the write and keep the previous tab's source
  // on screen, which the next keystroke then saved into the wrong buffer.
  const store = mount({ body: "B", preamble: "P" });
  const before = [at("editor").writes, at("preamble-editor").writes];
  at("tab-preamble").fire("click");
  at("tab-equation").fire("click");
  check("a tab switch writes neither editor",
    [at("editor").writes, at("preamble-editor").writes], before);
  check("and leaves both buffers alone", [store.get().body, store.get().preamble], ["B", "P"]);
}

{
  const store = mount({ body: "B", preamble: "P" });
  at("editor").focus();
  at("tab-preamble").fire("click");
  check("switching tab moves focus to that tab's editor",
    globalThis.document.activeElement, at("preamble-editor"));
  check("store tab followed", store.get().tab, "preamble");
}

{
  // Same caret hazard as the equation editor, on the other control: the poll
  // re-reads the document's preamble every 700 ms.
  const store = mount({ tab: "preamble", preamble: "P" });
  at("preamble-editor").focus();
  const before = at("preamble-editor").writes;
  store.set({ preamble: "P!" });
  check("a focused preamble editor is not rewritten underneath the user",
    at("preamble-editor").writes, before);

  globalThis.document.activeElement = null;
  store.set({ preamble: "P?" });
  check("an idle one does take the new text", at("preamble-editor").value, "P?");
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
}

{
  const store = mount({ tab: "preamble", preamble: "P" });
  at("preamble-editor").value = "P2";
  at("preamble-editor").fire("input");
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

  check("matching the text disables the colour box", at("color-text").disabled, true);
  at("color-mode").value = "fixed";
  at("color-mode").fire("change");
  check("a fixed colour enables it", at("color-text").disabled, false);
  at("color-text").value = 'rgb("#cc0000")';
  at("color-text").fire("input");
  check("typing a colour updates state", store.get().colorText, 'rgb("#cc0000")');
  check("and asks for a preview", calls.includes("preview"), true);
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
