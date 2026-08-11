/**
 * Typst source construction.
 *
 * Two sources are built from the same header so that the metrics we report and
 * the artwork we place describe exactly the same layout:
 *
 *   metrics source -> `query` -> { w, h, d }
 *   render source  -> `svg` / `pdf` -> the artwork
 *
 * Getting `d` (the depth: baseline to the bottom edge of the box) is the whole
 * game, because InDesign puts the *bottom of the frame* on the text baseline and
 * has no idea where the maths baseline sits inside the artwork.
 *
 * Typst has no "give me the baseline" API, and two plausible routes are wrong:
 *
 *   - `here().position()` on an inline marker reports the line-box bottom, not
 *     the baseline.
 *   - `measure()` with `bottom-edge: "baseline"` silently clamps at the font's
 *     descender, so anything deeper (integrals, matrices, cases) comes back
 *     short — by 7.7pt for `cases(..)` at 40pt.
 *
 * What does work: force a descent far deeper than any real content with a
 * zero-size strut, which exposes the ascent, and subtract.
 *
 *     height(body + strut(D)) = ascent + D
 *     height(body)            = ascent + depth
 *     => depth = height(body) - height(body + strut(D)) + D
 *
 * Verified against pixel measurements of rendered output to within 0.04pt at
 * 40pt type; see tools/validate-template.py.
 */

/** Deeper than any plausible expression, so the strut always wins. */
const STRUT_PT = 1000;

/** `top-edge`/`bottom-edge` must be "bounds": Typst's default bottom edge is the
 *  baseline, which makes an auto-height page clip every descender. */
const EDGES = 'top-edge: "bounds", bottom-edge: "bounds"';

/**
 * Strip one layer of `$...$` so pasting `$x^2$` from a Typst document works as
 * well as typing `x^2`. Left alone if the inside contains its own delimiters.
 */
function normalizeBody(raw) {
  const t = String(raw == null ? "" : raw).trim();
  if (t.length >= 2 && t.startsWith("$") && t.endsWith("$")) {
    const inner = t.slice(1, -1);
    if (!/(?<!\\)\$/.test(inner)) return inner.trim();
  }
  return t;
}

/** Typst colour literal from a colour descriptor read off the InDesign swatch. */
function colorLiteral(color) {
  if (!color) return 'rgb("#000000")';
  if (color.space === "CMYK") {
    const [c, m, y, k] = color.values;
    return `cmyk(${+c}%, ${+m}%, ${+y}%, ${+k}%)`;
  }
  if (color.space === "GRAY") return `luma(${Math.round((color.values[0] / 100) * 255)})`;
  const [r, g, b] = color.values;
  const hex = [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v)))
    .toString(16).padStart(2, "0")).join("");
  return `rgb("#${hex}")`;
}

/**
 * Build the single source that yields both the metrics and the artwork.
 *
 * The metadata element is emitted inline, in the same paragraph as the body, so
 * it contributes no layout of its own — verified: the rendered page box is
 * byte-identical with and without it. That means one compile can produce
 * metrics, vector and PDF for exactly the layout being measured.
 *
 * @param {{body: string, mode?: 'inline'|'display', size?: number,
 *          color?: object, preamble?: string}} spec
 * @returns {{source: string, body: string, bodyLine: number, bodyColumn: number,
 *            preambleLine: number, preambleLines: number}}
 *          Line/column fields are 0-indexed, matching Typst diagnostics, and
 *          let the panel map an error back onto what the user actually typed.
 */
export function buildSource(spec) {
  const body = normalizeBody(spec.body);
  const mode = spec.mode === "display" ? "display" : "inline";
  const size = Number(spec.size) > 0 ? Number(spec.size) : 10;
  const preamble = (spec.preamble || "").trim();

  // A display equation is a block, so an inline strut after it would land on a
  // new line and the arithmetic would measure the wrong thing. Boxing it keeps
  // it inline-measurable and yields depth 0, which is correct for a block.
  const expr = mode === "display" ? `box($ ${body} $)` : `$${body}$`;
  const prefix = "#let __idt = ";

  const lines = [
    "#set page(width: auto, height: auto, margin: 0pt, fill: none)",
    `#set text(size: ${size}pt, fill: ${colorLiteral(spec.color)}, ${EDGES})`,
  ];
  const preambleLine = lines.length;
  const preambleLines = preamble ? preamble.split("\n").length : 0;
  if (preamble) lines.push(preamble);

  const bodyLine = lines.length;
  lines.push(prefix + expr);
  lines.push(
    "#context [#metadata((" +
    "w: measure(__idt).width.pt(), " +
    "h: measure(__idt).height.pt(), " +
    "d: (measure(__idt).height" +
    ` - measure([#__idt#box(width: 0pt, height: 0pt, baseline: ${STRUT_PT}pt)]).height` +
    ` + ${STRUT_PT}pt).pt()` +
    ")) <idt-metrics>]#__idt",
  );

  return {
    source: lines.join("\n") + "\n",
    body,
    bodyLine,
    // Where the user's first character lands: after `#let __idt = ` plus the
    // opening delimiter (`$`, or `box($ ` in display mode).
    bodyColumn: prefix.length + (mode === "display" ? "box($ ".length : 1),
    preambleLine,
    preambleLines,
  };
}
