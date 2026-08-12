/**
 * Persistence.
 *
 * What makes an inserted equation editable is a JSON record stored on the frame
 * with `insertLabel`. It survives saving, closing, reopening, and copy/paste, so
 * a duplicated equation stays editable too. Nothing about the equation is
 * recoverable from the artwork alone, so this record is the source of truth.
 */
const { tryGet } = require("./doc");

const LABEL_KEY = "indesign-typst";
const DOC_PREAMBLE_KEY = "indesign-typst:preamble";
const RECORD_VERSION = 1;

/** @returns {object|null} the record on this page item, if it is one of ours. */
function readRecord(item) {
  const raw = tryGet(() => item.extractLabel(LABEL_KEY), "");
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    return record && record.v ? record : null;
  } catch {
    return null;
  }
}

function writeRecord(item, record) {
  item.insertLabel(LABEL_KEY, JSON.stringify(record));
}

/**
 * Build the record for a freshly rendered equation.
 *
 * `size.mode` and `color.mode` are what let "re-render all" behave like a sync:
 * an `auto` equation re-reads its point size and colour from the text it sits
 * in, a `fixed` one keeps what it was given.
 */
function makeRecord({ body, mode, size, color, preamble, metrics, engine }) {
  return {
    v: RECORD_VERSION,
    backend: "typst",
    body,
    mode,
    size,
    color,
    preambleHash: hash(preamble || ""),
    metrics: metrics && {
      w: round(metrics.width),
      h: round(metrics.height),
      depth: round(metrics.depth),
    },
    engine,
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/** Cheap non-cryptographic hash, only used to spot a stale preamble. */
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * The document's preamble, and whether the document has one *at all*.
 *
 * The distinction matters because the panel seeds a document that has never had
 * a preamble from the user's personal default. `extractLabel` returns "" both
 * for a key that was never set and for one deliberately cleared, so without the
 * envelope a preamble you emptied on purpose would be re-seeded from your
 * default on every panel reload — the setting would appear not to stick.
 *
 * Documents written before the envelope hold bare text, which reads back as
 * present; there is nothing to migrate, since the next write upgrades them.
 *
 * @returns {{text: string, present: boolean}}
 */
function readDocumentPreamble(doc) {
  const raw = tryGet(() => doc.extractLabel(DOC_PREAMBLE_KEY), "") || "";
  if (!raw) return { text: "", present: false };
  try {
    const box = JSON.parse(raw);
    if (box && box.v) return { text: String(box.text || ""), present: true };
  } catch { /* legacy: written as bare text before the envelope existed */ }
  return { text: raw, present: true };
}

function writeDocumentPreamble(doc, text) {
  doc.insertLabel(DOC_PREAMBLE_KEY, JSON.stringify({ v: 1, text: text || "" }));
}

/** Every equation frame in the document, in story order where that applies. */
function findAll(doc) {
  const items = tryGet(() => doc.allPageItems, []) || [];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const record = readRecord(items[i]);
    if (record) out.push({ frame: items[i], record });
  }
  return out;
}

module.exports = {
  readRecord,
  writeRecord,
  makeRecord,
  readDocumentPreamble,
  writeDocumentPreamble,
  findAll,
  hash,
};
