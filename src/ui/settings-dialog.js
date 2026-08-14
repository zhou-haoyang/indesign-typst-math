/**
 * The settings dialog, and the message dialog the menu commands report into.
 *
 * What lives here is everything that is per-user rather than per-document or
 * per-equation, and that needs no live preview: the extra fonts, the default
 * preamble, and what a new equation starts as. The document preamble is
 * deliberately *not* here — a modal draws over the panel, so editing macros in
 * a dialog would mean editing them blind. It stays in the panel, as a tab.
 *
 * Both dialogs are declared in index.html because showModal() throws on an
 * element that is not in the document, and neither is removed on close.
 *
 * The settings dialog is opened in a loop rather than once, because on macOS a
 * modal owns the application's modal loop and the native file picker opened
 * underneath it never receives a click — see the Add-fonts handler below.
 */
const fonts = require("./fonts");
const prefs = require("./prefs");
const widgets = require("./widgets");

const el = {};
/**
 * Set once by the panel at start-up: {engine, reloadFonts, onDefaults, onError}.
 * Held here rather than threaded through every handler so that the listeners
 * can be attached exactly once.
 */
let deps = null;

const PICK_FONTS = "pick-fonts";
/**
 * Why the settings dialog closed, set just before the close that means it.
 * A module variable rather than close(value)/returnValue because what
 * uxpShowModal resolves with is not something this host documents, and getting
 * it wrong would silently end the loop in showSettings.
 */
let closeReason = null;

const SETTINGS_OPTIONS = {
  title: "Typst Math Settings",
  resize: "both",
  // Taller than before now that the extra height reaches the preamble editor
  // instead of pooling under the Done row.
  size: { width: 420, height: 520 },
  minSize: { width: 300, height: 360 },
};

function bind() {
  if (el.bound) return;
  widgets.bind(el, {
    // The id carries the remembered geometry: UXP stores a dialog's size
    // against it, so a size change here does nothing until the id changes too.
    // Both were bumped when the dialogs learned to fill vertically — which
    // discards whatever size they had been dragged to, once.
    dialog: "settings-dialog-3", fontList: "dlg-font-list", addFonts: "dlg-add-fonts",
    clearFonts: "dlg-clear-fonts", defaultPreamble: "dlg-default-preamble",
    mode: "dlg-mode", sizeMode: "dlg-size-mode", sizePt: "dlg-size-pt",
    colorMode: "dlg-color-mode", colorText: "dlg-color-text",
    engine: "dlg-engine", status: "dlg-status",
    done: "dlg-done",
    message: "message-dialog-2", messageText: "msg-text", messageOk: "msg-ok",
  });
  el.bound = true;
  widgets.applyVariants(el, {
    done: ["cta"], messageOk: ["cta"],
    addFonts: ["secondary"], clearFonts: ["secondary"],
  });
  wire();
}

/**
 * Only one modal may be open at a time, and uxpShowModal carries a title and
 * sizing that plain showModal cannot.
 */
function open(dialog, options) {
  if (typeof dialog.uxpShowModal === "function") return dialog.uxpShowModal(options);
  return Promise.resolve(dialog.showModal());
}

function setDialogStatus(text, kind) {
  el.status.textContent = text || "";
  el.status.className = `status${kind ? " " + kind : ""}`;
}

/* -------------------------------------------------------------------- fonts */

/** Fonts can only be registered when the compiler is built, so this is slow. */
async function applyFonts() {
  setDialogStatus("Rebuilding the compiler…", "busy");
  try {
    await deps.reloadFonts();
    setDialogStatus("");
  } catch (err) {
    setDialogStatus(String((err && err.message) || err), "error");
  }
}

function renderFonts() {
  const names = fonts.names();
  el.fontList.textContent = "";
  if (!names.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Typst defaults only";
    el.fontList.appendChild(li);
    return;
  }
  names.forEach((name, index) => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = name;
    const remove = document.createElement("button");
    remove.textContent = "✕";
    remove.title = `Remove ${name}`;
    widgets.setVariant(remove, null, true);
    remove.addEventListener("click", async () => {
      fonts.remove(index);
      renderFonts();
      await applyFonts();
    });
    li.appendChild(text);
    li.appendChild(remove);
    el.fontList.appendChild(li);
  });
}

/* ------------------------------------------------------------------ defaults */

function loadPrefs() {
  const current = prefs.read();
  // Through widgets.setEditorValue, not `.value =`: this editor is an
  // sp-textarea and takes its value as content too, so a silently refused write
  // here used to be indistinguishable from an empty default preamble. The
  // panel's editor has had that read-back for a long time; this one was
  // reaching past it. Note the selects below use setValue, which has no
  // textContent fallback — that would delete their options.
  widgets.setEditorValue(el.defaultPreamble, current.defaultPreamble);
  widgets.setValue(el.mode, current.newEquation.mode);
  widgets.setValue(el.sizeMode, current.newEquation.sizeMode);
  widgets.setValue(el.sizePt, current.newEquation.sizePt);
  widgets.setDisabled(el.sizePt, current.newEquation.sizeMode !== "fixed");
  widgets.setValue(el.colorMode, current.newEquation.colorMode);
  widgets.setValue(el.colorText, current.newEquation.colorText);
  widgets.setDisabled(el.colorText, current.newEquation.colorMode !== "fixed");
}

function wire() {
  // The picker cannot be opened from here. On macOS this modal owns the
  // application's modal loop, so the file dialog comes up unresponsive: it
  // draws, and every click goes to the settings dialog instead. So the button
  // only closes the dialog with a reason, and showSettings does the picking
  // with nothing modal on screen before reopening.
  el.addFonts.addEventListener("click", () => {
    closeReason = PICK_FONTS;
    el.dialog.close();
  });

  el.clearFonts.addEventListener("click", async () => {
    fonts.clear();
    renderFonts();
    await applyFonts();
  });

  el.defaultPreamble.addEventListener("input", () => {
    deps.onDefaults(prefs.write({ defaultPreamble: el.defaultPreamble.value || "" }));
  });

  const writeEquationDefault = (patch) => {
    const next = prefs.write({ newEquation: patch });
    widgets.setDisabled(el.sizePt, next.newEquation.sizeMode !== "fixed");
    widgets.setDisabled(el.colorText, next.newEquation.colorMode !== "fixed");
    deps.onDefaults(next);
  };
  el.mode.addEventListener("change", () => writeEquationDefault({ mode: el.mode.value }));
  el.sizeMode.addEventListener("change", () => writeEquationDefault({ sizeMode: el.sizeMode.value }));
  el.sizePt.addEventListener("input", () => {
    const value = parseFloat(el.sizePt.value);
    if (value > 0) writeEquationDefault({ sizePt: value });
  });
  el.colorMode.addEventListener("change", () => writeEquationDefault({ colorMode: el.colorMode.value }));
  // Stored as typed, like the panel's own box: this is a Typst expression on
  // its way to being one, and there is nothing here that could judge it.
  el.colorText.addEventListener("input", () => writeEquationDefault({ colorText: el.colorText.value }));

  el.done.addEventListener("click", () => el.dialog.close());
  el.messageOk.addEventListener("click", () => el.message.close());
}

/* ---------------------------------------------------------------------- API */

/** @param {object} dependencies engine, reloadFonts, onDefaults, onError */
function configure(dependencies) {
  deps = dependencies;
}

/**
 * Ask for font files with the dialog off screen, and carry the outcome back so
 * the reopened dialog can report it. Nothing is said here: there is nowhere to
 * say it, the panel's own status line being about the document.
 * @returns {Promise<{added?: true, error?: string}|null>}
 */
async function pickFonts() {
  // One turn of the host's event loop before the picker, so that closing the
  // modal has finished landing rather than racing the file dialog.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    return await fonts.pick() ? { added: true } : null;
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

/**
 * Losing the dialog means losing the only way to add a font, so this has to
 * announce itself in the panel rather than look like a dead button.
 */
function reportOpenFailure(err) {
  deps.onError(`Could not open the settings dialog: ${(err && err.message) || err}`);
}

async function showSettings() {
  bind();
  // What the last trip round the loop left to be reported or acted on, once
  // there is a dialog on screen to report it into.
  let pending = null;

  for (;;) {
    renderFonts();
    loadPrefs();
    el.engine.textContent = deps.engine() || "";
    if (pending && pending.error) setDialogStatus(pending.error, "error");
    else setDialogStatus("");

    closeReason = null;
    let closed;
    try {
      closed = open(el.dialog, SETTINGS_OPTIONS);
    } catch (err) {
      reportOpenFailure(err);
      return;
    }

    // Deliberately not awaited: rebuilding the compiler takes seconds and has
    // to run with the dialog on screen, or "Rebuilding the compiler…" arrives
    // somewhere nobody is looking. It reports into the status line itself.
    if (pending && pending.added) applyFonts();
    pending = null;

    try {
      await closed;
    } catch (err) {
      reportOpenFailure(err);
      return;
    }

    if (closeReason !== PICK_FONTS) return;
    pending = await pickFonts();
  }
}

/** Report into a dialog, for when there may be no visible panel to report into. */
async function showMessage(text, title) {
  bind();
  el.messageText.textContent = text || "";
  try {
    await open(el.message, { title: title || "Typst Math", size: { width: 380, height: 220 } });
  } catch {
    // Nothing left to report it with; the console is the last resort.
    console.log(`[typst] ${text}`);
  }
}

module.exports = { configure, showSettings, showMessage };
