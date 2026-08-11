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
const { tryGet, activeDocument, asOneUndo } = require("../id/doc");
const label = require("../id/label");
const context = require("../id/context");
const {
  insert, update, lastPlacementWarnings, lastFrameChrome, lastOffset,
} = require("../id/insert");
const { rerenderAll } = require("../id/rerender");
const fonts = require("./fonts");

const PREVIEW_DEBOUNCE_MS = 250;
const SELECTION_POLL_MS = 700;

const state = {
  engine: "",
  mode: "inline",
  sizeMode: "auto",
  sizePt: 10,
  colorMode: "auto",
  preamble: "",
  preambleDoc: null,
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

function setStatus(text, kind) {
  el.status.textContent = text || "";
  el.status.className = `status${kind ? " " + kind : ""}`;
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
    body: el.editor.value,
    mode: state.mode,
    size,
    color,
    preamble: state.preamble,
  };
}

/* ----------------------------------------------------------------- preview */

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
      setStatus(state.contextNotes.join(" "));
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

  setBusy(true, state.editing ? "Updating…" : "Inserting…");
  try {
    const result = await backend.render(spec, { pdf: true });
    if (!result.ok || !result.asset) {
      setStatus(describeDiagnostics(result.diagnostics) || "Could not render.", "error");
      return;
    }
    state.lastMetrics = result.metrics;
    const record = buildRecord(spec, result.metrics);

    if (state.editing && tryGet(() => state.editing.frame.isValid, false)) {
      await update({
        doc, frame: state.editing.frame,
        asset: result.asset, metrics: result.metrics, record,
      });
      state.editing.record = record;
      setStatus(withWarnings("Updated."));
    } else {
      const target = context.currentTarget();
      const { frame, anchored } = await insert({
        doc, asset: result.asset, metrics: result.metrics, record, target,
      });
      state.editing = { frame, record, id: tryGet(() => frame.id, null) };
      lastSignature = selectionSignature();
      setStatus(withWarnings(anchored
        ? `Inserted inline (depth ${result.metrics.depth.toFixed(2)} pt, ` +
          `Y offset ${lastOffset()} pt).`
        : "Inserted on the page."));
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
  el.rerenderAll.disabled = busy;
  el.addFonts.disabled = busy;
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
  el.editor.value = record.body || "";
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

function loadDocumentPreamble() {
  const doc = tryGet(() => app.activeDocument, null);
  if (!doc || !tryGet(() => doc.isValid, false)) {
    state.preambleDoc = null;
    return;
  }
  const id = tryGet(() => doc.id, null);
  if (id === state.preambleDoc) return;
  state.preambleDoc = id;
  state.preamble = label.readDocumentPreamble(doc);
  el.preamble.value = state.preamble;
}

const savePreamble = debounce(() => {
  const doc = tryGet(() => app.activeDocument, null);
  if (!doc || !tryGet(() => doc.isValid, false)) return;
  try {
    asOneUndo("Set Typst preamble", () => label.writeDocumentPreamble(doc, state.preamble));
  } catch (err) {
    setStatus(String((err && err.message) || err), "error");
  }
}, 600);

/* ------------------------------------------------------------------- fonts */

function renderFontList(names) {
  el.fontList.textContent = "";
  if (!names.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Typst defaults only";
    el.fontList.appendChild(li);
    return;
  }
  for (const name of names) {
    const li = document.createElement("li");
    li.textContent = name;
    el.fontList.appendChild(li);
  }
}

async function reloadFonts(announce) {
  const { fonts: data, names, dropped } = await fonts.load();
  renderFontList(names);
  if (data.length || announce) {
    setBusy(true, "Loading fonts…");
    try {
      await backend.setFonts(data);
      const missing = dropped.length ? ` (${dropped.length} missing)` : "";
      setStatus(data.length ? `${data.length} font file(s) loaded${missing}.` : "Typst defaults only.");
    } catch (err) {
      setStatus(String((err && err.message) || err), "error");
    } finally {
      setBusy(false);
    }
  }
  requestPreview();
}

/* -------------------------------------------------------------------- boot */

function bindElements() {
  for (const [key, id] of Object.entries({
    editor: "editor", preview: "preview", status: "status", insert: "insert",
    revert: "revert", mode: "mode", sizeMode: "size-mode", sizePt: "size-pt",
    colorMode: "color-mode", settings: "settings", settingsToggle: "settings-toggle",
    preamble: "preamble", fontList: "font-list", addFonts: "add-fonts",
    clearFonts: "clear-fonts", rerenderAll: "rerender-all",
  })) {
    el[key] = document.getElementById(id);
  }
}

function wireEvents() {
  el.editor.addEventListener("input", requestPreview);
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

  el.settingsToggle.addEventListener("click", () => {
    el.settings.classList.toggle("hidden");
  });
  el.preamble.addEventListener("input", () => {
    state.preamble = el.preamble.value;
    savePreamble();
    requestPreview();
  });

  el.addFonts.addEventListener("click", async () => {
    try {
      const added = await fonts.pick();
      if (added) await reloadFonts(true);
    } catch (err) {
      setStatus(String((err && err.message) || err), "error");
    }
  });
  el.clearFonts.addEventListener("click", async () => {
    fonts.clear();
    await reloadFonts(true);
  });

  el.rerenderAll.addEventListener("click", async () => {
    let doc;
    try {
      doc = activeDocument();
    } catch (err) {
      setStatus(err.message, "error");
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
      setStatus(summary.total
        ? `Re-rendered ${summary.updated} of ${summary.total}${failed}${alignment}${blind}`
        : "No Typst equations in this document.",
        summary.failures.length ? "error" : "");
    } catch (err) {
      setStatus(String((err && err.message) || err), "error");
    } finally {
      setBusy(false);
    }
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

function currentTheme() {
  const theme = tryGet(() => require("uxp").host.theme, "light");
  return /dark|darkest|medium/.test(String(theme)) ? "dark" : "light";
}

async function start() {
  bindElements();
  renderFontList(fonts.names());
  wireEvents();
  syncEditingUI();
  setStatus("Starting Typst compiler…", "busy");

  backend.attach(el.preview);
  try {
    const { engine, wasmSource } = await backend.ready();
    state.engine = engine;
    backend.setTheme(currentTheme());
    // Which wasm-loading strategy won is worth seeing: it varies with how UXP
    // resolves plugin: URLs, and it is the first thing to check if startup
    // breaks after a UXP update.
    setStatus(wasmSource ? `${engine} · wasm via ${wasmSource}` : engine);
  } catch (err) {
    setStatus(`Compiler failed to start: ${(err && err.message) || err}`, "error");
    return;
  }

  loadDocumentPreamble();
  await reloadFonts(false);
  watchSelection();
  onSelectionChanged();
}

module.exports = { start };
