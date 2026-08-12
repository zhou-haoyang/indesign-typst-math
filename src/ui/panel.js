/**
 * Panel controller: editor, live preview, insert/update, settings.
 *
 * The <webview> in the middle of the panel is doing double duty — it hosts the
 * wasm compiler *and* is the preview surface, so a "render" both returns
 * metrics here and paints there.
 */
const { app } = require("indesign");

// Explicit file path: UXP's require does not resolve a directory to its
// index.js, only Node does.
const backend = require("../backends/index").get("typst");
const { tryGet, isUsable, activeDocument, asOneUndo } = require("../id/doc");
const label = require("../id/label");
const context = require("../id/context");
const {
  insert, update, lastPlacementWarnings, lastFrameChrome, lastOffset,
} = require("../id/insert");
const { rerenderAll } = require("../id/rerender");
const fonts = require("./fonts");
const prefs = require("./prefs");
const dialogs = require("./settings-dialog");

const PREVIEW_DEBOUNCE_MS = 250;
const SELECTION_POLL_MS = 700;
/** How long a menu command waits for a compiler that is still starting. */
const COMPILER_GRACE_MS = 3000;

const state = {
  engine: "",
  wasmSource: "",
  /**
   * Which buffer `el.editor` is currently showing. One textarea serves both
   * tabs: two of them, with the inactive one hidden, left the preamble
   * permanently unfocusable.
   */
  tab: "equation",
  body: "",
  mode: "inline",
  sizeMode: "auto",
  sizePt: 10,
  colorMode: "auto",
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
  contextNotes: [],
  busy: false,
};

const el = {};

/* ------------------------------------------------------------------- utils */

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** How long a placement result resists being overwritten by routine updates. */
const STICKY_MS = 15000;
let stickyUntil = 0;

/**
 * @param {{sticky?: boolean}} options  Placement results are sticky: inserting
 *   selects the new frame, which triggers a preview, whose success path would
 *   otherwise wipe the message a quarter of a second after it appears.
 */
function setStatus(text, kind, options = {}) {
  const now = Date.now();
  const important = options.sticky || kind === "error";
  // "Inserting…" and friends replace a sticky message but do not become one.
  if (!important && kind !== "busy" && now < stickyUntil) return;
  stickyUntil = important ? now + STICKY_MS : 0;
  el.status.textContent = text || "";
  el.status.className = `status${kind ? " " + kind : ""}`;
  // Mirrored to the console so it can be read and copied even after the panel
  // moves on, and so it survives a status the panel is too narrow to show.
  if (text && important) console.log(`[typst] ${text}`);
}

/* ------------------------------------------------------------------ editor */

/**
 * Everything that touches the editor widget goes through these three, so that
 * swapping it costs them plus the one tag in index.html. It has been a
 * `<textarea>` and an `sp-textarea` and is currently the former; see panel.css
 * for what the caret turns on.
 *
 * `placeholder` is set as an attribute rather than a property, because a custom
 * element's property does not necessarily reflect back to one.
 */
function editorText() {
  return el.editor.value || "";
}

function setEditorText(text) {
  const value = text || "";
  el.editor.value = value;
  // The same rule this codebase applies to the InDesign DOM: an assignment can
  // be refused without throwing, so read it back. sp-textarea also takes its
  // value as content, and a silently ignored write here would look like
  // selecting an equation failing to load its source.
  if (editorText() !== value) el.editor.textContent = value;
}

function setEditorPlaceholder(text) {
  el.editor.setAttribute("placeholder", text);
}

function describeDiagnostics(diagnostics) {
  return (diagnostics || [])
    .filter((d) => d.severity !== "info")
    .map((d) => {
      const where = d.where === "preamble" ? "preamble " : "";
      const at = d.line != null ? `${where}${d.line}:${d.column || 1}: ` : (where ? where + ": " : "");
      return `${at}${d.message}`;
    })
    .join("\n");
}

/* -------------------------------------------------------------------- spec */

/**
 * The size and colour to render at, given the current selection and settings.
 * `auto` means: read it off the text the equation sits in.
 */
function resolveTypography() {
  const notes = [];
  let size = state.sizePt;
  let color = context.BLACK;

  const wantsAuto = state.sizeMode === "auto" || state.colorMode === "auto";
  if (wantsAuto) {
    let at = null;
    if (state.editing) {
      const offset = context.anchorInsertionPoint(state.editing.frame);
      if (offset) at = context.readAt(offset);
    } else {
      const target = context.currentTarget();
      if (target.kind === "text") at = context.readAt(target.insertionPoint);
    }
    if (at) {
      if (state.sizeMode === "auto" && at.size) size = at.size;
      if (state.colorMode === "auto") color = at.color;
      notes.push(...at.notes);
    } else if (state.sizeMode === "auto" && !state.editing) {
      // Nothing to match against; fall back rather than guess.
      notes.push(`No text cursor; using ${size} pt.`);
    }
  }
  state.contextNotes = notes;
  return { size, color };
}

function currentSpec() {
  const { size, color } = resolveTypography();
  return {
    body: state.body,
    mode: state.mode,
    size,
    color,
    preamble: state.preamble,
  };
}

/* ----------------------------------------------------------------- preview */

/**
 * A note when the selected equation was built against a different preamble.
 *
 * This is what `record.preambleHash` is for: the artwork is a snapshot, so
 * after a preamble edit the placed equation and the preview legitimately
 * disagree until a re-render. Without saying so, that looks like a bug.
 */
function staleNote() {
  if (!state.editing) return "";
  const stored = state.editing.record.preambleHash;
  if (!stored || stored === label.hash(state.preamble)) return "";
  return "Built with a different preamble — re-render to sync.";
}

const requestPreview = debounce(async () => {
  const spec = currentSpec();
  if (!spec.body.trim()) {
    state.lastMetrics = null;
    el.insert.disabled = true;
    setStatus("");
    await backend.render(spec, {});
    return;
  }
  try {
    const result = await backend.render(spec, {});
    state.lastMetrics = result.ok ? result.metrics : null;
    el.insert.disabled = !result.ok || state.busy;
    if (result.ok) {
      // The webview's own status line already shows the box size and depth.
      setStatus([...state.contextNotes, staleNote()].filter(Boolean).join(" "));
    } else {
      setStatus(describeDiagnostics(result.diagnostics) || "Could not render.", "error");
    }
  } catch (err) {
    state.lastMetrics = null;
    el.insert.disabled = true;
    setStatus(String((err && err.message) || err), "error");
  }
}, PREVIEW_DEBOUNCE_MS);

/* ------------------------------------------------------------ insert/update */

/**
 * Append anything the placement could not apply. Frame formatting can be
 * refused without throwing, and silently leaving a stroke around every
 * equation is the kind of thing that should announce itself.
 */
function withWarnings(message) {
  const warnings = lastPlacementWarnings();
  if (!warnings.length) return message;
  // Only when something actually refused: the read-back names which object is
  // still carrying formatting, which is otherwise indistinguishable from the
  // outside — the frame, the graphic inside it and the applied style can each
  // draw a box.
  return [message, `Could not clear: ${warnings.join("; ")}`, lastFrameChrome()]
    .filter(Boolean).join("\n");
}

function buildRecord(spec, metrics) {
  return label.makeRecord({
    body: spec.body,
    mode: spec.mode,
    size: { mode: state.sizeMode, pt: spec.size },
    color: { mode: state.colorMode, space: spec.color.space, values: spec.color.values },
    preamble: state.preamble,
    metrics,
    engine: state.engine,
  });
}

async function commit() {
  if (state.busy) return;
  // The selection watcher is polled, so it can lag a click into the text by up
  // to its interval. Re-read now: otherwise clicking into a paragraph and
  // immediately pressing Cmd+Enter would overwrite the equation that happened
  // to be selected a moment ago instead of inserting a new one.
  onSelectionChanged();

  const spec = currentSpec();
  if (!spec.body.trim()) return;

  let doc;
  try {
    doc = activeDocument();
  } catch (err) {
    setStatus(err.message, "error");
    return;
  }

  // A preamble that is still only the user's default becomes this document's
  // now, so that the document that holds the equation also holds what built it.
  // Its own undo step, deliberately: undoing the insert should not silently
  // strip a document-wide setting.
  if (state.preambleFromDefault) persistPreamble();

  setBusy(true, state.editing ? "Updating…" : "Inserting…");
  try {
    const result = await backend.render(spec, { pdf: true });
    if (!result.ok || !result.asset) {
      setStatus(describeDiagnostics(result.diagnostics) || "Could not render.", "error");
      return;
    }
    state.lastMetrics = result.metrics;
    const record = buildRecord(spec, result.metrics);

    if (state.editing && isUsable(state.editing.frame)) {
      await update({
        doc, frame: state.editing.frame,
        asset: result.asset, metrics: result.metrics, record,
      });
      state.editing.record = record;
      setStatus(withWarnings("Updated."), "", { sticky: true });
    } else {
      const target = context.currentTarget();
      const { frame, anchored } = await insert({
        doc, asset: result.asset, metrics: result.metrics, record, target,
      });
      state.editing = { frame, record, id: tryGet(() => frame.id, null) };
      lastSignature = selectionSignature();
      setStatus(withWarnings(anchored
        ? `Inserted inline\ndepth ${result.metrics.depth.toFixed(2)} pt` +
          `\nY offset ${lastOffset()}`
        : `Inserted on the page — not anchored\nbecause: ${target.why || "unknown"}`),
        "", { sticky: true });
      syncEditingUI();
    }
  } catch (err) {
    setStatus(String((err && err.message) || err), "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(busy, message) {
  state.busy = busy;
  el.insert.disabled = busy || !state.lastMetrics;
  if (busy && message) setStatus(message, "busy");
}

/* --------------------------------------------------------------- selection */

/** A cheap value that changes whenever the selection does. */
function selectionSignature() {
  const selection = tryGet(() => app.selection, []) || [];
  if (!selection.length) return "none";
  const first = selection[0];
  return `${selection.length}:${tryGet(() => first.id, "")}:${tryGet(() => first.index, "")}`;
}

let lastSignature = null;

function onSelectionChanged() {
  const signature = selectionSignature();
  if (signature === lastSignature) return;
  lastSignature = signature;

  const selection = tryGet(() => app.selection, []) || [];
  let found = null;
  for (const item of selection) {
    const record = label.readRecord(item);
    if (record) { found = { frame: item, record }; break; }

    // Selecting the anchor character in the text is a natural way to reach for
    // an inline equation, so look inside a *text* selection too. Deliberately
    // not done for page items: selecting a whole text frame should not pick up
    // whichever equation happens to live in it.
    if (tryGet(() => item.geometricBounds, null) != null) continue;
    const nested = tryGet(() => item.pageItems, null);
    const count = nested ? tryGet(() => nested.length, 0) : 0;
    for (let i = 0; i < count; i++) {
      const inner = nested.item(i);
      const innerRecord = label.readRecord(inner);
      if (innerRecord) { found = { frame: inner, record: innerRecord }; break; }
    }
    if (found) break;
  }

  if (found) {
    // Compare by document id, not object identity: two reads of the same page
    // item hand back different JS proxies.
    const id = tryGet(() => found.frame.id, null);
    if (state.editing && id != null && state.editing.id === id) return;
    loadRecord(found);
  } else if (state.editing) {
    state.editing = null;
    syncEditingUI();
    requestPreview();
  } else {
    // Typography may still have changed (different paragraph, different size).
    requestPreview();
  }
}

function loadRecord({ frame, record }) {
  state.editing = { frame, record, id: tryGet(() => frame.id, null) };
  state.body = record.body || "";
  // Selecting an equation is a request to see its source, so come back from the
  // preamble tab if that is where we were.
  switchTab("equation");
  setEditorText(state.body);
  state.mode = record.mode === "display" ? "display" : "inline";
  el.mode.value = state.mode;
  if (record.size) {
    state.sizeMode = record.size.mode === "fixed" ? "fixed" : "auto";
    state.sizePt = record.size.pt || 10;
  }
  if (record.color) state.colorMode = record.color.mode === "auto" ? "auto" : "black";
  el.sizeMode.value = state.sizeMode;
  el.sizePt.value = state.sizePt;
  el.sizePt.disabled = state.sizeMode !== "fixed";
  el.colorMode.value = state.colorMode;
  syncEditingUI();
  requestPreview();
}

function syncEditingUI() {
  const editing = !!state.editing;
  el.insert.textContent = editing ? "Update" : "Insert";
  el.revert.classList.toggle("hidden", !editing);
}

/* ---------------------------------------------------------------- preamble */

/**
 * Read the active document's preamble, seeding from the user's default when the
 * document has never had one.
 *
 * The seed is in memory only. Writing it here would dirty every document merely
 * by opening it, and `readDocumentPreamble` reports `present` precisely so that
 * a preamble someone deliberately emptied is not re-seeded on every reload.
 */
function loadDocumentPreamble() {
  const doc = tryGet(() => app.activeDocument, null);
  if (!isUsable(doc)) {
    state.preambleDoc = null;
    return;
  }
  const id = tryGet(() => doc.id, null);
  if (id === state.preambleDoc) return;
  state.preambleDoc = id;

  const stored = label.readDocumentPreamble(doc);
  const fallback = prefs.read().defaultPreamble;
  const before = state.preamble;
  state.preambleFromDefault = !stored.present && !!fallback;
  state.preamble = stored.present ? stored.text : (fallback || "");
  showInEditor("preamble", state.preamble);
  syncPreambleUI();
  // Switching documents can change what the same expression compiles to, and
  // the selection watcher will not notice if the selection looks the same in
  // both documents.
  if (state.preamble !== before) requestPreview();
}

function syncPreambleUI() {
  el.preambleDot.classList.toggle("hidden", !state.preamble.trim());
  el.preambleHint.textContent = state.tab === "preamble" && state.preambleFromDefault
    ? "From your default — saved into this document when you insert an equation."
    : "";
}

function persistPreamble() {
  const doc = tryGet(() => app.activeDocument, null);
  if (!isUsable(doc)) return;
  try {
    asOneUndo("Set Typst preamble", () => label.writeDocumentPreamble(doc, state.preamble));
    state.preambleFromDefault = false;
    syncPreambleUI();
  } catch (err) {
    setStatus(String((err && err.message) || err), "error");
  }
}

const savePreamble = debounce(persistPreamble, 600);

/* ------------------------------------------------------------------- fonts */

async function reloadFonts(announce) {
  const { fonts: data, names, dropped } = await fonts.load();
  if (data.length || announce) {
    setBusy(true, "Loading fonts…");
    try {
      await backend.setFonts(data);
      const missing = dropped.length ? ` (${dropped.length} missing)` : "";
      setStatus(data.length ? `${names.length} font file(s) loaded${missing}.` : "Typst defaults only.");
    } catch (err) {
      setStatus(String((err && err.message) || err), "error");
      throw err;
    } finally {
      setBusy(false);
    }
  }
  requestPreview();
}

/* -------------------------------------------------------------------- tabs */

const PLACEHOLDER = {
  equation: "Typst math, e.g.  sum_(i=1)^n x_i / 2",
  preamble: "#let vb(x) = math.bold(x)\n#set text(font: \"New Computer Modern\")",
};

/**
 * The preamble is a tab rather than a drawer because it wants the live preview
 * below it exactly as much as the equation does — and for the same reason it is
 * not in the settings dialog, which would cover the preview entirely.
 *
 * The two tabs share one textarea, so switching means writing the visible text
 * back to the buffer it belongs to and loading the other.
 */
function switchTab(name) {
  if (state.tab === name) return;
  if (state.tab === "preamble") state.preamble = editorText();
  else state.body = editorText();

  state.tab = name;
  const preamble = name === "preamble";
  setEditorText(preamble ? state.preamble : state.body);
  setEditorPlaceholder(PLACEHOLDER[name]);
  el.preambleActions.classList.toggle("hidden", !preamble);
  el.tabEquation.classList.toggle("active", !preamble);
  el.tabPreamble.classList.toggle("active", preamble);
  syncPreambleUI();
  el.editor.focus();
}

/** Show `text` in the editor when the tab it belongs to is the visible one. */
function showInEditor(tab, text) {
  if (state.tab === tab) setEditorText(text);
}

/* ---------------------------------------------------------------- defaults */

/** Put the user's remembered defaults into the toolbar. */
function applyDefaults(stored) {
  const wanted = (stored || prefs.read()).newEquation;
  state.mode = wanted.mode;
  state.sizeMode = wanted.sizeMode;
  state.sizePt = wanted.sizePt;
  state.colorMode = wanted.colorMode;
  el.mode.value = state.mode;
  el.sizeMode.value = state.sizeMode;
  el.sizePt.value = state.sizePt;
  el.sizePt.disabled = state.sizeMode !== "fixed";
  el.colorMode.value = state.colorMode;
}

/* ------------------------------------------------------------ menu actions */

/**
 * Wait for the compiler if it is still starting, but do not hang on one that
 * will never arrive — a command can be invoked with the panel never opened, and
 * the compiler lives inside the panel's webview.
 */
async function ensureCompiler() {
  if (backend.isReady()) return true;
  const grace = new Promise((resolve) => setTimeout(() => resolve(false), COMPILER_GRACE_MS));
  return Promise.race([backend.ready().then(() => true, () => false), grace]);
}

/**
 * @param {{toDialog?: boolean}} options  Report into a dialog when there may be
 *   no visible panel to report into, i.e. when invoked from a menu command.
 */
async function rerenderAllNow({ toDialog = false } = {}) {
  const report = (text, kind) => (toDialog
    ? dialogs.showMessage(text, "Re-render all")
    : setStatus(text, kind, { sticky: true }));

  if (!await ensureCompiler()) {
    report("The Typst compiler runs inside the panel — open the Typst Math panel first.", "error");
    return;
  }

  let doc;
  try {
    doc = activeDocument();
  } catch (err) {
    report(err.message, "error");
    return;
  }
  setBusy(true, "Re-rendering…");
  try {
    const summary = await rerenderAll({
      doc,
      preamble: state.preamble,
      engine: state.engine,
      render: (spec, want) => backend.render(spec, want),
      onProgress: (i, n) => setStatus(`Re-rendering ${i + 1} of ${n}…`, "busy"),
    });
    const failed = summary.failures.length
      ? `, ${summary.failures.length} failed: ${summary.failures[0].message}`
      : "";
    const alignment = summary.worstResidual !== null && summary.worstResidual !== undefined
      ? `, worst alignment ${summary.worstResidual.toFixed(2)} pt`
      : "";
    const blind = summary.unmeasured ? `, ${summary.unmeasured} unmeasured` : "";
    report(summary.total
      ? `Re-rendered ${summary.updated} of ${summary.total}${failed}${alignment}${blind}`
      : "No Typst equations in this document.",
      summary.failures.length ? "error" : "");
  } catch (err) {
    report(String((err && err.message) || err), "error");
  } finally {
    setBusy(false);
  }
}

function aboutText() {
  return [
    state.engine || "compiler not started",
    state.wasmSource ? `wasm via ${state.wasmSource}` : "",
    `${fonts.names().length} extra font file(s)`,
  ].filter(Boolean).join("\n");
}

/**
 * Dispatch for the panel flyout menu and the command entrypoints, which share
 * these actions. Deliberately static: InDesign does not reliably support
 * mutating flyout items after registration.
 */
function invokeMenu(id) {
  if (id === "settings") return dialogs.showSettings();
  if (id === "rerender") return rerenderAllNow({ toDialog: true });
  if (id === "about") return dialogs.showMessage(aboutText(), "About Typst Math");
  return undefined;
}

/* -------------------------------------------------------------------- boot */

function bindElements() {
  for (const [key, id] of Object.entries({
    editor: "editor", preview: "preview", status: "status", insert: "insert",
    revert: "revert", mode: "mode", sizeMode: "size-mode", sizePt: "size-pt",
    colorMode: "color-mode", settingsToggle: "settings-toggle",
    tabEquation: "tab-equation", tabPreamble: "tab-preamble",
    preambleDot: "preamble-dot", preambleActions: "preamble-actions",
    preambleHint: "preamble-hint",
    preambleSaveDefault: "preamble-save-default",
    preambleResetDefault: "preamble-reset-default",
  })) {
    el[key] = document.getElementById(id);
  }
}

function wireEvents() {
  el.editor.addEventListener("input", () => {
    if (state.tab === "preamble") {
      state.preamble = editorText();
      // Editing it makes it this document's, whatever it started as.
      state.preambleFromDefault = false;
      syncPreambleUI();
      savePreamble();
    } else {
      state.body = editorText();
    }
    requestPreview();
  });
  el.editor.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  });

  el.mode.addEventListener("change", () => {
    state.mode = el.mode.value;
    requestPreview();
  });
  el.sizeMode.addEventListener("change", () => {
    state.sizeMode = el.sizeMode.value;
    el.sizePt.disabled = state.sizeMode !== "fixed";
    requestPreview();
  });
  el.sizePt.addEventListener("input", () => {
    const value = parseFloat(el.sizePt.value);
    if (value > 0) state.sizePt = value;
    requestPreview();
  });
  el.colorMode.addEventListener("change", () => {
    state.colorMode = el.colorMode.value;
    requestPreview();
  });

  el.insert.addEventListener("click", commit);
  el.revert.addEventListener("click", () => {
    if (!state.editing) return;
    loadRecord(state.editing);
    setStatus("Reverted to the stored expression.");
  });

  el.settingsToggle.addEventListener("click", () => dialogs.showSettings());

  el.tabEquation.addEventListener("click", () => switchTab("equation"));
  el.tabPreamble.addEventListener("click", () => switchTab("preamble"));

  el.preambleSaveDefault.addEventListener("click", () => {
    prefs.write({ defaultPreamble: state.preamble });
    setStatus("Saved as your default preamble for new documents.");
  });
  el.preambleResetDefault.addEventListener("click", () => {
    state.preamble = prefs.read().defaultPreamble;
    showInEditor("preamble", state.preamble);
    state.preambleFromDefault = false;
    syncPreambleUI();
    savePreamble();
    requestPreview();
  });
}

function watchSelection() {
  let usingEvents = false;
  try {
    app.addEventListener("afterSelectionChanged", onSelectionChanged);
    usingEvents = true;
  } catch { /* fall back to polling */ }
  // Poll regardless: it is cheap, and it also catches document switches and
  // formatting changes around the cursor, which the event does not fire for.
  setInterval(() => {
    loadDocumentPreamble();
    if (!usingEvents) onSelectionChanged();
  }, SELECTION_POLL_MS);
  if (usingEvents) setInterval(onSelectionChanged, SELECTION_POLL_MS * 3);
}

function hostTheme() {
  return String(tryGet(() => require("uxp").host.theme, ""));
}

/**
 * Work the theme out from what the host actually painted, for when it will not
 * say. The panel chrome is a grey either way, so a luma midpoint decides it.
 * Returns null when the body is transparent, which tells us nothing.
 */
function themeFromPaint() {
  const bg = String(tryGet(() => getComputedStyle(document.body).backgroundColor, ""));
  const parts = /rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)(?:\D+([\d.]+))?/.exec(bg);
  if (!parts) return null;
  if (parts[4] !== undefined && Number(parts[4]) === 0) return null;
  const luma = 0.299 * Number(parts[1]) + 0.587 * Number(parts[2]) + 0.114 * Number(parts[3]);
  return luma < 128 ? "dark" : "light";
}

/**
 * InDesign reports one of lightest/light/medium/dark/darkest — but the match
 * here was case-sensitive and defaulted to "light" when the read threw, so a
 * dark panel was quietly served the light palette: light greys on light greys,
 * a white preview, and a white editor whatever the theme.
 */
function currentTheme() {
  const raw = hostTheme();
  if (/dark|medium/i.test(raw)) return "dark";
  if (/light/i.test(raw)) return "light";
  return themeFromPaint() || "light";
}

async function start() {
  bindElements();
  // Before anything is drawn: this picks the muted greys, and the panel is
  // unreadable against the wrong chrome.
  const theme = currentTheme();
  document.body.classList.add(`theme-${theme}`);
  // Both readouts exist because both have been wrong while looking fine. The
  // font stack because this host drops entries it cannot resolve, and the theme
  // because getting it wrong is nearly silent — it shows up as a panel that is
  // merely hard to read rather than as an error.
  console.log(`[typst] theme: "${hostTheme()}" → ${theme}` +
    ` · painted ${tryGet(() => getComputedStyle(document.body).backgroundColor, "?")}` +
    `\n[typst] editor: font ${tryGet(() => getComputedStyle(el.editor).fontFamily, "?")}` +
    ` · background ${tryGet(() => getComputedStyle(el.editor).backgroundColor, "?")}`);
  wireEvents();
  applyDefaults();
  syncEditingUI();
  dialogs.configure({
    engine: () => (state.wasmSource ? `${state.engine} · wasm via ${state.wasmSource}` : state.engine),
    reloadFonts: () => reloadFonts(true),
    // A default only reaches the toolbar when nothing is being edited; changing
    // it must not silently rewrite the equation the user has selected.
    onDefaults: (stored) => { if (!state.editing) applyDefaults(stored); },
    onError: (message) => setStatus(message, "error"),
  });
  setStatus("Starting Typst compiler…", "busy");

  backend.attach(el.preview);
  try {
    const { engine, wasmSource } = await backend.ready();
    state.engine = engine;
    state.wasmSource = wasmSource || "";
    // The same answer the panel styled itself with — the preview rendering
    // light against a dark panel was the visible half of this being wrong.
    backend.setTheme(theme);
    // Which wasm-loading strategy won is worth seeing: it varies with how UXP
    // resolves plugin: URLs, and it is the first thing to check if startup
    // breaks after a UXP update.
    setStatus(wasmSource ? `${engine} · wasm via ${wasmSource}` : engine);
  } catch (err) {
    setStatus(`Compiler failed to start: ${(err && err.message) || err}`, "error");
    return;
  }

  loadDocumentPreamble();
  // A font that has gone missing must not stop the panel from starting; the
  // status line already says what happened.
  try { await reloadFonts(false); } catch { /* reported by reloadFonts */ }
  watchSelection();
  onSelectionChanged();
}

module.exports = { start, invokeMenu };
