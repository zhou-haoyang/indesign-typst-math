/**
 * Everything the panel *does*, as opposed to how it looks.
 *
 * Nothing here touches a control. That is not a style rule but the shape the
 * code turned out to have once the state moved into a store: the view reacts to
 * state, so an action's whole job is to change state and talk to InDesign or
 * the compiler. The one thing that looked like a counter-example — the Insert
 * button being enabled — is really "did the last preview produce metrics", and
 * lives in the store as `lastMetrics`.
 *
 * Kept as a factory rather than a module of globals so that its scratch state
 * (the last selection signature, the last spec's notes) belongs to an instance,
 * and so a test can drive it with a stub store.
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
const spec = require("./spec");
const status = require("./status");
const selection = require("./selection");
const dialogs = require("./settings-dialog");

const PREVIEW_DEBOUNCE_MS = 250;
const SELECTION_POLL_MS = 700;
/** How long a menu command waits for a compiler that is still starting. */
const COMPILER_GRACE_MS = 3000;

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function create(store) {
  /**
   * A live mirror of the store, so the reads below stay `state.foo`. Registered
   * before the view subscribes, so `state` always agrees with the snapshot the
   * view is handed.
   */
  let state = store.get();
  store.subscribe((next) => { state = next; });

  /**
   * Why the notes are not in the store: they are scratch between resolving a
   * spec and describing it, they are a fresh array every time — so an Object.is
   * comparison would call every render a change — and nothing reacts to them.
   */
  let contextNotes = [];
  let lastSignature = null;

  /* ------------------------------------------------------------------ status */

  /**
   * @param {{sticky?: boolean}} options  Placement results are sticky: inserting
   *   selects the new frame, which triggers a preview, whose success path would
   *   otherwise wipe the message a quarter of a second after it appears.
   */
  function setStatus(text, kind, options = {}) {
    // status.next hands back the *same object* when the request should be
    // ignored, so the store's no-op guard is what implements "a routine message
    // does not disturb a sticky one" — no separate check is needed here.
    store.set({ status: status.next(state.status, { text, kind, sticky: options.sticky }, Date.now()) });
  }

  function setBusy(busy, message) {
    store.set({ busy });
    if (busy && message) setStatus(message, "busy");
    // Now that finishing is silent, whoever set "Inserting…" has to take it down
    // again or it stands there reading as a hang. Only a busy message is cleared:
    // an error raised in between is the thing we stayed quiet to make room for.
    // That used to be decided by asking the DOM whether its own class attribute
    // contained the substring "busy"; it is now a property of the status itself.
    else if (!busy) store.set({ status: status.clearBusy(state.status) });
  }

  /* -------------------------------------------------------------------- spec */

  /**
   * The typographic context at the insertion point, or null when there is none
   * to read — which is a legitimate answer, not a failure.
   *
   * This is the half of the old `resolveTypography` that needs InDesign. What it
   * *means* is in src/ui/spec.js, which is why that part can be tested.
   */
  function readContext() {
    if (state.editing) {
      const offset = context.anchorInsertionPoint(state.editing.frame);
      return offset ? context.readAt(offset) : null;
    }
    const target = context.currentTarget();
    return target.kind === "text" ? context.readAt(target.insertionPoint) : null;
  }

  function currentSpec() {
    // Only read the document when something on screen actually asks for it.
    const at = spec.wantsContext(state) ? readContext() : null;
    const typography = spec.resolveTypography(state, at, context.BLACK);
    contextNotes = typography.notes;
    return spec.toSpec(state, typography);
  }

  /* ----------------------------------------------------------------- preview */

  const requestPreview = debounce(async () => {
    const request = currentSpec();
    if (!request.body.trim()) {
      store.set({ lastMetrics: null });
      setStatus("");
      await backend.render(request, {});
      return;
    }
    try {
      const result = await backend.render(request, {});
      store.set({ lastMetrics: result.ok ? result.metrics : null });
      if (result.ok) {
        // Nothing routine to say: the webview shows the box size, and the notes
        // are the only things the reader did not ask for.
        setStatus([...contextNotes, spec.staleNote(state.editing, state.preamble, label.hash)]
          .filter(Boolean).join(" "));
      } else {
        // The preview box has already painted these: the render that returned
        // them drew them under the artwork that failed, since paint() runs before
        // send() on the same object. Saying it again here stacked two copies of
        // one compiler error, in two slightly different formats. The status line
        // is cleared rather than left alone, so a note from the last render that
        // worked does not sit there reading as a description of this failure.
        const text = spec.describeDiagnostics(result.diagnostics);
        if (text) console.log(`[typst] ${text}`);
        setStatus("");
      }
    } catch (err) {
      // Not the same thing: here the webview never answered, so it has painted
      // nothing and this is the only place the failure can appear.
      store.set({ lastMetrics: null });
      setStatus(String((err && err.message) || err), "error");
    }
  }, PREVIEW_DEBOUNCE_MS);

  /* ------------------------------------------------------------ insert/update */

  /**
   * Report a placement, which means saying nothing when it worked: the equation
   * appearing in the document is the feedback, and a line of praise for every
   * insert is one more thing to read and dismiss.
   *
   * What is left is what went wrong. Frame formatting can be refused without
   * throwing, and silently leaving a stroke around every equation is the kind of
   * thing that should announce itself — it draws a box, and its weight shifts the
   * equation off the baseline by half of it.
   *
   * @param {string} note Something worth saying even though nothing failed, i.e.
   *   that the equation did not go where it was probably meant to.
   */
  function reportPlacement(note) {
    const warnings = lastPlacementWarnings();
    if (warnings.length) {
      // Which object refused what, and what the frame reads back as, is what
      // fixes this — the frame, the graphic inside it and the applied style can
      // each draw a box — and it is a wall of property names to anyone else.
      console.log(`[typst] could not clear: ${warnings.join("; ")}`);
      console.log(`[typst] frame reads back as: ${lastFrameChrome()}`);
    }
    const text = [note, warnings.length
      ? "Some of the frame's formatting could not be cleared, " +
        "so it may show a box or sit slightly off the baseline."
      : ""].filter(Boolean).join("\n");
    if (text) setStatus(text, warnings.length ? "error" : "", { sticky: true });
  }

  function buildRecord(request, metrics) {
    return label.makeRecord({
      body: request.body,
      mode: request.mode,
      size: { mode: state.sizeMode, pt: request.size },
      // Spread rather than named fields, because the colour is one of two
      // shapes: {space, values} read off the text, or {typst} typed into the
      // box. Naming them here quietly wrote `space: undefined` for the second.
      color: { mode: state.colorMode, ...request.color },
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

    const request = currentSpec();
    if (!request.body.trim()) return;

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
      const result = await backend.render(request, { pdf: true });
      if (!result.ok || !result.asset) {
        setStatus(spec.describeDiagnostics(result.diagnostics) || "Could not render.", "error");
        return;
      }
      store.set({ lastMetrics: result.metrics });
      const record = buildRecord(request, result.metrics);

      if (state.editing && isUsable(state.editing.frame)) {
        await update({
          doc, frame: state.editing.frame,
          asset: result.asset, metrics: result.metrics, record,
        });
        state.editing.record = record;
        reportPlacement("");
      } else {
        const target = context.currentTarget();
        const { frame, anchored } = await insert({
          doc, asset: result.asset, metrics: result.metrics, record, target,
        });
        store.set({ editing: { frame, record, id: tryGet(() => frame.id, null) } });
        lastSignature = selectionSignature();
        // The depth, the offset that was applied and what it was solved against
        // are how an alignment bug is diagnosed and are meaningless to read
        // otherwise, so they go to the console. A display equation has no offset
        // to report: it is anchored above the line, not on the baseline.
        const how = !anchored
          ? `on the page, not anchored: ${target.why || "unknown"}`
          : request.mode === "display"
            ? "above the line"
            : `inline, depth ${result.metrics.depth.toFixed(2)} pt, Y offset ${lastOffset()}`;
        console.log(`[typst] inserted ${how}`);
        // Landing on the page is not a failure, but it is not what someone
        // reaching for an inline equation asked for, so it is the one placement
        // outcome still worth a line.
        reportPlacement(anchored
          ? ""
          : "Inserted on the page. To place one inline, put the text cursor in the text first.");
      }
    } catch (err) {
      setStatus(String((err && err.message) || err), "error");
    } finally {
      setBusy(false);
    }
  }

  /* --------------------------------------------------------------- selection */

  function currentSelection() {
    return tryGet(() => app.selection, []) || [];
  }

  /** A cheap value that changes whenever the selection does. */
  function selectionSignature() {
    return selection.signatureOf(currentSelection());
  }

  function onSelectionChanged() {
    const signature = selectionSignature();
    if (signature === lastSignature) return;
    lastSignature = signature;

    // The rule for what counts as "the selected equation" — and in particular
    // that a selected text *frame* does not offer up whichever equation lives
    // inside it — is in src/ui/selection.js, where it is asserted.
    const found = selection.findEquation(currentSelection(), (item) => label.readRecord(item));

    if (found) {
      if (selection.isSameEquation(state.editing, found.frame)) return;
      loadRecord(found);
    } else if (state.editing) {
      store.set({ editing: null });
      requestPreview();
    } else {
      // Typography may still have changed (different paragraph, different size).
      requestPreview();
    }
  }

  function loadRecord({ frame, record }) {
    // One patch, and the view draws every control it implies. The record part is
    // deliberately partial: one written by an older version may carry no size or
    // colour, and absent has to mean "leave the toolbar alone" rather than
    // "reset it to the default".
    //
    // `tab` is in the same patch because selecting an equation is a request to
    // see its source, so it comes back from the preamble tab.
    store.set({
      editing: { frame, record, id: tryGet(() => frame.id, null) },
      tab: "equation",
      ...spec.stateFromRecord(record),
    });
    requestPreview();
  }

  /** The editor's contents changing back is the confirmation. */
  function revert() {
    if (state.editing) loadRecord(state.editing);
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
      store.set({ preambleDoc: null });
      return;
    }
    const id = tryGet(() => doc.id, null);
    if (id === state.preambleDoc) return;
    store.set({ preambleDoc: id });

    const stored = label.readDocumentPreamble(doc);
    const fallback = prefs.read().defaultPreamble;
    const before = state.preamble;
    store.set({
      preambleFromDefault: !stored.present && !!fallback,
      preamble: stored.present ? stored.text : (fallback || ""),
    });
    // Switching documents can change what the same expression compiles to, and
    // the selection watcher will not notice if the selection looks the same in
    // both documents.
    if (state.preamble !== before) requestPreview();
  }

  function persistPreamble() {
    const doc = tryGet(() => app.activeDocument, null);
    if (!isUsable(doc)) return;
    try {
      asOneUndo("Set Typst preamble", () => label.writeDocumentPreamble(doc, state.preamble));
      store.set({ preambleFromDefault: false });
    } catch (err) {
      setStatus(String((err && err.message) || err), "error");
    }
  }

  const savePreamble = debounce(persistPreamble, 600);

  function saveDefaultPreamble() {
    prefs.write({ defaultPreamble: state.preamble });
    // Silence has to mean it worked, and `prefs.write` swallows a refused
    // `setItem` — localStorage is a cache Adobe reserves the right to drop. So
    // read it back rather than trust the call, exactly as the InDesign side
    // does with a property assignment.
    if (prefs.read().defaultPreamble !== state.preamble) {
      setStatus("Could not save the default preamble.", "error");
    }
  }

  function resetDefaultPreamble() {
    store.set({ preamble: prefs.read().defaultPreamble, preambleFromDefault: false });
    savePreamble();
    requestPreview();
  }

  /* ------------------------------------------------------------------- fonts */

  async function reloadFonts(announce) {
    const { fonts: data, names, dropped } = await fonts.load();
    if (data.length || announce) {
      setBusy(true, "Loading fonts…");
      try {
        await backend.setFonts(data);
        console.log(`[typst] ${names.length} font file(s) loaded` +
          `${dropped.length ? `, ${dropped.length} missing` : ""}`);
        // A font whose file has moved is the only half of this worth saying: it
        // has just been dropped from the list, and the maths it was setting will
        // quietly come back in a different face.
        if (dropped.length) {
          setStatus(`Could not read ${dropped.join(", ")} — removed from the list.`, "error");
        }
      } catch (err) {
        setStatus(String((err && err.message) || err), "error");
        throw err;
      } finally {
        setBusy(false);
      }
    }
    requestPreview();
  }

  /* ---------------------------------------------------------------- defaults */

  /** Put the user's remembered defaults into the toolbar. */
  function applyDefaults(stored) {
    const wanted = (stored || prefs.read()).newEquation;
    store.set({
      mode: wanted.mode,
      sizeMode: wanted.sizeMode,
      sizePt: wanted.sizePt,
      colorMode: wanted.colorMode,
      colorText: wanted.colorText,
    });
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
        render: (request, want) => backend.render(request, want),
        onProgress: (i, n) => setStatus(`Re-rendering ${i + 1} of ${n}…`, "busy"),
      });
      const failed = summary.failures.length
        ? `, ${summary.failures.length} failed: ${summary.failures[0].message}`
        : "";
      // A batch is exactly where an alignment regression would hide, so the worst
      // residual is still measured and still reported — to the console, where a
      // number in points is worth something.
      const alignment = summary.worstResidual !== null && summary.worstResidual !== undefined
        ? `, worst alignment ${summary.worstResidual.toFixed(2)} pt`
        : "";
      const blind = summary.unmeasured ? `, ${summary.unmeasured} unmeasured` : "";
      console.log(`[typst] re-rendered ${summary.updated} of ${summary.total}` +
        `${failed}${alignment}${blind}`);
      // A pass that worked shows itself: every equation in the document redraws.
      // What it cannot show is one that was skipped, or a document where it found
      // nothing to do — which from the outside is identical to it never running.
      if (summary.failures.length) {
        report(`Re-rendered ${summary.updated} of ${summary.total}${failed}`, "error");
      } else if (!summary.total) {
        report("No Typst equations in this document.", "");
      }
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

  function engineLabel() {
    return state.wasmSource ? `${state.engine} · wasm via ${state.wasmSource}` : state.engine;
  }

  return {
    setStatus, setBusy, requestPreview, commit, revert,
    onSelectionChanged, watchSelection, loadDocumentPreamble, savePreamble,
    saveDefaultPreamble, resetDefaultPreamble,
    reloadFonts, applyDefaults, rerenderAllNow, aboutText, engineLabel,
  };
}

module.exports = { create };
