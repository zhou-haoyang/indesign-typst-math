/**
 * Rendering backends.
 *
 * A backend turns an expression into something placeable plus the numbers the
 * InDesign layer needs to position it. Typst is the only one today; MathJax and
 * a LaTeX pipeline are the expected next ones, which is why the contract talks
 * about a generic `asset` rather than "the PDF": MathJax produces SVG and no
 * PDF at all.
 *
 * A backend module exports:
 *
 *   {
 *     id:    "typst",
 *     label: "Typst",
 *     assetFormat: "pdf" | "svg",
 *     supportsPreamble: boolean,
 *     supportsFonts: boolean,
 *     ready(): Promise<{engine: string}>,
 *     render(spec, {pdf}): Promise<RenderResult>,
 *     setFonts(fonts): Promise<number>,
 *   }
 *
 * `spec` is { body, mode: "inline"|"display", size, color, preamble }.
 *
 * RenderResult is
 *   {
 *     ok: boolean,
 *     metrics: { width, height, depth },   // points; depth = baseline to bottom edge
 *     asset:   { format, bytes } | null,   // only when asked for
 *     diagnostics: [{ severity, message, line?, column?, where? }],
 *   }
 *
 * `depth` is the one number InDesign cannot work out for itself: it anchors the
 * bottom edge of the frame to the text baseline and has no idea where the maths
 * baseline sits inside the artwork.
 */

/** Adding a backend means adding a line here and writing the module. */
const BACKENDS = {
  typst: "./typst-wasm",
};

function get(id) {
  const path = BACKENDS[id];
  if (!path) throw new Error(`unknown rendering backend: ${id}`);
  return require(path);
}

module.exports = { get };
