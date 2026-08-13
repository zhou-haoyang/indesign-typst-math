/**
 * Resolve a handful of Spectrum design tokens into literal colours.
 *
 * The panel needs about six values that differ between the light and dark
 * themes. Shipping @spectrum-css/tokens whole would mean 210 KB of `var()`
 * chains for them, and would hand UXP's CSS parser the form
 * `rgba(var(--spectrum-gray-400-rgb))` — a three-argument rgba() that Chromium
 * accepts and UXP may not. Since UXP drops what it cannot parse *silently*, a
 * refusal there would look like a mistake in this stylesheet rather than an
 * unsupported value.
 *
 * So the chains are resolved here, at `npm run setup`, and the panel only ever
 * sees `rgb(2, 101, 220)`.
 *
 * Pinned to tokens 15.2.0 on purpose, and to its `spectrum/` overlay rather
 * than `express/`:
 *
 *   - 16.x is Spectrum 2 — its accent resolves to indigo rgb(59, 99, 251) and
 *     its corner radius to 8px. InDesign 21.4's own widgets are Spectrum 1, so
 *     those would visibly disagree with the sp-* controls beside them.
 *   - 15.2.0 is the last Spectrum 1 major. Its radius resolves to 4px, which is
 *     the value that was already hand-picked in panel.css — good evidence that
 *     the host is Spectrum 1 and that these are the right ramps.
 *   - The `spectrum/` overlay is where --spectrum-accent-color-900 is bound to
 *     blue; under `express/` it is indigo.
 *
 * Everything here throws rather than guesses. A silent partial write would ship
 * a stylesheet missing half its custom properties, and the panel would fall
 * back to inherited colours in a way that reads as a CSS bug rather than a
 * build one — and the package's file layout has genuinely moved between majors
 * (13.x/14.x flat under dist/css, 15.x with the theme bindings in
 * dist/css/spectrum, 16.x dropping darkest-vars.css altogether), so an
 * unattended bump is exactly the case that has to fail loudly.
 */

/** The alias the panel uses -> the Spectrum token it comes from. */
export const TOKENS = {
  "--ui-text": "--spectrum-neutral-content-color-default",
  "--ui-muted": "--spectrum-neutral-subdued-content-color-default",
  "--ui-border": "--spectrum-gray-400",
  "--ui-error": "--spectrum-negative-content-color-default",
  "--ui-accent": "--spectrum-accent-content-color-default",
  "--ui-radius": "--spectrum-corner-radius-100",
};

/**
 * InDesign reports five themes; `currentTheme()` in the panel collapses them to
 * these two. 15.2.0 also ships darkest-vars.css if that ever proves too coarse.
 */
export const THEMES = ["light", "dark"];

/**
 * Files to consult for one theme, least specific first — later wins.
 *
 * The base files carry the ramps; the `spectrum/` overlay carries the bindings
 * that make this the Spectrum theme rather than Express.
 */
export function layerPaths(theme) {
  return [
    "global-vars.css", "spectrum/global-vars.css",
    "medium-vars.css", "spectrum/medium-vars.css",
    `${theme}-vars.css`, `spectrum/${theme}-vars.css`,
  ];
}

/**
 * Pull `--name: value;` pairs out of a stylesheet.
 *
 * Deliberately not a CSS parser: every one of these files is a single flat rule
 * (`.spectrum--light { ... }`), so there is nothing to nest and no cascade to
 * model beyond the file order above.
 */
export function parseDeclarations(css) {
  const map = new Map();
  for (const [, name, value] of (css || "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(name, value.trim());
  }
  return map;
}

const VAR_CALL = /(rgba?)\(\s*var\((--[\w-]+)\)\s*(?:,\s*([^)]+?)\s*)?\)|var\((--[\w-]+)\)/g;

/**
 * @param {Array<Map<string, string>>} layers  least specific first
 * @returns {(name: string) => string} fully resolved value, no `var()` left
 */
export function makeResolver(layers) {
  const lookup = (name) => {
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i].has(name)) return layers[i].get(name);
    }
    return undefined;
  };

  return function resolve(name, seen = new Set()) {
    // Guards against a definition that refers to itself through any number of
    // hops. Without it a malformed token file hangs `npm run setup` instead of
    // reporting anything.
    if (seen.has(name)) {
      throw new Error(`cycle resolving ${name} (via ${[...seen].join(" -> ")})`);
    }
    const raw = lookup(name);
    if (raw === undefined) throw new Error(`unknown token ${name}`);
    const next = new Set(seen).add(name);

    return raw.replace(VAR_CALL, (_, fn, packed, alpha, bare) => {
      // `rgba(var(--x-rgb))` and `rgba(var(--x-rgb), .06)`: the var holds the
      // channels, so it has to be expanded *inside* the colour function rather
      // than substituted as a whole value.
      if (packed) {
        const channels = resolve(packed, next);
        return alpha ? `rgba(${channels}, ${alpha})` : `rgb(${channels})`;
      }
      return resolve(bare, next);
    }).trim();
  };
}

/**
 * @param {(path: string) => string | null} read  relative to the tokens css/
 *   directory; returns null for a file that is not there. Injected so this is
 *   testable without a filesystem.
 * @returns {string} the stylesheet to write to vendor/
 */
export function buildThemeCss(read, { version = "unknown", tokens = TOKENS, themes = THEMES } = {}) {
  const lines = [
    "/* Generated by scripts/spectrum-theme.mjs — do not edit.",
    ` * Resolved from @spectrum-css/tokens ${version}, spectrum theme, medium scale.`,
    " * Regenerate with `npm run setup`. See that script for why the values are",
    " * baked in rather than the token stylesheet being shipped whole.",
    " */",
  ];

  for (const theme of themes) {
    const paths = layerPaths(theme);
    const layers = paths.map((p) => parseDeclarations(read(p)));
    if (layers.every((layer) => layer.size === 0)) {
      throw new Error(`no token declarations found for "${theme}" in: ${paths.join(", ")}`);
    }
    const resolve = makeResolver(layers);

    lines.push("", `.spectrum--${theme} {`);
    for (const [alias, token] of Object.entries(tokens)) {
      lines.push(`  ${alias}: ${resolve(token)};`.padEnd(38) + `/* ${token} */`);
    }
    lines.push("}");
  }

  return lines.join("\n") + "\n";
}
