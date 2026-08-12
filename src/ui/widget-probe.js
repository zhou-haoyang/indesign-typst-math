/**
 * TEMPORARY. Measure which Spectrum UXP widgets this host actually implements,
 * before converting any of the panel's controls to them.
 *
 * Delete this module and its call in panel.js once that decision is made.
 *
 * Every guess about a UXP control in this plugin's history has been wrong at
 * least once, and each wrong one costs a plugin reload, so nothing here asks
 * anyone to judge by eye.
 *
 * Five discriminators have been tried and four were worthless. Keeping the
 * record because every one of them looked like evidence:
 *
 *   - **rendered size** — `getBoundingClientRect` returns 0x0 for everything in
 *     this host, plain `<button>` included, so nothing off-screen is laid out
 *     to measure. Dropped.
 *   - **`constructor.name`** — reports "?" for every element here, `<button>`
 *     included. Dropped.
 *   - **`customElements.get(tag)`** — reports NO for `sp-textarea`, which the
 *     panel is built on and which demonstrably works. UXP's Spectrum widgets
 *     are implemented by the host, not registered as custom elements, so the
 *     registry is the wrong question. Dropped.
 *   - **writing `.value` and reading it back** — "round-trips" on any element
 *     at all, since on an unimplemented one that is a plain JS property nobody
 *     reads. Useless alone, but a value that comes back *changed* does prove a
 *     native accessor is intercepting.
 *
 *   - **prototype vs a `<div>`'s** — an unimplemented `sp-*` falls back to the
 *     *base* element prototype, which a div's differs from as well, so this
 *     called everything implemented. Dropped.
 *
 * What works is the prototype compared against a **derived** reference: ask for
 * a tag that certainly does not exist and see what it gets. Anything sharing
 * that prototype is unimplemented. No layout, no registry, no names, and no
 * assumption about what the fallback should be — each of which broke a previous
 * version.
 *
 * Controls, and they are the point: `button`/`select`/`sp-textarea` must all
 * come back YES, and the nonsense tag must come back `.`. **If they do not, the
 * probe is broken and the rest of the table means nothing.** That is twice now
 * that this has caught a probe reporting confident nonsense.
 */

/** @param {{tag: string, attrs?: object, text?: string, children?: object[]}} spec */
function build(spec) {
  const node = document.createElement(spec.tag);
  for (const [key, value] of Object.entries(spec.attrs || {})) {
    node.setAttribute(key, value);
  }
  if (spec.text) node.textContent = spec.text;
  for (const child of spec.children || []) node.appendChild(build(child));
  return node;
}

/**
 * A tag that certainly does not exist. Whatever prototype the host gives this
 * is, by definition, the "unimplemented" one — which is the reference every
 * other row is compared against.
 *
 * Declared here rather than beside its helper below because CANDIDATES uses it,
 * and a `const` referenced before its initialiser throws at module load.
 */
const NONSENSE_TAG = "sp-certainly-not-a-widget-xyz";

const MENU = [{
  tag: "sp-menu",
  attrs: { slot: "options" },
  children: [
    { tag: "sp-menu-item", attrs: { value: "a" }, text: "Inline" },
    { tag: "sp-menu-item", attrs: { value: "b" }, text: "Display" },
  ],
}];

const CANDIDATES = [
  // Positive controls: what the panel uses today and demonstrably works.
  { name: "button (plain)", tag: "button", text: "Insert" },
  { name: "select (plain)", tag: "select" },
  { name: "sp-textarea", tag: "sp-textarea", value: "x^2" },
  // Negative control. If this says YES, the probe is measuring nothing.
  { name: "NONSENSE (must be .)", tag: NONSENSE_TAG, value: "z" },

  { name: "sp-button[cta]", tag: "sp-button", attrs: { variant: "cta" }, text: "Insert" },
  { name: "sp-button[secondary]", tag: "sp-button", attrs: { variant: "secondary" }, text: "Revert" },
  { name: "sp-button[quiet]", tag: "sp-button", attrs: { quiet: "true" }, text: "✕" },
  { name: "sp-action-button", tag: "sp-action-button", attrs: { quiet: "true" }, text: "⚙" },

  { name: "sp-picker", tag: "sp-picker", children: MENU, value: "b" },
  { name: "sp-dropdown", tag: "sp-dropdown", children: MENU, value: "b" },

  { name: "sp-textfield", tag: "sp-textfield", value: "10" },
  { name: "sp-textfield[number]", tag: "sp-textfield", attrs: { type: "number", min: "1", max: "600", step: "0.5" }, value: "10" },
  // The one editor option never tried, and the reason this list exists at all.
  { name: "sp-textfield[multiline]", tag: "sp-textfield", attrs: { multiline: "true" }, value: "x^2" },

  { name: "sp-tabs", tag: "sp-tabs", children: [
    { tag: "sp-tab", attrs: { value: "eq", selected: "true" }, text: "Equation" },
    { tag: "sp-tab", attrs: { value: "pre" }, text: "Preamble" },
  ] },
  { name: "sp-label", tag: "sp-label", text: "Style" },
  { name: "sp-checkbox", tag: "sp-checkbox", text: "On" },
];

/**
 * The prototype an *unimplemented* hyphenated tag gets. Derived rather than
 * assumed, because assuming it is what broke the previous version: a `<div>` is
 * the wrong reference, since an unimplemented `sp-*` falls back to the base
 * element prototype, which a div's differs from too — so everything compared as
 * "implemented".
 */
function unimplementedPrototype() {
  return Object.getPrototypeOf(document.createElement(NONSENSE_TAG));
}

/** Members the widget's own prototype adds, which is a sketch of its API. */
function ownMembers(node) {
  try {
    const proto = Object.getPrototypeOf(node);
    if (!proto || proto === unimplementedPrototype()) return [];
    return Object.getOwnPropertyNames(proto)
      .filter((n) => n !== "constructor")
      .slice(0, 6);
  } catch {
    return [];
  }
}

function measure(host, spec) {
  const node = build(spec);
  host.appendChild(node);

  // The one signal that survives this host: an implemented element carries its
  // own prototype, an unimplemented one shares the plain element's.
  let own = false;
  try {
    own = Object.getPrototypeOf(node) !== unimplementedPrototype();
  } catch { /* leave it false and let the baselines expose that */ }

  const before = (() => {
    try { return typeof node.value; } catch { return "threw"; }
  })();

  let value = "-";
  if (spec.value !== undefined) {
    try {
      node.value = spec.value;
      const read = node.value;
      value = read === spec.value
        ? `ok (was ${before})`
        : `wrote ${JSON.stringify(spec.value)}, read ${JSON.stringify(read)}`;
    } catch (err) {
      value = `threw: ${(err && err.message) || err}`;
    }
  }

  return {
    name: spec.name,
    own,
    // A native accessor that rewrites what you gave it is implemented too, even
    // if the prototype test somehow misses it.
    intercepts: spec.value !== undefined && !/^ok /.test(value) && !/^threw/.test(value),
    members: ownMembers(node).join(",") || "-",
    shadow: node.shadowRoot ? "open" : "closed/none",
    value,
  };
}

/** @returns {string} a report for the console; never throws. */
function report() {
  let host = null;
  try {
    // Hidden is fine: nothing here measures layout any more, and layout was
    // never available off-screen in this host anyway.
    host = document.createElement("div");
    host.style.display = "none";
    document.body.appendChild(host);

    const lines = CANDIDATES.map((spec) => {
      let row;
      try {
        row = measure(host, spec);
      } catch (err) {
        row = {
          name: spec.name, own: false, intercepts: false, members: "-", shadow: "-",
          value: `build threw: ${(err && err.message) || err}`,
        };
      }
      const yes = row.own || row.intercepts;
      return `  ${(yes ? "YES " : "  . ")}${row.name.padEnd(24)}` +
        ` shadow ${row.shadow.padEnd(12)} value ${String(row.value).padEnd(34)} ${row.members}`;
    });
    return "[typst] Spectrum widget probe — YES = implemented (own prototype)\n" +
      "        Controls: button, select, sp-textarea MUST be YES; NONSENSE MUST be '.'\n" +
      lines.join("\n");
  } catch (err) {
    return `[typst] widget probe failed: ${(err && err.message) || err}`;
  } finally {
    if (host && host.remove) host.remove();
  }
}

module.exports = { report };
