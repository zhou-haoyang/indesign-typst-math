#!/usr/bin/env node
/**
 * Unit checks for theme resolution.
 *
 * This is the table that would have caught the bug it replaces. Every way of
 * asking the host was measured dead in InDesign 21.4.1.4 — `uxp.host.theme` is
 * undefined, `matchMedia` does not exist, and `getComputedStyle` returns
 * "initial" for anything not explicitly set — so the old `currentTheme()`
 * resolved to "light" every time and the panel served the light palette on a
 * dark host. Nothing threw. It just looked like a badly chosen grey.
 *
 * The boundary cases matter more than they look: InDesign's four Color Theme
 * presets are 0, 0.5, 0.51 and 1, so dark and light are one hundredth apart.
 *
 *   node tools/test-theme.mjs
 */
import Module from "node:module";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* Stub the host modules before the module under test loads, the same way
   tools/test-prefs.mjs does. `uxp` is stubbed to match what InDesign really
   returns — an object with no theme — rather than to something convenient. */
let brightness = 0.5;
let hostThemeValue;           // undefined, as measured
let brightnessThrows = false;

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "indesign") {
    return {
      app: {
        generalPreferences: {
          get uiBrightnessPreference() {
            if (brightnessThrows) throw new Error("no such property");
            return brightness;
          },
        },
      },
    };
  }
  if (request === "uxp") return { host: { get theme() { return hostThemeValue; } } };
  return load.call(this, request, ...rest);
};

/* A DOM stub sufficient for apply(): it only ever sets document.body.className. */
globalThis.document = { body: { className: "" } };
const logged = [];
globalThis.console = { ...console, log: (line) => logged.push(String(line)) };

const require = createRequire(import.meta.url);
const theme = require(join(root, "src/ui/theme.js"));

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  process.stdout.write(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(52)}${ok ? "\n" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}\n`}`);
}

/* ------------------------------------------------------------- brightness */

// The four real presets, and the hundredth that separates them.
const PRESETS = [[0, "dark"], [0.5, "dark"], [0.51, "light"], [1, "light"]];
for (const [value, want] of PRESETS) {
  brightness = value;
  check(`uiBrightness ${value} -> ${want}`, theme.resolve(), want);
}

// The boundary is not the midpoint of the range, and this is the assertion that
// stops anyone "tidying" the constant to 0.75.
check("the threshold sits at 0.5, not 0.75", theme.DARK_AT_OR_BELOW, 0.5);
brightness = 0.75;
check("0.75 would be light, had it not snapped to 0.51", theme.resolve(), "light");

/* --------------------------------------------------------- host.theme tier */

brightness = 1;                              // would say light on its own
hostThemeValue = "dark";
check("a host that names a theme wins over brightness", theme.resolve(), "dark");
hostThemeValue = "MEDIUM";
check("host theme matches case-insensitively", theme.resolve(), "dark");
hostThemeValue = "lightest";
brightness = 0;
check("host \"lightest\" beats a dark brightness", theme.resolve(), "light");

// The old bug in one line: String(undefined) is "undefined", which matches
// neither /dark/ nor /light/. Falling through must be the outcome, not "light".
hostThemeValue = undefined;
brightness = 0;
check("undefined host theme falls through, not to light", theme.resolve(), "dark");
hostThemeValue = "";
check("empty host theme falls through", theme.resolve(), "dark");
hostThemeValue = "some-future-name";
check("an unrecognised host theme falls through", theme.resolve(), "dark");
hostThemeValue = undefined;

/* ----------------------------------------------------------- last resort */

brightnessThrows = true;
check("dark when nothing can be read at all", theme.resolve(), "dark");
brightnessThrows = false;
brightness = NaN;
check("dark when the preference is not a number", theme.resolve(), "dark");
brightness = 0.5;

/* ---------------------------------------------------------------- apply */

theme.reset();
logged.length = 0;
check("apply reports a change the first time", theme.apply("dark"), true);
check("apply stamps every class the palette needs",
  document.body.className, "spectrum spectrum--medium spectrum--dark theme-dark");
check("apply is change-gated, so polling is free", theme.apply("dark"), false);
check("apply reports a real change", theme.apply("light"), true);
check("apply swaps the classes rather than adding",
  document.body.className, "spectrum spectrum--medium spectrum--light theme-light");

// The webview must not be messaged on the initial paint (it is told separately,
// once the backend is up) nor on every poll tick — only on a real change.
theme.reset();
const told = [];
theme.apply("dark", (t) => told.push(t));
check("no callback on the first apply", told, []);
theme.apply("dark", (t) => told.push(t));
check("no callback when nothing changed", told, []);
theme.apply("light", (t) => told.push(t));
check("callback on a real change", told, ["light"]);

check("logs the raw reads, not just the verdict",
  logged.some((line) => line.includes("[typst] theme:") && line.includes("uiBrightness")), true);

/* --------------------------------------------------------------- classes */

check("light classes", theme.classesFor("light"),
  "spectrum spectrum--medium spectrum--light theme-light");

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
