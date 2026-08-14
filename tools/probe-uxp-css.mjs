#!/usr/bin/env node
/**
 * Ask the host whether it implements a CSS property, from this shell.
 *
 * UXP's CSS parser silently drops what it does not implement, so a declaration
 * having no effect in the panel says nothing about whether the *value* was
 * wrong — and guessing at that is what turned one editor-caret bug into four
 * rounds of confident wrong explanations. This answers the prior question in a
 * couple of seconds.
 *
 *   node tools/probe-uxp-css.mjs
 *   node tools/probe-uxp-css.mjs position:sticky "transition:all .2s"
 *
 * How it works: a UXP script has a document of its own — *not* the panel's, but
 * the same CSS engine — so it can set a declaration and read it back. A kept
 * property round-trips through `element.style`; a dropped one reads back
 * `undefined` there and `""` from `getComputedStyle`. Both routes are reported,
 * inline and through a real stylesheet, because the panel's CSS arrives the
 * second way.
 *
 * Two properties this host is known to drop ride along as controls. If either
 * is ever reported as kept, the technique has stopped working and the rest of
 * the report is worthless — that is the check the two failed probes of the
 * sp-* widgets did not have.
 *
 * What it cannot tell you: whether the property does anything useful once it is
 * kept. `getBoundingClientRect` is 0x0 in this context, so layout still has to
 * be judged by eye — tools/shoot-indesign.mjs.
 */
import { runUxp } from "./uxp.mjs";

/** Known dropped, so a probe that reports them kept is broken, not informative. */
const CONTROLS = ["gap:4px", "caret-color:red"];

/** What the panel currently leans on, absent an argument. */
const DEFAULTS = [
  "position:absolute", "top:0px", "left:-20000px", "opacity:0", "z-index:1",
  "display:block", "width:100%", "height:100%", "overflow:hidden",
  "flex:2 1 0", "min-height:60px",
];

const asked = process.argv.slice(2);
const pairs = (asked.length ? asked : DEFAULTS).concat(CONTROLS).map((text) => {
  const at = text.indexOf(":");
  if (at < 1) throw new Error(`not a property:value pair: ${text}`);
  return [text.slice(0, at).trim(), text.slice(at + 1).trim()];
});

const source = `
const want = ${JSON.stringify(pairs)};
const out = { inline: {}, sheet: {} };
try {
  const probe = document.createElement("div");
  for (const [key, value] of want) {
    probe.style.setProperty(key, value);
    out.inline[key] = String(probe.style.getPropertyValue(key));
  }
  document.body.appendChild(probe);

  // The panel's CSS arrives as a stylesheet, so ask that way too. An id
  // selector, and the inline styles dropped, so the two routes cannot be
  // confused with each other.
  const style = document.createElement("style");
  style.textContent = "#uxp-css-probe {" +
    want.map(([key, value]) => key + ": " + value + ";").join(" ") + "}";
  document.head.appendChild(style);
  probe.id = "uxp-css-probe";
  probe.removeAttribute("style");
  const computed = getComputedStyle(probe);
  for (const [key] of want) out.sheet[key] = String(computed.getPropertyValue(key));

  document.body.removeChild(probe);
  document.head.removeChild(style);
} catch (e) {
  out.error = String((e && e.message) || e);
}
require("uxp").script.setResult(JSON.stringify(out));
`;

const result = await runUxp(source, ".css-probe");
if (!result || result.error) {
  console.error(`probe failed: ${(result && result.error) || "no result"}`);
  process.exit(1);
}

const kept = (key) => result.inline[key] !== "undefined" || !!result.sheet[key];
let broken = false;
for (const [key, value] of pairs) {
  const control = CONTROLS.some((text) => text.startsWith(`${key}:`));
  const ok = kept(key);
  if (control && ok) broken = true;
  const mark = control ? (ok ? "BROKEN " : "control") : (ok ? "kept   " : "dropped");
  console.log(`  ${mark}  ${key}: ${value}`
    + `${ok ? `  ->  style ${JSON.stringify(result.inline[key])}, sheet ${JSON.stringify(result.sheet[key])}` : ""}`);
}

console.log(broken
  ? "\nA control property was reported kept: this probe is lying. Ignore the rest."
  : "\nKept means the parser keeps it, not that it lays out — judge that by eye.");
process.exit(broken ? 1 : 0);
