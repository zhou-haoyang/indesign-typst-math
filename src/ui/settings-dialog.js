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
 */
const fonts = require("./fonts");
const prefs = require("./prefs");

const el = {};
/**
 * Set once by the panel at start-up: {engine, reloadFonts, onDefaults, onError}.
 * Held here rather than threaded through every handler so that the listeners
 * can be attached exactly once.
 */
let deps = null;

function bind() {
  if (el.bound) return;
  for (const [key, id] of Object.entries({
    // The id carries the remembered geometry: UXP stores a dialog's size
    // against it, so a size change here does nothing until the id changes too.
    dialog: "settings-dialog-2", fontList: "dlg-font-list", addFonts: "dlg-add-fonts",
    clearFonts: "dlg-clear-fonts", defaultPreamble: "dlg-default-preamble",
    mode: "dlg-mode", sizeMode: "dlg-size-mode", sizePt: "dlg-size-pt",
    colorMode: "dlg-color-mode", engine: "dlg-engine", status: "dlg-status",
    done: "dlg-done",
    message: "message-dialog", messageText: "msg-text", messageOk: "msg-ok",
  })) {
    el[key] = document.getElementById(id);
  }
  el.bound = true;
  // UXP extends the standard controls with Spectrum variants, so no sp-button
  // is needed to get them. See the note in panel.js.
  setVariant(el.done, "cta");
  setVariant(el.messageOk, "cta");
  setVariant(el.addFonts, "secondary");
  setVariant(el.clearFonts, "secondary");
  wire();
}

function setVariant(element, variant, quiet) {
  if (!element) return;
  try {
    if (variant) element.uxpVariant = variant;
    if (quiet) element.uxpQuiet = true;
  } catch { /* the CSS fallback carries it */ }
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
    setVariant(remove, null, true);
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
  el.defaultPreamble.value = current.defaultPreamble;
  el.mode.value = current.newEquation.mode;
  el.sizeMode.value = current.newEquation.sizeMode;
  el.sizePt.value = current.newEquation.sizePt;
  el.sizePt.disabled = current.newEquation.sizeMode !== "fixed";
  el.colorMode.value = current.newEquation.colorMode;
}

function wire() {
  el.addFonts.addEventListener("click", async () => {
    try {
      setDialogStatus("");
      if (!await fonts.pick()) return;
      renderFonts();
      await applyFonts();
    } catch (err) {
      setDialogStatus(String((err && err.message) || err), "error");
    }
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
    el.sizePt.disabled = next.newEquation.sizeMode !== "fixed";
    deps.onDefaults(next);
  };
  el.mode.addEventListener("change", () => writeEquationDefault({ mode: el.mode.value }));
  el.sizeMode.addEventListener("change", () => writeEquationDefault({ sizeMode: el.sizeMode.value }));
  el.sizePt.addEventListener("input", () => {
    const value = parseFloat(el.sizePt.value);
    if (value > 0) writeEquationDefault({ sizePt: value });
  });
  el.colorMode.addEventListener("change", () => writeEquationDefault({ colorMode: el.colorMode.value }));

  el.done.addEventListener("click", () => el.dialog.close());
  el.messageOk.addEventListener("click", () => el.message.close());
}

/* ---------------------------------------------------------------------- API */

/** @param {object} dependencies engine, reloadFonts, onDefaults, onError */
function configure(dependencies) {
  deps = dependencies;
}

async function showSettings() {
  bind();
  renderFonts();
  loadPrefs();
  el.engine.textContent = deps.engine() || "";
  setDialogStatus("");

  try {
    await open(el.dialog, {
      title: "Typst Math Settings",
      resize: "both",
      size: { width: 400, height: 480 },
      minSize: { width: 300, height: 320 },
    });
  } catch (err) {
    // Losing the dialog means losing the only way to add a font, so this has to
    // announce itself in the panel rather than look like a dead button.
    deps.onError(`Could not open the settings dialog: ${(err && err.message) || err}`);
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
