/**
 * The only module that knows what tag a control actually is.
 *
 * Everything else in the UI asks for "the editor's text" or "this button is a
 * call to action" and never touches `.value`, `.disabled` or `uxpVariant`
 * directly. That indirection has already paid for itself once — funnelling the
 * editor through three helpers is what kept swapping `<textarea>` for
 * `sp-textarea` down to two files — and this generalises it to the rest, which
 * were being poked at from two controllers with a duplicated copy of
 * `setVariant` between them.
 *
 * Two host behaviours make the indirection load-bearing rather than tidy:
 *
 *   - **An assignment can be refused without throwing.** The rule this codebase
 *     applies to the InDesign DOM applies to UXP's widgets too, so writes that
 *     matter are read back.
 *   - **A custom element's property does not necessarily reflect to an
 *     attribute**, and the two are not interchangeable: the Spectrum variants
 *     below are set as properties because that is where they were found, and
 *     every placeholder is an attribute in index.html for the same reason.
 */

/** Reading a control that may or may not have been upgraded yet. */
function value(element) {
  return (element && element.value) || "";
}

/** Write a value. For `<select>`, `<input>` and anything else with options. */
function setValue(element, next) {
  if (!element) return;
  element.value = next == null ? "" : String(next);
}

/**
 * Write a text editor's value, and check it landed.
 *
 * `sp-textarea` takes its value as content as well as as a property, so the
 * fallback is not decoration: a silently ignored write here looks exactly like
 * selecting an equation and having its source fail to load.
 *
 * Deliberately *not* what `setValue` does. Falling back to `textContent` on a
 * `<select>` would delete its `<option>`s — and it would do so precisely when
 * the value being written matched no option, which is the moment the control is
 * hardest to debug.
 */
function setEditorValue(element, next) {
  if (!element) return;
  const wanted = next == null ? "" : String(next);
  element.value = wanted;
  if (value(element) !== wanted) element.textContent = wanted;
}

function setDisabled(element, disabled) {
  if (element) element.disabled = !!disabled;
}

function setText(element, text) {
  if (element) element.textContent = text == null ? "" : String(text);
}

function toggleClass(element, name, on) {
  if (element) element.classList.toggle(name, !!on);
}

function focus(element) {
  try {
    if (element) element.focus();
  } catch { /* a control that will not take focus is not worth failing over */ }
}

/**
 * Spectrum variants on the standard controls.
 *
 * UXP extends a plain `<button>` and `<select>` with `uxpVariant` / `uxpQuiet` /
 * `uxpSelected` rather than requiring `sp-button`, which is why these have
 * looked native all along — so this is the whole of what converting to the
 * Spectrum tags would buy, without giving up the CSS that sizes them (an
 * `sp-*` widget's shadow root is closed, so `.font-list button { min-width }`
 * would stop applying).
 *
 * Set as properties, since that is where they were found; the CSS fallbacks
 * stay in place in case a host does not honour them.
 */
function setVariant(element, variant, quiet) {
  if (!element) return;
  try {
    if (variant) element.uxpVariant = variant;
    if (quiet) element.uxpQuiet = true;
  } catch { /* the CSS fallback carries it */ }
}

/** @param {Record<string, [string|null, boolean?]>} spec  element key -> variant */
function applyVariants(elements, spec) {
  for (const [key, [variant, quiet]] of Object.entries(spec)) {
    setVariant(elements[key], variant, quiet);
  }
}

/**
 * Bind a camelCase key -> element id map in one pass.
 *
 * Every lookup in this UI is by id: there is one document, the ids are stable,
 * and a querySelector would silently start matching something else the moment
 * a class moved.
 */
function bind(target, ids) {
  for (const [key, id] of Object.entries(ids)) {
    target[key] = document.getElementById(id);
  }
  return target;
}

module.exports = {
  value, setValue, setEditorValue, setDisabled, setText, toggleClass, focus,
  setVariant, applyVariants, bind,
};
