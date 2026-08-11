#!/usr/bin/env node
/**
 * Unit checks for the webview message extractor.
 *
 * UXP wraps webview messages in an envelope that carries its own `type`, which
 * is what made the panel drop every single message while the bridge itself was
 * working fine. Since the exact envelope is undocumented and has changed
 * before, the parser searches for our payload instead of assuming a shape —
 * these cases pin that behaviour down.
 *
 *   node tools/test-messages.mjs
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { extractMessage, describeEvent } = require(join(root, "src/backends/message.js"));

const ready = { type: "ready", engine: "typst 0.14.2", wasmSource: "module" };
const result = { type: "result", id: 7, ok: true, metrics: { width: 1, height: 2, depth: 3 } };
const json = JSON.stringify(ready);

const CASES = [
  ["plain string", json, ready],
  ["plain object", ready, ready],
  ["result payload", JSON.stringify(result), result],
  ["wrapper .data string", { data: json }, ready],
  ["wrapper .data object", { data: ready }, ready],
  ["wrapper with its own type", { type: "message", data: json }, ready],
  ["doubly wrapped", { type: "message", data: { data: json } }, ready],
  ["detail envelope", { detail: json }, ready],
  ["payload envelope", { type: "uxp-message", payload: ready }, ready],
  ["stringified wrapper", JSON.stringify({ type: "message", data: json }), ready],
  ["self-referential", (() => { const o = { type: "message" }; o.data = o; return o; })(), null],
  ["someone else's message", { type: "message", data: JSON.stringify({ hello: 1 }) }, null],
  ["not json", "not json at all", null],
  ["null", null, null],
  ["number", 42, null],
];

let failures = 0;
for (const [name, input, want] of CASES) {
  let got;
  try {
    got = extractMessage(input);
  } catch (err) {
    console.log(`  FAIL ${name.padEnd(26)} threw ${err.message}`);
    failures++;
    continue;
  }
  const ok = want === null
    ? got === null
    : !!got && JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(26)} -> ${JSON.stringify(got)}`);
}

// describeEvent must never throw, whatever it is handed — it only ever runs on
// the error path, where throwing would hide the very thing it is reporting.
const HOSTILE = [
  undefined,
  {},
  { data: undefined },
  { data: { get boom() { throw new Error("nope"); } } },
  { data: (() => { const o = {}; o.self = o; return o; })() },
  { data: "x".repeat(5000) },
];
for (const event of HOSTILE) {
  try {
    const text = describeEvent(event);
    if (typeof text !== "string") throw new Error("did not return a string");
  } catch (err) {
    console.log(`  FAIL describeEvent threw on ${JSON.stringify(event)}: ${err.message}`);
    failures++;
  }
}
console.log(`  ok   describeEvent survives ${HOSTILE.length} hostile inputs`);

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
