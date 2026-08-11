#!/usr/bin/env node
/**
 * Headless check that the wasm compiler agrees with the Typst CLI.
 *
 * The CLI is an independent implementation of the same template, so if the two
 * disagree on width, height or depth, one of them is wrong — and depth is what
 * the whole inline-anchoring design rests on.
 *
 *   node tools/smoke-webview.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drive, requirements, ROOT } from "./harness.mjs";

const CASES = [
  { body: "x", mode: "inline", size: 10 },
  { body: "x_j", mode: "inline", size: 10 },
  { body: "sum_(i=1)^n x_i / 2", mode: "inline", size: 10 },
  { body: "integral_0^1 f(x) dif x", mode: "inline", size: 10 },
  { body: "mat(1, 2; 3, 4)", mode: "inline", size: 10 },
  { body: "cases(x &> 0, y &<= 1)", mode: "inline", size: 10 },
  { body: "alpha^2", mode: "inline", size: 14 },
  { body: "sum_(i=1)^n x_i / 2", mode: "display", size: 10 },
  { body: "x^", mode: "inline", size: 10, expectError: true },
];

const DRIVER = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">
import { init, render } from "./webview/compile.js";
const results = [];
try {
  const t0 = performance.now();
  await init();
  results.push({ boot: Math.round(performance.now() - t0) });
  for (const c of ${JSON.stringify(CASES)}) {
    const t = performance.now();
    const r = await render(c, { pdf: true });
    results.push({
      body: c.body, mode: c.mode, size: c.size, ok: r.ok, metrics: r.metrics,
      pdfBytes: r.pdfBase64 ? atob(r.pdfBase64).length : 0,
      pdfMagic: r.pdfBase64 ? atob(r.pdfBase64).slice(0, 5) : null,
      diagnostics: r.diagnostics, ms: Math.round(performance.now() - t),
    });
  }
} catch (e) {
  results.push({ fatal: String((e && e.stack) || e) });
}
await fetch("/__result", { method: "POST", body: JSON.stringify(results) });
</script></body></html>`;

requirements();
const results = await drive("webview-driver", DRIVER);

const boot = results.shift();
if (boot.fatal) { console.error("FATAL:", boot.fatal); process.exit(1); }
console.log(`compiler boot: ${boot.boot} ms\n`);

let failures = 0;
for (const r of results) {
  if (r.fatal) { console.error("FATAL:", r.fatal); failures++; continue; }
  const label = `[${r.mode}${r.size !== 10 ? " " + r.size + "pt" : ""}] ${r.body}`;
  const expected = CASES.find((c) => c.body === r.body && c.mode === r.mode)?.expectError;
  if (!r.ok) {
    const msg = (r.diagnostics || []).map((d) => d.message).join("; ");
    console.log(`${label.padEnd(36)} ${expected ? "error as expected" : "UNEXPECTED ERROR"}: ${msg}`);
    if (!expected) failures++;
    continue;
  }
  if (expected) { console.log(`${label.padEnd(36)} EXPECTED AN ERROR, got a render`); failures++; continue; }

  const cli = await cliMetrics(r.body, r.mode, r.size);
  const delta = [
    Math.abs(cli.w - r.metrics.width),
    Math.abs(cli.h - r.metrics.height),
    Math.abs(cli.d - r.metrics.depth),
  ];
  const matches = delta.every((x) => x < 0.01);
  const pdfOk = r.pdfMagic === "%PDF-";
  if (!matches || !pdfOk) failures++;
  console.log(
    `${label.padEnd(36)} w=${r.metrics.width.toFixed(2)} h=${r.metrics.height.toFixed(2)} ` +
    `d=${r.metrics.depth.toFixed(2)} pdf=${String(r.pdfBytes).padStart(5)}B ${String(r.ms).padStart(4)}ms  ` +
    `${matches ? "matches CLI" : `CLI MISMATCH (${delta.map((x) => x.toFixed(3)).join(",")})`}` +
    `${pdfOk ? "" : "  BAD PDF MAGIC"}`,
  );
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);

/** The same metrics via the Typst CLI. */
async function cliMetrics(body, mode, size) {
  const { buildSource } = await import(join(ROOT, "webview", "template.js"));
  const dir = await mkdtemp(join(tmpdir(), "idt-cli-"));
  const file = join(dir, "m.typ");
  await writeFile(file, buildSource({ body, mode, size }).source);
  const out = await new Promise((resolve, reject) => {
    const cli = spawn("typst", ["query", file, "<idt-metrics>", "--field", "value"]);
    let stdout = "", stderr = "";
    cli.stdout.on("data", (d) => (stdout += d));
    cli.stderr.on("data", (d) => (stderr += d));
    cli.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr))));
  });
  await rm(dir, { recursive: true, force: true });
  const value = JSON.parse(out)[0];
  return { w: value.w, h: value.h, d: value.d };
}
