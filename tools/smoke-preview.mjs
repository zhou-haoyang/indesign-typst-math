#!/usr/bin/env node
/**
 * Exercises webview/index.html the way the panel does — over the message
 * bridge — and checks what it paints.
 *
 * This is the part that cannot be tested from InDesign without a human looking
 * at it: that a render request comes back with metrics and PDF bytes, that the
 * preview actually draws an SVG, that the baseline guide lands where the
 * reported depth says it should, and that the legibility outline appears on the
 * ink that needs it and never reaches the PDF.
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

/**
 * The legibility outline is chosen from the ink against the panel's own
 * background, so the same expression wants it in one theme and not the other —
 * and the artwork InDesign receives must be identical either way.
 */
const HALO_CASES = [
  { name: "black ink", spec: { body: "x/2", mode: "inline", size: 10 }, haloIn: "dark" },
  { name: "white ink", spec: { body: "x/2", mode: "inline", size: 10, color: { typst: "white" } }, haloIn: "light" },
  // Read after a theme repaint rather than after the render, and so also the
  // check that a repaint still knows what it drew: it is handed the spec, not
  // the result, and a display equation has no baseline to guide.
  { name: "display ink", spec: { body: "x/2", mode: "display", size: 12 }, haloIn: "dark" },
];

const DRIVER = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%} iframe{width:420px;height:260px;border:0}
</style></head><body>
<iframe id="wv" src="./webview/index.html"></iframe>
<script type="module">
const cases = ${JSON.stringify(CASES)};
const haloCases = ${JSON.stringify(HALO_CASES)};
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
    // Where the guide is drawn, and where the artwork's baseline actually is —
    // both in screen pixels, so the comparison passes through every transform
    // the SVG applies rather than trusting the box we asked for. The metrics
    // alone cannot catch a mapping bug: they agree with themselves.
    let baselineY = null, inkBaseline = null;
    if (svg && reply.metrics) {
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const pt = svg.createSVGPoint();
        pt.x = 0;
        pt.y = reply.metrics.height - reply.metrics.depth;
        baselineY = pt.matrixTransform(ctm).y;
      }
      // The largest text run sits on the equation's own baseline for anything
      // with nothing stacked at top level, and a run's origin *is* its baseline.
      let em = 0;
      for (const run of svg.querySelectorAll("g.typst-text")) {
        const local = run.transform && run.transform.baseVal.consolidate();
        const screen = run.getScreenCTM();
        if (local && screen && Math.abs(local.matrix.a) * 1000 > em) {
          em = Math.abs(local.matrix.a) * 1000;
          inkBaseline = screen.f;
        }
      }
    }
    const painted = {
      hasArt: !!art,
      hasSvg: !!svg,
      artHeight: art ? parseFloat(art.style.height) : null,
      guideTop: guide ? parseFloat(guide.style.top) : null,
      artTop: art ? art.getBoundingClientRect().top : null,
      guideY: guide ? guide.getBoundingClientRect().top : null,
      baselineY, inkBaseline,
      viewBox: svg ? svg.getAttribute("viewBox") : null,
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

  for (const c of haloCases) {
    for (const theme of ["light", "dark"]) {
      post({ type: "theme", theme });
      const mine = id++;
      post({ id: mine, type: "render", spec: c.spec, want: { pdf: true } });
      const reply = await waitFor((m) => m.id === mine && m.type === "result", 60000);
      // Repaint before looking: same theme, so nothing about the expectations
      // changes, but everything read below comes from the path a theme switch
      // takes — which has only the stored spec to work from.
      post({ type: "theme", theme });
      await new Promise((r) => setTimeout(r, 50));
      const doc = wv.contentDocument;
      const flood = doc.querySelector("#art filter#idt-halo feFlood");
      const dilate = doc.querySelector("#art filter#idt-halo feMorphology");
      out.push({
        step: "halo", name: c.name, theme,
        outlined: !!doc.querySelector("#art g.typst-page[filter]"),
        color: flood && flood.getAttribute("flood-color"),
        radius: dilate && +dilate.getAttribute("radius"),
        background: getComputedStyle(doc.body).backgroundColor,
        status: (doc.getElementById("status") || {}).textContent || "",
        guide: !!doc.getElementById("baseline"),
        // Whole-artwork identity, not a length: this is the check that the
        // outline stops at the preview.
        pdf: reply.pdfBase64 || null,
      });
    }
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

for (const row of rows.filter((r) => !r.step)) {
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

  // The guide must be drawn on the artwork's baseline *as painted*, not at
  // (height - depth) / height of the box we asked for. Those two are the same
  // only while the SVG fills that box, and typst.ts rounds the page box up to
  // whole points in the viewBox it emits — which is what once drew the guide
  // half a point low while every metric agreed with itself.
  if (expected.spec.mode === "display") {
    if (p.guideTop !== null) fail("display mode should not draw a baseline guide");
  } else {
    if (p.guideTop === null) { fail("no baseline guide drawn"); continue; }
    if (p.baselineY === null) { fail("could not locate the baseline in the painted SVG"); continue; }
    const off = p.guideY - p.baselineY;
    console.log(`   guide ${off >= 0 ? "+" : ""}${off.toFixed(2)} px from the painted baseline` +
      ` (viewBox ${p.viewBox}, page ${m.width.toFixed(2)} × ${m.height.toFixed(2)})`);
    if (Math.abs(off) > 1) {
      fail(`baseline guide is ${Math.abs(off).toFixed(2)} px ` +
        `${off > 0 ? "below" : "above"} where the artwork's baseline is drawn`);
    }
    // And that painted baseline has to be the one the placement will use: an
    // artwork drawn to a different depth than the one InDesign is handed would
    // look right here and land wrong in the document.
    // Skipped where nothing at top level sits on the equation's own baseline —
    // a fraction's runs are its numerator and denominator, and neither does.
    if (p.inkBaseline !== null && !/[/]|frac|cases|mat\(|binom|sum|product/.test(expected.spec.body)) {
      const ink = p.inkBaseline - p.baselineY;
      if (Math.abs(ink) > 1) {
        fail(`the ink sits ${Math.abs(ink).toFixed(2)} px from height - depth: ` +
          `the reported depth does not describe the artwork`);
      }
    }
  }
}

/* The legibility outline: on the ink that needs it, in the theme that needs it,
   and never in what gets placed. */
console.log("\nlegibility outline");

/**
 * The same source exports the same PDF byte for byte — measured — except for
 * *when* it was made, which Typst stamps in four places, all of them at
 * one-second resolution. Two renders a moment apart straddle a second often
 * enough that comparing the raw bytes fails about a third of the time, and
 * every one of these had to go before the comparison stopped being a lottery:
 * `/ModDate` and `/CreationDate`; the same two again in ISO 8601 inside the XMP
 * packet; and the document identity — `xmpMM:InstanceID`/`DocumentID` and the
 * trailer's `/ID` — which is a hash seeded from that timestamp.
 *
 * All of it is metadata about the export. Stripping it leaves the comparison
 * looking at the page, which is the only thing this check is about.
 */
const undated = (b64) => atob(b64)
  .replace(/\/(?:Mod|Creation)Date \(D:[^)]*\)/g, "")
  .replace(/<xmp:(?:Modify|Create)Date>[^<]*<\/xmp:(?:Modify|Create)Date>/g, "")
  .replace(/<xmpMM:(?:Instance|Document)ID>[^<]*<\/xmpMM:(?:Instance|Document)ID>/g, "")
  .replace(/\/ID \[[^\]]*\]/g, "");
for (const c of HALO_CASES) {
  const shots = rows.filter((r) => r.step === "halo" && r.name === c.name);
  if (shots.length !== 2) { fail(`${c.name}: expected both themes, got ${shots.length}`); continue; }
  for (const shot of shots) {
    const want = shot.theme === c.haloIn;
    const says = / · outlined for contrast \(preview only\)$/.test(shot.status);
    console.log(`   ${c.name} on ${shot.theme}: ${shot.outlined
      ? `outlined ${shot.color} at ${shot.radius.toFixed(3)}pt on ${shot.background}`
      : `plain on ${shot.background}`}`);
    if (shot.outlined !== want) {
      fail(`${c.name} on the ${shot.theme} theme should ${want ? "" : "not "}be outlined`);
    }
    // The stage and the status line have to agree about it, or the outline
    // reads as something the equation itself has.
    if (says !== want) fail(`${c.name} on ${shot.theme}: status line says ${JSON.stringify(shot.status)}`);
    if (!/^\d+\.\d\d × \d+\.\d\d pt/.test(shot.status)) {
      fail(`${c.name} on ${shot.theme}: the note displaced the size (${JSON.stringify(shot.status)})`);
    }
    if (shot.guide !== (c.spec.mode !== "display")) {
      fail(`${c.name} on ${shot.theme}: repaint ${shot.guide ? "drew" : "lost"} the baseline guide`);
    }
  }
  const [a, b] = shots;
  if (!a.pdf || !b.pdf) fail(`${c.name}: no PDF to compare across themes`);
  else if (undated(a.pdf) !== undated(b.pdf)) {
    fail(`${c.name}: the outline changed the placed artwork`);
  } else console.log(`   ${c.name}: identical PDF in both themes (${atob(a.pdf).length} B)`);
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
