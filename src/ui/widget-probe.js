/**
 * TEMPORARY. Measure which Spectrum UXP widgets this host actually implements,
 * before converting any of the panel's controls to them.
 *
 * Delete this module and its call in panel.js once that decision is made.
 *
 * Every guess about a UXP control in this plugin's history has been wrong at
 * least once, and each wrong one costs a plugin reload, so nothing here asks
 * anyone to judge by eye. Each candidate is built off-screen, measured, and
 * reported:
 *
 *   - **def** is the real discriminator: whether the tag is a registered custom
 *     element. Size is not — an unregistered tag with text in it still lays out
 *     as inline content with a height, and `.value` "round-trips" on anything,
 *     because on an unregistered element that is just a JS property nobody
 *     reads. Both of those looked like evidence in an earlier draft of this
 *     probe and were not.
 *   - **ctor** is the fallback for the same question, for if the host does not
 *     expose a custom element registry: an unregistered `sp-*` name constructs
 *     as a plain `HTMLElement`.
 *   - **size** is still worth seeing, since a registered widget that renders to
 *     nothing is its own kind of broken.
 *   - **shadow** says whether anything inside can be styled from outside.
 *     `sp-textarea` answers "closed/none", which is what costs the monospace
 *     face; expect the same elsewhere, but confirm rather than assume.
 *
 * `sp-textarea` is the positive control and plain `button`/`select` are the
 * baselines, so a row of failures can be told from a broken probe.
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

const MENU = [{
  tag: "sp-menu",
  attrs: { slot: "options" },
  children: [
    { tag: "sp-menu-item", attrs: { value: "a" }, text: "Inline" },
    { tag: "sp-menu-item", attrs: { value: "b" }, text: "Display" },
  ],
}];

const CANDIDATES = [
  // Baselines: what the panel uses today, so a zeroed row can be told from a
  // probe that simply is not working.
  { name: "button (plain)", tag: "button", text: "Insert" },
  { name: "select (plain)", tag: "select" },
  // Positive control: known to render, known to have a closed shadow root.
  { name: "sp-textarea", tag: "sp-textarea", value: "x^2" },

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

function registry() {
  try {
    return typeof customElements === "undefined" ? null : customElements;
  } catch {
    return null;
  }
}

function measure(host, spec) {
  const node = build(spec);
  host.appendChild(node);

  const box = node.getBoundingClientRect();
  const shadow = node.shadowRoot ? "open" : "closed/none";
  const registered = registry();
  const ctor = String((node.constructor && node.constructor.name) || "?");

  let def;
  if (spec.tag.indexOf("-") === -1) {
    def = "n/a";                                  // a plain element is not a custom one
  } else if (!registered) {
    def = "?";                                    // no registry to ask
  } else {
    def = registered.get(spec.tag) ? "yes" : "NO";
  }

  let value = "-";
  if (spec.value !== undefined) {
    try {
      node.value = spec.value;
      const read = node.value;
      value = read === spec.value ? "ok" : `wrote ${JSON.stringify(spec.value)}, read ${JSON.stringify(read)}`;
    } catch (err) {
      value = `threw: ${(err && err.message) || err}`;
    }
  }
  return {
    name: spec.name, def, ctor,
    w: Math.round(box.width), h: Math.round(box.height), shadow, value,
  };
}

/** @returns {string} a report for the console; never throws. */
function report() {
  let host = null;
  try {
    // Off-screen rather than hidden: display:none would measure 0 for
    // everything and prove nothing. Laid out, just not where anyone sees it.
    host = document.createElement("div");
    host.style.position = "absolute";
    host.style.left = "-10000px";
    host.style.top = "0";
    host.style.width = "320px";
    document.body.appendChild(host);

    const lines = CANDIDATES.map((spec) => {
      let row;
      try {
        row = measure(host, spec);
      } catch (err) {
        row = {
          name: spec.name, def: "?", ctor: "-", w: 0, h: 0, shadow: "-",
          value: `build threw: ${(err && err.message) || err}`,
        };
      }
      // An unregistered custom element constructs as a plain HTMLElement; that
      // is the tell when there is no registry to ask.
      const missing = row.def === "NO" || (row.def === "?" && row.ctor === "HTMLElement");
      return `  ${row.name.padEnd(24)} def ${row.def.padEnd(4)} ${row.ctor.padEnd(20)}` +
        ` ${`${row.w}x${row.h}`.padEnd(9)} shadow ${row.shadow.padEnd(12)} value ${row.value}` +
        (missing ? "   <- NOT IMPLEMENTED" : "");
    });
    const reg = registry() ? "present" : "ABSENT (falling back to constructor names)";
    return `[typst] Spectrum widget probe · customElements ${reg}\n${lines.join("\n")}`;
  } catch (err) {
    return `[typst] widget probe failed: ${(err && err.message) || err}`;
  } finally {
    if (host && host.remove) host.remove();
  }
}

module.exports = { report };
