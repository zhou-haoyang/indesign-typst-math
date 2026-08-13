/**
 * The panel's DOM: bound once, wired once, and redrawn from the store.
 *
 * Everything that reads or writes a control is here, and `render` is the whole
 * of the drawing. Before this, four functions each hand-updated an overlapping
 * subset of controls and a fifth had to remember to call them, so adding a
 * control meant finding all five.
 *
 * Two invariants, both of them measured rather than stylistic:
 *
 *   - **No node is created, removed or re-parented after boot, and no ancestor
 *     of #editor is ever hidden.** A UXP text control that spends any time
 *     inside a `display: none` subtree never becomes editable again. That is
 *     why one editor serves both tabs by swapping its contents.
 *   - **A control is written only when it is idle and out of date.** The panel
 *     re-derives its state from a 700 ms poll; writing `.value` on a focused
 *     field moves the caret, and writing it while someone types "1." would
 *     round-trip through parseFloat and hand back "1".
 */
const spec = require("./spec");
const status = require("./status");
const widgets = require("./widgets");
const { changed } = require("./store");

const IDS = {
  editor: "editor", preview: "preview", status: "status", insert: "insert",
  revert: "revert", mode: "mode", sizeMode: "size-mode", sizePt: "size-pt",
  colorMode: "color-mode", settingsToggle: "settings-toggle",
  tabEquation: "tab-equation", tabPreamble: "tab-preamble",
  preambleDot: "preamble-dot", preambleActions: "preamble-actions",
  preambleHint: "preamble-hint",
  preambleSaveDefault: "preamble-save-default",
  preambleResetDefault: "preamble-reset-default",
};

/** Why these are properties on plain controls rather than sp-* tags: widgets.js. */
const VARIANTS = {
  insert: ["cta"],
  revert: ["secondary"],
  settingsToggle: [null, true],
  preambleSaveDefault: ["secondary"],
  preambleResetDefault: ["secondary"],
};

/**
 * @param {object} store
 * @param {object} on  what to call when the user asks for something that needs
 *   InDesign or the compiler: preview, commit, revert, settings, savePreamble,
 *   saveDefaultPreamble, resetDefaultPreamble.
 */
function create(store, on) {
  const el = widgets.bind({}, IDS);
  widgets.applyVariants(el, VARIANTS);

  /**
   * The editor's three accessors. Everything that touches the widget goes
   * through them, so that swapping it costs these plus the one tag in
   * index.html — which is what kept the last swap to two files.
   */
  const editorText = () => widgets.value(el.editor);
  const setEditorText = (text) => widgets.setEditorValue(el.editor, text);

  function writeIfIdle(element, value) {
    if (!element || document.activeElement === element) return;
    if (widgets.value(element) === String(value)) return;
    widgets.setValue(element, value);
  }

  /**
   * The preamble is a tab rather than a drawer because it wants the live preview
   * below it exactly as much as the equation does — and for the same reason it
   * is not in the settings dialog, which would cover the preview entirely.
   *
   * The two tabs share one editor, so switching means writing the visible text
   * back to the buffer it belongs to and loading the other. Which buffer that
   * is, and the round-trip guarantee, are src/ui/spec.js's business.
   */
  function switchTab(name) {
    const patch = spec.swapTab(store.get(), name, editorText());
    if (!patch) return;
    store.set(patch);
    // Not part of render: focus is a consequence of the *click*, not of the
    // state being what it is, and re-focusing on every pass would fight the
    // user.
    widgets.focus(el.editor);
  }

  function render(next, previous) {
    if (changed(previous, next, "status")) {
      widgets.setText(el.status, next.status.text);
      el.status.className = status.className(next.status);
      // Mirrored to the console so it can be read and copied even after the
      // panel moves on, and so it survives a status too long for the panel.
      if (status.worthLogging(next.status)) console.log(`[typst] ${next.status.text}`);
    }

    const tabChanged = changed(previous, next, "tab");
    if (tabChanged) {
      const preamble = next.tab === "preamble";
      widgets.setPlaceholder(el.editor, spec.PLACEHOLDER[next.tab]);
      widgets.toggleClass(el.preambleActions, "hidden", !preamble);
      widgets.toggleClass(el.tabEquation, "active", !preamble);
      widgets.toggleClass(el.tabPreamble, "active", preamble);
    }

    // Switching tabs, or selecting a different equation, always reloads the
    // editor — that is the whole point of either. A buffer changing underneath
    // does so only when the user is not in the box.
    const reloaded = tabChanged || changed(previous, next, "editing");
    const bufferChanged = changed(previous, next, "body", "preamble");
    if (reloaded || (bufferChanged && document.activeElement !== el.editor)) {
      const wanted = spec.visibleFor(next);
      if (editorText() !== wanted) setEditorText(wanted);
    }

    if (changed(previous, next, "editing")) {
      widgets.setText(el.insert, next.editing ? "Update" : "Insert");
      widgets.toggleClass(el.revert, "hidden", !next.editing);
    }

    if (changed(previous, next, "mode", "sizeMode", "sizePt", "colorMode")) {
      writeIfIdle(el.mode, next.mode);
      writeIfIdle(el.sizeMode, next.sizeMode);
      writeIfIdle(el.sizePt, next.sizePt);
      widgets.setDisabled(el.sizePt, next.sizeMode !== "fixed");
      writeIfIdle(el.colorMode, next.colorMode);
    }

    if (changed(previous, next, "preamble", "preambleFromDefault", "tab")) {
      widgets.toggleClass(el.preambleDot, "hidden", !next.preamble.trim());
      widgets.setText(el.preambleHint, next.tab === "preamble" && next.preambleFromDefault
        ? "From your default — saved into this document when you insert an equation."
        : "");
    }

    // Insert is enabled by there being something to insert, which is the same
    // question as "did the last preview produce metrics".
    if (changed(previous, next, "busy", "lastMetrics")) {
      widgets.setDisabled(el.insert, next.busy || !next.lastMetrics);
    }
  }

  function wire() {
    el.editor.addEventListener("input", () => {
      if (store.get().tab === "preamble") {
        // Editing it makes it this document's, whatever it started as.
        store.set({ preamble: editorText(), preambleFromDefault: false });
        on.savePreamble();
      } else {
        store.set({ body: editorText() });
      }
      on.preview();
    });
    el.editor.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        on.commit();
      }
    });

    el.mode.addEventListener("change", () => {
      store.set({ mode: widgets.value(el.mode) });
      on.preview();
    });
    el.sizeMode.addEventListener("change", () => {
      store.set({ sizeMode: widgets.value(el.sizeMode) });
      on.preview();
    });
    el.sizePt.addEventListener("input", () => {
      const value = parseFloat(widgets.value(el.sizePt));
      if (value > 0) store.set({ sizePt: value });
      on.preview();
    });
    el.colorMode.addEventListener("change", () => {
      store.set({ colorMode: widgets.value(el.colorMode) });
      on.preview();
    });

    el.insert.addEventListener("click", () => on.commit());
    el.revert.addEventListener("click", () => on.revert());
    el.settingsToggle.addEventListener("click", () => on.settings());

    el.tabEquation.addEventListener("click", () => switchTab("equation"));
    el.tabPreamble.addEventListener("click", () => switchTab("preamble"));

    el.preambleSaveDefault.addEventListener("click", () => on.saveDefaultPreamble());
    el.preambleResetDefault.addEventListener("click", () => on.resetDefaultPreamble());
  }

  wire();
  store.subscribe(render);

  return {
    /** The <webview> the compiler and preview live in. */
    preview: el.preview,
    /** First paint: `{}` so every branch sees a change from nothing. */
    paint: () => render(store.get(), {}),
  };
}

module.exports = { create };
