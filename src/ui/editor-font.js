/**
 * Force a monospace face onto an `sp-textarea`.
 *
 * The editors are Spectrum components rather than plain textareas, because a
 * plain `<textarea>` draws no caret in this host. The cost is that the real
 * control lives in a shadow root, and `font-family` set on the host does not
 * necessarily reach it — which is how the equation editor ended up rendering
 * Typst source in a proportional face.
 *
 * Three routes, cheapest first, because which of them works depends on how this
 * UXP build implements the component:
 *
 *   1. `font-family` on the host, in panel.css, if the component inherits it;
 *   2. `::part(input)`, also in panel.css, if it exposes a part;
 *   3. a <style> appended into the shadow root, from here, if it is open.
 *
 * `describe()` reports what was actually reachable, so a failure names the
 * shadow root's contents instead of costing another round of guessing.
 */

const FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Courier New", monospace';

const RULE = `
  textarea, input, [part="input"],
  .spectrum-Textfield-input, .spectrum-Textfield-inputMultiline {
    font-family: ${FAMILY} !important;
  }
`;

/**
 * @returns {string} what happened, for the log. A component whose shadow root
 *   is closed reports "host only" and is *not* marked done, so a later call —
 *   after the dialog holding it has been shown for the first time, say — can
 *   try again.
 */
function applyMonospace(element) {
  if (!element) return "no element";
  if (element.__monoApplied) return "already applied";

  const root = element.shadowRoot;
  if (!root) return "host only (no open shadow root)";

  try {
    const style = document.createElement("style");
    style.textContent = RULE;
    root.appendChild(style);
    element.__monoApplied = true;
    return "shadow style";
  } catch (err) {
    return `shadow style failed: ${(err && err.message) || err}`;
  }
}

/** The shadow root's shape, so a failure can be fixed without another guess. */
function describe(element) {
  const root = element && element.shadowRoot;
  if (!root) return "none";
  const kids = [];
  const children = root.children || [];
  for (let i = 0; i < children.length && i < 8; i++) {
    const node = children[i];
    const cls = node.className ? `.${String(node.className).split(" ")[0]}` : "";
    const part = node.getAttribute && node.getAttribute("part");
    kids.push(`${node.tagName.toLowerCase()}${cls}${part ? `[part=${part}]` : ""}`);
  }
  return kids.join(" ") || "empty";
}

module.exports = { applyMonospace, describe, FAMILY };
