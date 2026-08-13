#!/usr/bin/env node
/**
 * Test runner.
 *
 * The suites are split by what they need, because the requirements differ a lot
 * and the slow ones are not always available:
 *
 *   unit     nothing but node                        (~1s)
 *   render   the typst CLI                           (~10s)
 *   browser  headless Chrome and a populated vendor/ (~60s)
 *   app      a running InDesign                      (~30s)
 *
 *   node tools/run-tests.mjs            # unit + render
 *   node tools/run-tests.mjs all
 *   node tools/run-tests.mjs browser app
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SUITES = {
  unit: {
    needs: "node",
    tests: [
      ["module resolution", "node", ["tools/check-requires.mjs"]],
      ["message envelopes", "node", ["tools/test-messages.mjs"]],
      ["baseline solver", "node", ["tools/test-baseline-offset.mjs"]],
      ["settings storage", "node", ["tools/test-prefs.mjs"]],
      ["selection search", "node", ["tools/test-selection.mjs"]],
      ["state and status", "node", ["tools/test-store.mjs"]],
      ["render spec", "node", ["tools/test-spec.mjs"]],
      ["spectrum tokens", "node", ["tools/test-tokens.mjs"]],
      ["theme resolution", "node", ["tools/test-theme.mjs"]],
    ],
  },
  render: {
    needs: "the typst CLI",
    tests: [["typst template depth", "python3", ["tools/validate-template.py"]]],
  },
  browser: {
    needs: "headless Chrome and vendor/",
    tests: [
      ["wasm compiler vs CLI", "node", ["tools/smoke-webview.mjs"]],
      ["preview and bridge", "node", ["tools/smoke-preview.mjs"]],
      ["wasm loading strategies", "node", ["tools/smoke-wasm-loading.mjs"]],
    ],
  },
  app: {
    needs: "a running InDesign",
    tests: [["plugin end to end", "node", ["tools/test-plugin.mjs"]]],
  },
};

const DEFAULT = ["unit", "render"];
const asked = process.argv.slice(2);
const names = asked.length === 0 ? DEFAULT
  : asked.includes("all") ? Object.keys(SUITES)
  : asked;

for (const name of names) {
  if (!SUITES[name]) {
    console.error(`unknown suite "${name}"; known: ${Object.keys(SUITES).join(", ")}, all`);
    process.exit(2);
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => resolve({ code: 127, out: `${cmd} not found` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

let failed = 0;
let passed = 0;
const started = Date.now();

for (const name of names) {
  const suite = SUITES[name];
  console.log(`\n\x1b[1m${name}\x1b[0m  (needs ${suite.needs})`);
  for (const [label, cmd, args] of suite.tests) {
    const t0 = Date.now();
    const { code, out } = await run(cmd, args);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (code === 0) {
      passed++;
      console.log(`  \x1b[32mpass\x1b[0m  ${label.padEnd(26)} ${secs}s`);
    } else {
      failed++;
      console.log(`  \x1b[31mFAIL\x1b[0m  ${label.padEnd(26)} ${secs}s`);
      // Only the tail: these tests print a lot, and the verdict is at the end.
      const lines = out.trimEnd().split("\n");
      for (const line of lines.slice(-18)) console.log(`        ${line}`);
    }
  }
}

const total = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${failed ? "\x1b[31m" : "\x1b[32m"}${passed} passed, ${failed} failed\x1b[0m  ${total}s`);
process.exit(failed ? 1 : 0);
