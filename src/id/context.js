/**
 * Reading the typographic context an equation is being dropped into.
 *
 * InDesign will not scale or recolour a placed graphic, so point size and
 * colour have to be baked into the render. That means reading them off the text
 * at the insertion point and handing them to Typst.
 */
const idsn = require("indesign");
const { app } = idsn;
const { tryGet } = require("./doc");

const BLACK = { space: "CMYK", values: [0, 0, 0, 100] };

/**
 * Turn an InDesign swatch into something the Typst template can express.
 *
 * CMYK values pass straight through, because Typst's PDF export keeps CMYK and
 * separations should survive. Spot colours fall back to their alternate space,
 * which is what InDesign would print anyway for a composite proof — flagged so
 * the panel can say so.
 */
function swatchToColor(swatch) {
  if (!swatch || !tryGet(() => swatch.isValid, false)) return { color: BLACK, note: null };

  const name = tryGet(() => swatch.name, "");
  if (name === "None" || name === "Paper" || name === "Registration") {
    return { color: BLACK, note: `Text colour is "${name}"; rendering in black.` };
  }

  const values = tryGet(() => swatch.colorValue, null);
  if (!values || !values.length) {
    // Gradients and mixed-ink parents have no plain colour value.
    return { color: BLACK, note: "Text colour is not a flat colour; rendering in black." };
  }

  const space = tryGet(() => swatch.space, null);
  let note = null;
  if (tryGet(() => swatch.model, null) === idsn.ColorModel.SPOT) {
    note = `Spot colour "${name}" rendered as its alternate values.`;
  }

  if (space === idsn.ColorSpace.CMYK) {
    return { color: { space: "CMYK", values: values.slice(0, 4).map(Number) }, note };
  }
  if (space === idsn.ColorSpace.RGB) {
    return { color: { space: "RGB", values: values.slice(0, 3).map(Number) }, note };
  }
  if (space === idsn.ColorSpace.LAB) {
    return { color: labToRgb(values), note: note || "Lab colour converted to RGB." };
  }
  return { color: BLACK, note: "Unsupported colour space; rendering in black." };
}

/** Lab to sRGB, good enough for on-screen maths that would otherwise be black. */
function labToRgb([l, a, bb]) {
  const fy = (Number(l) + 16) / 116;
  const fx = fy + Number(a) / 500;
  const fz = fy - Number(bb) / 200;
  const inv = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const [x, y, z] = [0.95047 * inv(fx), 1 * inv(fy), 1.08883 * inv(fz)];
  const lin = [
    3.2406 * x - 1.5372 * y - 0.4986 * z,
    -0.9689 * x + 1.8758 * y + 0.0415 * z,
    0.0557 * x - 0.204 * y + 1.057 * z,
  ];
  const enc = (c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  return { space: "RGB", values: lin.map(enc) };
}

/**
 * Point size and colour at an insertion point.
 * @returns {{size: number|null, color: object, notes: string[]}}
 */
function readAt(insertionPoint) {
  const notes = [];
  let size = tryGet(() => insertionPoint.pointSize, null);
  if (typeof size !== "number" || !(size > 0)) {
    // Mixed formatting across the range, or a place InDesign will not answer for.
    size = null;
  }
  const { color, note } = swatchToColor(tryGet(() => insertionPoint.fillColor, null));
  if (note) notes.push(note);
  return { size, color, notes };
}

/**
 * The current selection, classified for insertion purposes.
 *
 * @returns {{kind: "text"|"frame"|"page", insertionPoint?: object, frame?: object}}
 */
function currentTarget() {
  const selection = tryGet(() => app.selection, []) || [];
  if (!selection.length) {
    return { kind: "page", why: "nothing selected in the document" };
  }
  if (selection.length > 1) {
    return { kind: "page", why: `${selection.length} objects selected` };
  }

  const sel = selection[0];
  const name = tryGet(() => sel.constructor.name, "unknown");
  // A selected text *frame* also exposes insertionPoints, but selecting a frame
  // with the Selection tool is not text editing — inserting there would
  // silently jump to the start of the story. Page items have geometric bounds;
  // text ranges and insertion points do not.
  const isPageItem = tryGet(() => sel.geometricBounds, null) != null;
  if (isPageItem) {
    return { kind: "frame", frame: sel, why: `${name} selected as an object` };
  }

  const ips = tryGet(() => sel.insertionPoints, null);
  if (ips && tryGet(() => ips.length, 0) > 0) {
    return { kind: "text", insertionPoint: ips.item(0), why: `text cursor in ${name}` };
  }
  if (tryGet(() => sel.parentStory, null)) {
    return { kind: "text", insertionPoint: sel, why: `text cursor (${name})` };
  }
  return { kind: "page", why: `${name} is neither text nor a page item` };
}

/** The insertion point an anchored frame hangs from, if it is anchored at all. */
function anchorInsertionPoint(frame) {
  const offset = tryGet(() => frame.storyOffset, null);
  if (!offset || !tryGet(() => offset.isValid, false)) return null;
  return offset;
}

module.exports = { readAt, currentTarget, anchorInsertionPoint, BLACK };
