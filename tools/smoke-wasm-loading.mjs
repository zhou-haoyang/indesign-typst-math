#!/usr/bin/env node
/**
 * Check every wasm-loading strategy in isolation.
 *
 * Over http the first strategy always wins, so the fallbacks would otherwise
 * never be exercised — yet the fallback is exactly what UXP relies on: a
 * `plugin:/` page resolves to a `file://` origin where fetch and XHR are both
 * blocked, leaving the base64 sidecar module as the only way in.
 *
 *   node tools/smoke-wasm-loading.mjs
 */
import { drive, requirements } from "./harness.mjs";

// "plugin" cannot work outside UXP; "xhr" and "url" both work over http.
const STRATEGIES = ["url", "xhr", "module"];

// One browser per strategy: `$typst` is a singleton on window, so a second
// strategy in the same page hits "compiler has been initialized".
const DRIVER = (strategy) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">
const strategy = ${JSON.stringify(strategy)};
globalThis.__IDT_WASM_STRATEGY = strategy;
let row;
try {
  const mod = await import("./webview/compile.js");
  const t0 = performance.now();
  await mod.init();
  const boot = Math.round(performance.now() - t0);
  const r = await mod.render({ body: "x_j", mode: "inline", size: 10 }, { pdf: true });
  row = {
    strategy, ok: r.ok, via: mod.wasmSource(), boot,
    depth: r.metrics ? r.metrics.depth : null,
    pdfMagic: r.pdfBase64 ? atob(r.pdfBase64).slice(0, 5) : null,
    diagnostics: r.diagnostics || [],
  };
} catch (e) {
  row = { strategy, ok: false, error: String((e && e.message) || e) };
}
await fetch("/__result", { method: "POST", body: JSON.stringify(row) });
</script></body></html>`;

requirements();
const rows = [];
for (const strategy of STRATEGIES) {
  rows.push(await drive(`wasm-${strategy}`, DRIVER(strategy)));
}

let failures = 0;
for (const row of rows) {
  if (!row.ok) {
    console.log(`${row.strategy.padEnd(8)} FAILED: ${row.error ||
      (row.diagnostics || []).map((d) => d.message).join("; ")}`);
    failures++;
    continue;
  }
  const viaOk = row.via === row.strategy;
  const depthOk = Math.abs(row.depth - 3.898) < 0.01;
  const pdfOk = row.pdfMagic === "%PDF-";
  if (!viaOk || !depthOk || !pdfOk) failures++;
  console.log(
    `${row.strategy.padEnd(8)} loaded via ${String(row.via).padEnd(7)} ` +
    `boot ${String(row.boot).padStart(5)} ms  depth ${row.depth.toFixed(3)}  ` +
    `${pdfOk ? "pdf ok" : "BAD PDF"}${viaOk ? "" : "  WRONG STRATEGY USED"}` +
    `${depthOk ? "" : "  WRONG DEPTH"}`,
  );
}

console.log(failures ? `\n${failures} failure(s)` : "\nall strategies work");
process.exit(failures ? 1 : 0);
