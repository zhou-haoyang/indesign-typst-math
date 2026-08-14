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
  colorMode: "color-mode", colorText: "color-text",
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
  preambleSaveDefault: ["secondary"],
  preambleResetDefault: ["secondary"],
};

/**
 * What the size and colour boxes show.
 *
 * On "Fixed" that is the state, which is what the user typed into them. On
 * "Match text" they are disabled, and showing the value *underneath* them — the
 * fixed one they are not going to use — was a quiet lie about what the next
 * insert would do. So they show what the last render matched off the document
 * instead; actions.js fills those two fields from the same resolution it builds
 * the render request from, so the boxes and the artwork cannot disagree.
 *
 * The fallback is the fixed value, which covers the moment before the first
 * preview has run. After that, a match with nothing to read is not empty:
 * `resolveTypography` falls back to exactly these two, so the box still says
 * what is about to be rendered.
 *
 * Measured before being relied on, since a refused write here would be silent:
 * a disabled `<input>` in this host does take a `.value`, number and text
 * alike, and the size box holds an off-step, out-of-range point size rather
 * than clamping it (`min`/`max`/`step` bind the user, not the panel).
 */
const shownSize = (state) => (state.sizeMode === "auto" && state.matchedSizePt
  ? state.matchedSizePt
  : state.sizePt);
const shownColor = (state) => (state.colorMode === "auto" && state.matchedColorText
  ? state.matchedColorText
  : state.colorText);

/**
 * @param {object} store
 * @param {object} on  what to call when the user asks for something that needs
 *   InDesign or the compiler: preview, commit, revert, savePreamble,
 *   saveDefaultPreamble, resetDefaultPreamble. Settings is not among them: it
 *   is reached from the flyout and the Plug-Ins menu, which panel.js dispatches
 *   without going through the view.
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

    if (changed(previous, next, "mode", "sizeMode", "sizePt", "colorMode", "colorText",
      "matchedSizePt", "matchedColorText")) {
      writeIfIdle(el.mode, next.mode);
      writeIfIdle(el.sizeMode, next.sizeMode);
      writeIfIdle(el.sizePt, shownSize(next));
      widgets.setDisabled(el.sizePt, next.sizeMode !== "fixed");
      writeIfIdle(el.colorMode, next.colorMode);
      // Same caret rule as the point size, and it bites harder here: every
      // character of `rgb("#c00")` is a state the poll could write back over.
      writeIfIdle(el.colorText, shownColor(next));
      widgets.setDisabled(el.colorText, next.colorMode !== "fixed");
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
    // Switching to Fixed keeps the number that is on screen rather than reviving
    // the one underneath it. On "Match text" the box shows what was matched, so
    // the switch reads as "hold this value" — and snapping back to a size typed
    // some time ago would look like the panel changing its mind about what it is
    // about to insert. Read before the set, while the mode is still the old one.
    el.sizeMode.addEventListener("change", () => {
      const sizeMode = widgets.value(el.sizeMode);
      const held = shownSize(store.get());
      store.set(sizeMode === "fixed" ? { sizeMode, sizePt: held } : { sizeMode });
      on.preview();
    });
    el.sizePt.addEventListener("input", () => {
      const value = parseFloat(widgets.value(el.sizePt));
      if (value > 0) store.set({ sizePt: value });
      on.preview();
    });
    // As above, and more useful here: the matched colour arrives as a Typst
    // expression, so switching to Fixed hands the user the swatch they were
    // matching as something they can edit.
    el.colorMode.addEventListener("change", () => {
      const colorMode = widgets.value(el.colorMode);
      const held = shownColor(store.get());
      store.set(colorMode === "fixed" ? { colorMode, colorText: held } : { colorMode });
      on.preview();
    });
    // Stored verbatim, half-typed and all: `rgb("#c` is on the way to something
    // valid, and normalising as it is typed would fight the user the way
    // parseFloat once ate the point size's decimal point. What an empty or
    // whitespace box means is decided at render time, in src/ui/spec.js.
    el.colorText.addEventListener("input", () => {
      store.set({ colorText: widgets.value(el.colorText) });
      on.preview();
    });

    el.insert.addEventListener("click", () => on.commit());
    el.revert.addEventListener("click", () => on.revert());

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
