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
 *   - **No node is created, removed or re-parented after boot, and neither
 *     editor, nor any ancestor of one, is ever hidden.** A UXP text control that
 *     spends any time inside a `display: none` subtree never becomes editable
 *     again. The two editors are stacked and the inactive one parked off-stage
 *     instead; see .editor-stack in panel.css.
 *   - **A control is written only when it is idle and out of date.** The panel
 *     re-derives its state from a 700 ms poll; writing `.value` on a focused
 *     field moves the caret, and writing it while someone types "1." would
 *     round-trip through parseFloat and hand back "1".
 */
const status = require("./status");
const widgets = require("./widgets");
const { changed } = require("./store");

const IDS = {
  editor: "editor", preambleEditor: "preamble-editor",
  preview: "preview", status: "status", insert: "insert",
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
   * One editor per tab, and the accessors everything else goes through — so
   * that swapping the widget costs these plus the two tags in index.html, which
   * is what kept the last swap to two files.
   */
  const editors = { equation: el.editor, preamble: el.preambleEditor };
  const editorText = (tab) => widgets.value(editors[tab]);

  /**
   * Load a buffer into its editor.
   *
   * Skipped while the user is in that box, because a view pass runs on every
   * 700 ms selection poll and writing `.value` moves the caret to the start.
   * `force` is for the one case that outranks that: selecting a different
   * equation is a request to see its source.
   */
  function writeEditor(tab, text, force) {
    const element = editors[tab];
    if (!force && document.activeElement === element) return;
    if (editorText(tab) !== text) widgets.setEditorValue(element, text);
  }

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
   * Each tab owns an editor that keeps its own text, so switching moves the
   * stack and nothing else: no buffer is read back or reloaded, and the two
   * cannot bleed into one another the way one shared control could.
   */
  function switchTab(name) {
    if (!store.set({ tab: name })) return;
    // Not part of render: focus is a consequence of the *click*, not of the
    // state being what it is, and re-focusing on every pass would fight the
    // user.
    widgets.focus(editors[name]);
  }

  function render(next, previous) {
    if (changed(previous, next, "status")) {
      widgets.setText(el.status, next.status.text);
      el.status.className = status.className(next.status);
      // Mirrored to the console so it can be read and copied even after the
      // panel moves on, and so it survives a status too long for the panel.
      if (status.worthLogging(next.status)) console.log(`[typst] ${next.status.text}`);
    }

    if (changed(previous, next, "tab")) {
      const preamble = next.tab === "preamble";
      // Which editor is on stage. Never `display: none`: see the file header.
      widgets.toggleClass(el.editor, "offstage", preamble);
      widgets.toggleClass(el.preambleEditor, "offstage", !preamble);
      widgets.toggleClass(el.preambleActions, "hidden", !preamble);
      widgets.toggleClass(el.tabEquation, "active", !preamble);
      widgets.toggleClass(el.tabPreamble, "active", preamble);
    }

    // Each editor already holds its own tab's text, so a switch reloads nothing.
    // What is left is a buffer changing underneath: the document's preamble
    // arriving, or a selected equation's source.
    const reselected = changed(previous, next, "editing");
    if (reselected || changed(previous, next, "body")) {
      writeEditor("equation", next.body, reselected);
    }
    if (changed(previous, next, "preamble")) writeEditor("preamble", next.preamble);

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
      store.set({ body: editorText("equation") });
      on.preview();
    });
    el.preambleEditor.addEventListener("input", () => {
      // Editing it makes it this document's, whatever it started as.
      store.set({ preamble: editorText("preamble"), preambleFromDefault: false });
      on.savePreamble();
      on.preview();
    });
    for (const editor of Object.values(editors)) {
      editor.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          on.commit();
        }
      });
    }

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
