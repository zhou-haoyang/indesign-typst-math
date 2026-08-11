/**
 * Making an equation frame invisible.
 *
 * A frame created by `place()` inherits the document's *current default* object
 * attributes, which routinely include a stroke and a corner radius. Worse, an
 * object style added with `objectStyles.add()` captures those same defaults, so
 * applying a plugin-owned style stamps them onto every equation — that is where
 * the 1pt black stroke and 1p0 corner came from.
 *
 * So: no object style. The frame is detached from any style and every attribute
 * that could draw a box is set explicitly, then read back, because these
 * properties can refuse an assignment without throwing.
 */
const idsn = require("indesign");
const { tryGet } = require("./doc");

const CORNERS = ["topLeft", "topRight", "bottomLeft", "bottomRight"];

/** Assign one property, reporting rather than hiding failure. */
function set(target, property, value, failures) {
  try {
    target[property] = value;
    return true;
  } catch (err) {
    failures.push(`${property}: ${(err && err.message) || err}`);
    return false;
  }
}

/**
 * The "None" swatch. If this comes back unusable, assigning it throws, and a
 * swallowed throw is what leaves a visible stroke around every equation.
 */
function noneSwatch(doc) {
  const byName = tryGet(() => doc.swatches.itemByName("None"), null);
  if (byName && tryGet(() => byName.isValid, false)) return byName;
  const swatches = tryGet(() => doc.swatches, null);
  const count = swatches ? tryGet(() => swatches.length, 0) : 0;
  for (let i = 0; i < count; i++) {
    const swatch = swatches.item(i);
    if (tryGet(() => swatch.name, "") === "None") return swatch;
  }
  return null;
}

/** The built-in `[None]` object style, used to detach rather than to stamp. */
function noneObjectStyle(doc) {
  for (const name of ["[None]", "$ID/[None]", "None"]) {
    const style = tryGet(() => doc.objectStyles.itemByName(name), null);
    if (style && tryGet(() => style.isValid, false)) return style;
  }
  return tryGet(() => doc.objectStyles.item(0), null);
}

/**
 * Strip fill, stroke and corner effects from one object.
 *
 * The stroke is not merely cosmetic: InDesign anchors the *stroke-inclusive*
 * bottom edge to the text baseline, so any weight shifts an equation by half of
 * it — even when the stroke colour is None and nothing is visible.
 *
 * And it must be cleared in the right order, which is not the obvious one.
 * Measured against a live InDesign (tools/probe-indesign.mjs):
 *
 *     as placed             weight 0, colour None
 *     strokeWeight = 0      weight 1          <- assigning zero *creates* a stroke
 *     then strokeColor=None weight 0, colour None
 *
 * Assigning a weight is taken as "this object has a stroke" and InDesign
 * substitutes the default weight. Setting the colour afterwards normalises it
 * back. So: touch the stroke only if it is actually dirty, and always finish
 * with the colour.
 */
function stripOne(doc, target, kind, failures) {
  const none = noneSwatch(doc);
  if (none) set(target, "fillColor", none, failures);

  const weight = tryGet(() => target.strokeWeight, 0);
  const colour = tryGet(() => target.strokeColor.name, "");
  const dirty = weight > 0 || (colour !== "None" && colour !== "");
  if (dirty) {
    set(target, "strokeWeight", 0, failures);
    // Last, and deliberately so: this is what settles the weight back to zero.
    if (none) set(target, "strokeColor", none, failures);
    else set(target, "strokeColor", "None", failures);
  }

  // Corner effects are inherited from the document defaults just like the
  // stroke is, and a rounded rectangle reads as a border even at zero weight.
  // The enum is resolved defensively: evaluating it inline would throw *outside*
  // set()'s try and abort the whole clean-up.
  const cornerNone = tryGet(() => idsn.CornerOptions.NONE, null);
  for (const corner of CORNERS) {
    if (tryGet(() => target[`${corner}CornerOption`], undefined) === undefined) continue;
    if (cornerNone !== null) set(target, `${corner}CornerOption`, cornerNone, failures);
    set(target, `${corner}CornerRadius`, 0, failures);
  }

  // Last resort: the bulk setter applies weight and colour together, which also
  // avoids the "assigning a weight implies a stroke" behaviour above.
  if (tryGet(() => target.strokeWeight, 0) > 0) {
    const bulk = { strokeWeight: 0 };
    if (none) bulk.strokeColor = none;
    set(target, "properties", bulk, failures);
    const still = tryGet(() => target.strokeWeight, "?");
    if (still > 0) {
      // Worth naming loudly: a residual stroke misaligns the equation by half
      // its weight, not just draws a box.
      failures.push(`${kind} stroke weight is still ${still} (shifts baseline by ${still / 2}pt)`);
    }
  }
}

/**
 * Detach from any object style and remove everything that could draw a box,
 * on the frame and on the graphic inside it.
 *
 * @returns {string[]} descriptions of whatever could not be applied
 */
/**
 * @param {boolean} detachStyle Applying an object style resets everything the
 *   style governs — including anchored-object settings, which is how a second
 *   pass silently wipes a computed baseline offset. Only the first pass detaches.
 */
function neutralize(doc, frame, detachStyle = true) {
  const failures = [];
  if (!noneSwatch(doc)) failures.push("no None swatch in this document");

  if (detachStyle) {
    const plain = noneObjectStyle(doc);
    if (plain) set(frame, "appliedObjectStyle", plain, failures);
  }

  stripOne(doc, frame, "frame", failures);

  const graphics = tryGet(() => frame.allGraphics, null) || [];
  for (let i = 0; i < graphics.length; i++) {
    stripOne(doc, graphics[i], "graphic", failures);
  }
  return failures;
}

/**
 * Everything that could be drawing a box, as one line.
 *
 * Reported from a read-back rather than from what was set, because several
 * objects contribute and only one is usually the culprit.
 */
function describeChrome(frame) {
  const name = (value) => tryGet(() => value.name, "?");
  const parts = [
    `frame stroke ${tryGet(() => frame.strokeWeight, "?")}pt ` +
      `${name(tryGet(() => frame.strokeColor, null))}`,
    `fill ${name(tryGet(() => frame.fillColor, null))}`,
    `corner ${tryGet(() => frame.topLeftCornerRadius, "?")}`,
    `style "${name(tryGet(() => frame.appliedObjectStyle, null))}"`,
  ];
  const graphics = tryGet(() => frame.allGraphics, null) || [];
  for (let i = 0; i < graphics.length; i++) {
    parts.push(`graphic${i} stroke ${tryGet(() => graphics[i].strokeWeight, "?")}pt`);
  }
  return parts.join(", ");
}

module.exports = { neutralize, describeChrome };
