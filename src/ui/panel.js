/**
 * Panel composition root: build the store, the actions and the view, and start.
 *
 * The three fit together one way only. `actions` never touches a control — it
 * changes state and talks to InDesign or the compiler. `panel-view` never talks
 * to either — it draws the state and calls an action when the user asks for
 * something. Neither requires the other; this file is what joins them, which is
 * why the dependency stays one-way and why each can be read on its own.
 *
 * The <webview> in the middle of the panel is doing double duty — it hosts the
 * wasm compiler *and* is the preview surface, so a "render" both returns metrics
 * to the panel and paints there.
 */
const backend = require("../backends/index").get("typst");
const { createStore } = require("./store");
const status = require("./status");
const theme = require("./theme");
const actionsModule = require("./actions");
const viewModule = require("./panel-view");
const dialogs = require("./settings-dialog");

const store = createStore({
  engine: "",
  wasmSource: "",
  /**
   * Which editor is on stage. Each tab has one of its own, holding its own text;
   * hiding the inactive one is what is not allowed, since a UXP text control
   * that spends time inside a `display: none` subtree never becomes editable.
   */
  tab: "equation",
  body: "",
  mode: "inline",
  sizeMode: "auto",
  sizePt: 10,
  colorMode: "auto",
  /** A Typst colour expression, used when colorMode is "fixed". */
  colorText: "black",
  preamble: "",
  preambleDoc: null,
  /**
   * True while the preamble on screen came from the user's default rather than
   * from this document. It is not written to the document until it is edited or
   * an equation is inserted, so that merely opening a document never dirties it.
   */
  preambleFromDefault: false,
  /** {frame, record} when a labelled equation is selected. */
  editing: null,
  /** Metrics from the most recent successful preview. */
  lastMetrics: null,
  busy: false,
  /** What the status line says. The rules live in src/ui/status.js. */
  status: status.EMPTY,
});

// Before the view, so its state mirror is in place when the first render runs.
const actions = actionsModule.create(store);

let view = null;

/**
 * Dispatch for the panel flyout menu and the command entrypoints, which share
 * these actions. Deliberately static: InDesign does not reliably support
 * mutating flyout items after registration.
 */
function invokeMenu(id) {
  if (id === "settings") return dialogs.showSettings();
  if (id === "rerender") return actions.rerenderAllNow({ toDialog: true });
  if (id === "about") return dialogs.showMessage(actions.aboutText(), "About Typst Math");
  return undefined;
}

async function start() {
  // Before anything is drawn: this picks every colour in the panel, and the
  // wrong one against the host's chrome is merely hard to read rather than
  // obviously broken. See src/ui/theme.js for why the host cannot be asked
  // directly.
  const resolved = theme.resolve();
  theme.apply(resolved);

  view = viewModule.create(store, {
    preview: () => actions.requestPreview(),
    commit: () => actions.commit(),
    revert: () => actions.revert(),
    savePreamble: () => actions.savePreamble(),
    saveDefaultPreamble: () => actions.saveDefaultPreamble(),
    resetDefaultPreamble: () => actions.resetDefaultPreamble(),
  });
  actions.applyDefaults();
  view.paint();

  dialogs.configure({
    engine: () => actions.engineLabel(),
    reloadFonts: () => actions.reloadFonts(true),
    // A default only reaches the toolbar when nothing is being edited; changing
    // it must not silently rewrite the equation the user has selected.
    onDefaults: (stored) => { if (!store.get().editing) actions.applyDefaults(stored); },
    onError: (message) => actions.setStatus(message, "error"),
  });
  actions.setStatus("Starting Typst compiler…", "busy");

  backend.attach(view.preview);
  try {
    const { engine, wasmSource } = await backend.ready();
    store.set({ engine, wasmSource: wasmSource || "" });
    // The same answer the panel styled itself with — the preview rendering
    // light against a dark panel was the visible half of this being wrong. And
    // from here on the two stay together: the host's theme can change while the
    // panel is open, and there is no event for it, so it is polled.
    backend.setTheme(resolved);
    theme.watch((next) => backend.setTheme(next));
    // Which wasm-loading strategy won is worth seeing — it varies with how UXP
    // resolves plugin: URLs, and it is the first thing to check if startup
    // breaks after a UXP update — but it is jargon in a status line, and the
    // panel has nothing else to announce: the preview says "Type an
    // expression…" for itself. Settings and About carry the engine string.
    console.log(`[typst] ${engine}${wasmSource ? ` · wasm via ${wasmSource}` : ""}`);
    actions.setStatus("");
  } catch (err) {
    actions.setStatus(`Compiler failed to start: ${(err && err.message) || err}`, "error");
    return;
  }

  actions.loadDocumentPreamble();
  // A font that has gone missing must not stop the panel from starting; the
  // status line already says what happened.
  try { await actions.reloadFonts(false); } catch { /* reported by reloadFonts */ }
  actions.watchSelection();
  actions.onSelectionChanged();
}

module.exports = { start, invokeMenu };
