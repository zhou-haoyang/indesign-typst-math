/**
 * Rendering backend registry.
 *
 * A backend turns an expression into something placeable plus the numbers the
 * InDesign layer needs to position it. Typst is the only one today; MathJax and
 * a LaTeX pipeline are the expected next ones, which is why the contract talks
 * about a generic `asset` rather than "the PDF": MathJax produces SVG and no
 * PDF at all.
 *
 * A backend is an object:
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

const backends = new Map();

function register(backend) {
  backends.set(backend.id, backend);
  return backend;
}

function get(id) {
  const backend = backends.get(id);
  if (!backend) throw new Error(`unknown rendering backend: ${id}`);
  return backend;
}

function list() {
  return [...backends.values()];
}

module.exports = { register, get, list };
