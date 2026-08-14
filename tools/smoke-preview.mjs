#!/usr/bin/env node
/**
 * Exercises webview/index.html the way the panel does — over the message
 * bridge — and checks what it paints.
 *
 * This is the part that cannot be tested from InDesign without a human looking
 * at it: that a render request comes back with metrics and PDF bytes, that the
 * preview actually draws an SVG, and that the baseline guide lands where the
 * reported depth says it should.
 *
 *   node tools/smoke-preview.mjs
 */
import { drive, requirements } from "./harness.mjs";

const CASES = [
  { name: "simple inline", spec: { body: "x^2 + 1", mode: "inline", size: 10 }, want: {} },
  { name: "deep descender", spec: { body: "sum_(i=1)^n x_i / 2", mode: "inline", size: 10 }, want: { pdf: true } },
  { name: "display", spec: { body: "integral_0^1 f(x) dif x", mode: "display", size: 12 }, want: { pdf: true } },
  { name: "cmyk colour", spec: { body: "alpha", mode: "inline", size: 11, color: { space: "CMYK", values: [0, 100, 0, 0] } }, want: { pdf: true } },
  // A colour typed into the panel's box: Typst's own syntax, straight through.
  { name: "typst colour", spec: { body: "alpha", mode: "inline", size: 11, color: { typst: 'rgb("#cc0000")' } }, want: { pdf: true } },
  // The reason it is parenthesised. Without that, the comma ends the fill
  // argument and the error is about `#set text`, which says nothing useful
  // about the colour; with it, the failure stays a colour error.
  { name: "colour that is not one", spec: { body: "alpha", mode: "inline", size: 11, color: { typst: "red, blue" } }, want: {}, expectError: true },
  { name: "preamble macro", spec: { body: "vb(x)", mode: "inline", size: 10, preamble: "#let vb(x) = math.bold(x)" }, want: {} },
  { name: "syntax error", spec: { body: "x^", mode: "inline", size: 10 }, want: {}, expectError: true },
  { name: "preamble error", spec: { body: "x", mode: "inline", size: 10, preamble: "#let = 5" }, want: {}, expectError: true },
  { name: "empty", spec: { body: "   ", mode: "inline", size: 10 }, want: {}, expectError: true },
  { name: "plain", spec: { body: "x^2", mode: "inline", size: 10 }, want: {} },
  { name: "dollar-wrapped", spec: { body: "$x^2$", mode: "inline", size: 10 }, want: {} },
];

const DRIVER = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%} iframe{width:420px;height:260px;border:0}
</style></head><body>
<iframe id="wv" src="./webview/index.html"></iframe>
<script type="module">
const cases = ${JSON.stringify(CASES)};
const wv = document.getElementById("wv");
const out = [];
const inbox = [];
window.addEventListener("message", (e) => {
  try { inbox.push(JSON.parse(e.data)); } catch { /* not ours */ }
});
const waitFor = (test, ms) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = () => {
    const hit = inbox.find(test);
    if (hit) return resolve(hit);
    if (Date.now() - t0 > ms) return reject(new Error("timeout waiting for a reply"));
    setTimeout(tick, 25);
  };
  tick();
});
const post = (m) => wv.contentWindow.postMessage(JSON.stringify(m), "*");

try {
  // Mirror the panel's ping-until-ready handshake.
  const pinger = setInterval(() => { try { post({ type: "ping" }); } catch {} }, 300);
  const ready = await waitFor((m) => m.type === "ready", 120000);
  clearInterval(pinger);
  // The real panel acks, which stops the webview re-announcing and clears its
  // bridge readout; without it the readout would keep overwriting the status.
  post({ type: "ack" });
  await new Promise((r) => setTimeout(r, 300));
  out.push({
    step: "ready", engine: ready.engine, error: ready.error || null,
    statusAfterAck: (wv.contentDocument.getElementById("status") || {}).textContent || "",
  });

  post({ type: "theme", theme: "dark" });

  let id = 1;
  // Exercise the compiler rebuild that a font change triggers: typst.ts needs
  // its compiler slot put back to a builder function, and getting that wrong
  // silently yields an undefined compiler.
  const fontId = id++;
  post({ id: fontId, type: "fonts", fonts: [] });
  const fontReply = await waitFor((m) => m.id === fontId && m.type === "result", 120000);
  out.push({ step: "rebuild", ok: fontReply.ok, fontCount: fontReply.fontCount ?? null,
             diagnostics: fontReply.diagnostics || [] });

  for (const c of cases) {
    const mine = id++;
    post({ id: mine, type: "render", spec: c.spec, want: c.want });
    const reply = await waitFor((m) => m.id === mine && m.type === "result", 60000);

    // Inspect what the preview actually painted.
    const doc = wv.contentDocument;
    const art = doc.getElementById("art");
    const svg = art && art.querySelector("svg");
    const guide = doc.getElementById("baseline");
    const painted = {
      hasArt: !!art,
      hasSvg: !!svg,
      artHeight: art ? parseFloat(art.style.height) : null,
      guideTop: guide ? parseFloat(guide.style.top) : null,
      placeholder: (doc.querySelector("#stage .placeholder") || {}).textContent || "",
      status: (doc.getElementById("status") || {}).textContent || "",
      statusIsError: !!(doc.getElementById("status") || {}).className?.includes("error"),
      bodyDark: doc.body.classList.contains("dark"),
    };
    out.push({
      name: c.name, ok: reply.ok, metrics: reply.metrics || null,
      pdfBytes: reply.pdfBase64 ? atob(reply.pdfBase64).length : 0,
      pdfMagic: reply.pdfBase64 ? atob(reply.pdfBase64).slice(0, 5) : null,
      diagnostics: reply.diagnostics || [], painted,
    });
  }
} catch (e) {
  out.push({ fatal: String((e && e.stack) || e) });
}
await fetch("/__result", { method: "POST", body: JSON.stringify(out) });
</script></body></html>`;

requirements();
const rows = await drive("preview-driver", DRIVER);

let failures = 0;
const fail = (msg) => { failures++; console.log(`   ✗ ${msg}`); };

const ready = rows.shift();
if (ready.fatal) { console.error("FATAL:", ready.fatal); process.exit(1); }
if (ready.error) { console.error("compiler failed to start:", ready.error); process.exit(1); }
console.log(`ready: ${ready.engine}`);
if (/bridge:/.test(ready.statusAfterAck)) {
  console.log(`✗ ack did not clear the bridge readout (status: ${JSON.stringify(ready.statusAfterAck)})`);
  failures++;
} else {
  console.log(`ack clears bridge readout: ${JSON.stringify(ready.statusAfterAck)}`);
}

const rebuild = rows.shift();
if (!rebuild || rebuild.step !== "rebuild" || !rebuild.ok) {
  console.log(`✗ compiler rebuild after a font change failed: ` +
    `${(rebuild && rebuild.diagnostics || []).map((d) => d.message).join("; ") || "no reply"}`);
  failures++;
} else {
  console.log(`rebuild after font change: ok (${rebuild.fontCount} extra fonts)\n`);
}

for (const row of rows) {
  if (row.fatal) { console.error("FATAL:", row.fatal); failures++; continue; }
  const expected = CASES.find((c) => c.name === row.name);
  const p = row.painted;
  console.log(`${row.name}`);

  if (expected.expectError) {
    if (row.ok) fail("expected an error, got a successful render");
    else {
      const msg = row.diagnostics.map((d) => d.message).join("; ");
      console.log(`   error surfaced: ${msg || "(none)"}`);
      if (!row.diagnostics.length) fail("error had no diagnostics to show the user");
      if (expected.spec.body.trim() && !p.statusIsError) {
        fail("preview status was not marked as an error");
      }
      // The stage and the status line are two places to look, so neither may
      // be blank and they may not say the same thing twice.
      if (!p.status) fail("preview status line was left empty");
      if (p.placeholder && p.status === p.placeholder) {
        fail(`status line repeats what the stage says (${JSON.stringify(p.status)})`);
      }
      const located = row.diagnostics.find((d) => d.line != null);
      if (expected.name === "syntax error" && !located) {
        fail("syntax error carried no line/column");
      }
      if (expected.name === "empty") {
        // Nothing is wrong with an empty expression, so the line falls back to
        // what it says at rest: which engine is waiting.
        console.log(`   stage: ${JSON.stringify(p.placeholder)}, status: ${JSON.stringify(p.status)}`);
        if (p.status !== ready.engine) {
          fail(`empty expression should leave the engine on the status line, got ${JSON.stringify(p.status)}`);
        }
      }
      if (expected.name === "preamble error" &&
          !row.diagnostics.some((d) => d.where === "preamble")) {
        fail("preamble error was not attributed to the preamble");
      }
    }
    continue;
  }

  if (!row.ok) { fail(`unexpected error: ${row.diagnostics.map((d) => d.message).join("; ")}`); continue; }
  if (!p.hasSvg) fail("preview painted no SVG");
  if (!p.bodyDark) fail("theme message was ignored");

  const m = row.metrics;
  console.log(`   ${m.width.toFixed(2)} × ${m.height.toFixed(2)} pt, depth ${m.depth.toFixed(2)}` +
    (row.pdfBytes ? `, pdf ${row.pdfBytes} B` : ""));

  if (expected.want.pdf) {
    if (row.pdfMagic !== "%PDF-") fail(`PDF bytes look wrong (magic ${JSON.stringify(row.pdfMagic)})`);
  } else if (row.pdfBytes) {
    fail("PDF was returned when it was not asked for");
  }

  // The guide must sit at (height - depth) / height down the artwork box.
  if (expected.spec.mode === "display") {
    if (p.guideTop !== null) fail("display mode should not draw a baseline guide");
  } else {
    if (p.guideTop === null) { fail("no baseline guide drawn"); continue; }
    const wantFrac = (m.height - m.depth) / m.height;
    const gotFrac = p.guideTop / p.artHeight;
    if (Math.abs(wantFrac - gotFrac) > 0.01) {
      fail(`baseline guide at ${(gotFrac * 100).toFixed(1)}% but depth implies ${(wantFrac * 100).toFixed(1)}%`);
    }
  }
}

// Pasting `$x^2$` from a Typst document must render identically to typing `x^2`.
const plain = rows.find((r) => r.name === "plain");
const wrapped = rows.find((r) => r.name === "dollar-wrapped");
if (plain && wrapped && plain.ok && wrapped.ok) {
  const same = ["width", "height", "depth"].every(
    (k) => Math.abs(plain.metrics[k] - wrapped.metrics[k]) < 0.001);
  console.log(same
    ? "\n$…$ normalisation: identical to the bare expression"
    : "\n✗ $…$ normalisation changed the render");
  if (!same) failures++;
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
