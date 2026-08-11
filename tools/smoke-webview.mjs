#!/usr/bin/env node
/**
 * Headless smoke test for the webview compiler, run outside InDesign.
 *
 * Serves the plugin folder, drives the same modules the webview loads in
 * headless Chrome, and checks that:
 *   - the wasm compiler starts at all,
 *   - metrics agree with what the Typst CLI reports for the same expression
 *     (an independent implementation of the same template), and
 *   - PDF export produces real PDF bytes.
 *
 *   node tools/smoke-webview.mjs
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TIMEOUT_MS = 240_000;

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

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css",
};

const DRIVER = (cases) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script type="module">
import { init, render } from "./webview/compile.js";
const results = [];
const report = (r) => fetch("/__result", { method: "POST", body: JSON.stringify(r) });
try {
  const t0 = performance.now();
  await init();
  results.push({ boot: Math.round(performance.now() - t0) });
  for (const c of ${JSON.stringify(cases)}) {
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
await report(results);
</script></body></html>`;

async function main() {
  if (!existsSync(join(root, "vendor", "typst_ts_web_compiler_bg.wasm"))) {
    console.error("vendor/ is empty — run `npm install && npm run setup` first.");
    process.exit(1);
  }
  if (!existsSync(CHROME)) {
    console.error(`no Chrome at ${CHROME}; skipping headless smoke test.`);
    process.exit(0);
  }

  const driverPath = join(root, ".smoke-driver.html");
  await writeFile(driverPath, DRIVER(CASES));
  const profile = await mkdtemp(join(tmpdir(), "idt-smoke-"));

  let resolveResults;
  const gotResults = new Promise((r) => (resolveResults = r));

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__result") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(204).end();
        resolveResults(JSON.parse(body));
      });
      return;
    }
    const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/.smoke-driver.html`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeErr = "";
  chrome.stderr.on("data", (d) => (chromeErr += d));

  const results = await Promise.race([
    gotResults,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for the driver page")), TIMEOUT_MS)),
  ]).catch((e) => e);

  chrome.kill();
  server.close();
  await rm(driverPath, { force: true });
  await rm(profile, { recursive: true, force: true });

  if (results instanceof Error) {
    console.error(results.message);
    if (chromeErr.trim()) console.error(chromeErr.trim().split("\n").slice(0, 10).join("\n"));
    process.exit(1);
  }

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
    const d = [Math.abs(cli.w - r.metrics.width), Math.abs(cli.h - r.metrics.height), Math.abs(cli.d - r.metrics.depth)];
    const matches = d.every((x) => x < 0.01);
    const pdfOk = r.pdfMagic === "%PDF-";
    if (!matches || !pdfOk) failures++;
    console.log(
      `${label.padEnd(36)} w=${r.metrics.width.toFixed(2)} h=${r.metrics.height.toFixed(2)} ` +
      `d=${r.metrics.depth.toFixed(2)} pdf=${String(r.pdfBytes).padStart(5)}B ${String(r.ms).padStart(4)}ms  ` +
      `${matches ? "matches CLI" : `CLI MISMATCH (${d.map((x) => x.toFixed(3)).join(",")})`}` +
      `${pdfOk ? "" : "  BAD PDF MAGIC"}`,
    );
  }

  console.log(failures ? `\n${failures} failure(s)` : "\nall good");
  process.exit(failures ? 1 : 0);
}

/** The same metrics via the Typst CLI, as an independent check on the wasm path. */
async function cliMetrics(body, mode, size) {
  const { buildSource } = await import(join(root, "webview", "template.js"));
  const dir = await mkdtemp(join(tmpdir(), "idt-cli-"));
  const p = join(dir, "m.typ");
  await writeFile(p, buildSource({ body, mode, size }).source);
  const out = await new Promise((resolve, reject) => {
    const c = spawn("typst", ["query", p, "<idt-metrics>", "--field", "value"]);
    let o = "", e = "";
    c.stdout.on("data", (x) => (o += x));
    c.stderr.on("data", (x) => (e += x));
    c.on("close", (code) => (code === 0 ? resolve(o) : reject(new Error(e))));
  });
  await rm(dir, { recursive: true, force: true });
  const v = JSON.parse(out)[0];
  return { w: v.w, h: v.h, d: v.d };
}

main().catch((e) => { console.error(e); process.exit(1); });
