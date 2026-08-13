/**
 * Finding the equation the user means, and noticing when it changes.
 *
 * The search rule here is subtle enough to be worth stating: an equation is
 * found inside a *text* selection, but not inside a selected page item.
 * Selecting the anchor character in the text is a natural way to reach for an
 * inline equation, so looking one level in is right; selecting a whole text
 * frame is not a request to edit whichever equation happens to live in it.
 *
 * `readRecord` is injected so the whole thing can be exercised without
 * InDesign — the distinction above is exactly the kind of rule that is easy to
 * invert in a refactor and impossible to notice by eye.
 */
const { tryGet } = require("../id/doc");

/**
 * A cheap value that changes whenever the selection does.
 *
 * Compared as a string rather than by identity because two reads of the same
 * page item hand back different JS proxies.
 */
function signatureOf(selection) {
  const items = selection || [];
  if (!items.length) return "none";
  const first = items[0];
  return `${items.length}:${tryGet(() => first.id, "")}:${tryGet(() => first.index, "")}`;
}

/**
 * The first labelled equation in `selection`, or null.
 *
 * @param {(item: object) => object|null} readRecord
 * @returns {{frame: object, record: object}|null}
 */
function findEquation(selection, readRecord) {
  for (const item of selection || []) {
    const record = readRecord(item);
    if (record) return { frame: item, record };

    // A page item has bounds; a text selection does not. Only the latter is
    // searched — see the note at the top.
    if (tryGet(() => item.geometricBounds, null) != null) continue;

    const nested = tryGet(() => item.pageItems, null);
    const count = nested ? tryGet(() => nested.length, 0) : 0;
    for (let i = 0; i < count; i++) {
      const inner = nested.item(i);
      const innerRecord = readRecord(inner);
      if (innerRecord) return { frame: inner, record: innerRecord };
    }
  }
  return null;
}

/**
 * Whether a newly found equation is the one already being edited.
 *
 * By document id, not object identity, for the proxy reason above. A null id on
 * either side means "cannot tell", which has to count as different — treating
 * it as the same would strand the panel on a frame that no longer exists.
 */
function isSameEquation(editing, frame) {
  if (!editing) return false;
  const id = tryGet(() => frame.id, null);
  return id != null && editing.id === id;
}

module.exports = { signatureOf, findEquation, isSameEquation };
