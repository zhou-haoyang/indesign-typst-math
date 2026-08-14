/**
 * Webview entry point: owns the preview surface and the bridge to the panel.
 *
 * Protocol (JSON strings both ways, because the UXP message bridge is happiest
 * with strings):
 *
 *   panel -> webview   {id, type: "render", spec, want}
 *                      {id, type: "fonts", fonts: [{name, data(base64)}]}
 *                      {type: "theme", theme: "light"|"dark"}
 *   webview -> panel   {type: "ready", engine}
 *                      {id, type: "result", ok, metrics, pdfBase64, diagnostics}
 */
import { init, render, setFonts, wasmSource } from "./compile.js";

const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");

const PT_TO_PX = 96 / 72;
const MAX_SCALE = 4;

let lastResult = null;
/** The spec `lastResult` was rendered from; a repaint needs it as much as the
 *  result, since the baseline guide is drawn for inline mode only. */
let lastSpec = null;

/* ------------------------------------------------------------------ bridge */

/* The panel and this page can only talk over the UXP message bridge, and when
   that bridge is misconfigured both sides just go quiet — the webview's console
   is separate, so nothing surfaces. So the bridge's state is logged on every
   announcement, and reaches the status line only once the panel has stayed
   silent long enough for that to be a fault rather than a slow start: this page
   is the panel's preview area, and a healthy startup should not flash a line of
   counters at whoever opens it. */
let messagesIn = 0;
let sendChannel = "none";
let acknowledged = false;
/** Announcements that may go unanswered before the readout goes on screen. */
const BRIDGE_PATIENCE = 4;
let unanswered = 0;

function bridgeReadout() {
  return `bridge: uxpHost ${window.uxpHost ? "present" : "MISSING"}` +
    ` · in ${messagesIn} · out ${sendChannel}`;
}

function send(msg) {
  const text = JSON.stringify(msg);
  // uxpHost is looked up per call rather than captured, so nothing depends on
  // it existing at module-evaluation time. Falling back to the parent frame
  // lets this page be driven from a plain browser (see tools/smoke-preview.mjs).
  const host = window.uxpHost;
  try {
    if (host && typeof host.postMessage === "function") {
      sendChannel = "uxpHost";
      host.postMessage(text);
      return;
    }
    if (window.parent && window.parent !== window) {
      sendChannel = "parent";
      window.parent.postMessage(text, "*");
      return;
    }
    sendChannel = "none";
    console.log("[webview->panel]", text);
  } catch (err) {
    sendChannel = `error: ${(err && err.message) || err}`;
  }
}

window.addEventListener("message", (event) => {
  messagesIn++;
  let msg = event.data;
  if (typeof msg === "string") {
    try { msg = JSON.parse(msg); } catch { return; }
  }
  // Some hosts hand the payload over wrapped one level deeper.
  if (msg && typeof msg === "object" && !msg.type && msg.data !== undefined) {
    msg = typeof msg.data === "string" ? safeParse(msg.data) : msg.data;
  }
  if (!msg || typeof msg !== "object") return;
  if (!acknowledged) refreshStatus(false);
  handle(msg);
});

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** Set once boot finishes, and replayed on demand — see the "ping" case. */
let readyMessage = null;
/** Engine string shown once the bridge is confirmed working. */
let engineLabel = "";

/**
 * While unacknowledged, keep the bridge state in view — the console first.
 *
 * @param {boolean} log Only the announcement loop logs. The panel pings several
 *   times a second while the compiler is still building, and one line per ping
 *   buries everything else in the console.
 */
function refreshStatus(log) {
  if (acknowledged) return;
  if (log) console.log(`[typst] ${bridgeReadout()}`);
  const stalled = unanswered >= BRIDGE_PATIENCE;
  statusEl.className = stalled ? "error" : "";
  statusEl.textContent = stalled
    ? `${engineLabel}\nThe panel is not answering — ${bridgeReadout()}`.trim()
    : engineLabel;
}

async function handle(msg) {
  switch (msg.type) {
    case "ping":
      // The panel may have attached its listener after we announced ourselves.
      if (readyMessage) send(readyMessage);
      break;
    case "ack":
      // A full round trip completed; the bridge readout has served its purpose.
      acknowledged = true;
      statusEl.className = "";
      statusEl.textContent = engineLabel;
      break;
    case "theme":
      document.body.classList.toggle("dark", msg.theme === "dark");
      // The legibility halo is chosen from the surface the artwork is drawn on,
      // so the other theme may want it added or taken away. Nothing here needs
      // recompiling: the halo lives in the painted SVG.
      if (lastResult && lastResult.ok) paint(lastResult, lastSpec);
      break;
    case "fonts":
      try {
        const n = await setFonts(msg.fonts);
        send({ id: msg.id, type: "result", ok: true, fontCount: n });
      } catch (err) {
        send({ id: msg.id, type: "result", ok: false, diagnostics: [{ severity: "error", message: String(err && err.message || err) }] });
      }
      break;
    case "render": {
      const res = await render(msg.spec, msg.want || {});
      lastResult = res;
      lastSpec = msg.spec;
      paint(res, msg.spec);
      // The SVG is big and the panel never looks at it; keep it out of the wire.
      send({
        id: msg.id,
        type: "result",
        ok: res.ok,
        metrics: res.metrics,
        pdfBase64: res.pdfBase64,
        diagnostics: res.diagnostics,
      });
      break;
    }
    default:
      break;
  }
}

/* --------------------------------------------------------- legibility halo */

/**
 * The preview is the one place the artwork is seen against the panel's chrome
 * rather than the page it is going onto, and the two can be the same brightness:
 * black — InDesign's default ink — is all but invisible on the dark theme's
 * #323232, and a light colour chosen for a dark page vanishes on the light one.
 * So when the ink is too close to what it is drawn on, the preview outlines it.
 *
 * **This is a property of the preview, not of the equation.** It is added to the
 * painted SVG, after the compile that produced the metrics and the PDF; those
 * are already in hand and cannot see it, so what InDesign receives is unaffected
 * by construction rather than by remembering to strip something out. The status
 * line says so, because an outline nobody asked for otherwise reads as the
 * equation having one.
 */

/** WCAG contrast ratio below which ink counts as too close to its background. */
const HALO_BELOW = 3;
/** Width of the outline, as a fraction of the em of the largest text. */
const HALO_EM = 0.015;
/** …but never so thin on screen that it may as well not be there (CSS px).
 *  The preview fits the artwork to the stage, so a small expression and a large
 *  one are drawn at much the same size and this floor is what most 10pt
 *  equations actually get; the em term takes over for large type on a stage too
 *  small to blow it up. */
const HALO_MIN_PX = 1;
const HALO_ID = "idt-halo";
const SVG_NS = "http://www.w3.org/2000/svg";

/** `#rgb`, `#rrggbb` (with or without alpha) or `rgb()`/`rgba()` -> [r, g, b]. */
function parseColor(text) {
  const t = String(text == null ? "" : text).trim();
  const hex = /^#([0-9a-f]+)$/i.exec(t);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
    if (h.length === 6 || h.length === 8) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return null;
  }
  const fn = /^rgba?\(([^)]*)\)/i.exec(t);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every((v) => Number.isFinite(v))) return parts;
  }
  return null;
}

/** Relative luminance, as WCAG defines it. */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = Math.min(255, Math.max(0, v)) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every colour the artwork paints in. Glyph runs carry the ink as `fill` on
 * their group; rules — fraction bars, radical bars, matrix lines — are stroked
 * paths, so `stroke` counts too. Anything that is not a plain colour (`none`,
 * a gradient's `url(…)`) drops out of `parseColor`.
 */
function inkColors(svg) {
  const found = [];
  for (const el of svg.querySelectorAll("[fill], [stroke]")) {
    for (const attr of ["fill", "stroke"]) {
      const color = parseColor(el.getAttribute(attr));
      if (color) found.push(color);
    }
  }
  return found;
}

/**
 * Point size of the largest text in the artwork, measured off the artwork
 * rather than taken from the spec: typst.ts lays each run out in a glyph space
 * of 1000 units to the em and scales it by size/1000, so the transform *is* the
 * size — including any the document preamble set for itself.
 */
function emPoints(svg, fallback) {
  let biggest = 0;
  for (const run of svg.querySelectorAll("g.typst-text")) {
    const consolidated = run.transform && run.transform.baseVal.consolidate();
    if (consolidated) biggest = Math.max(biggest, Math.abs(consolidated.matrix.a) * 1000);
  }
  return biggest > 0 ? biggest : fallback;
}

/**
 * Draw `radiusPt` of `color` behind everything the artwork paints.
 *
 * One filter on the page group rather than a stroke on each element, because
 * the artwork is not all glyphs: a fraction bar is a stroked path and cannot
 * take a second stroke, and glyph outlines live in a glyph space of their own
 * where a width in points means nothing. Dilating the alpha channel treats
 * glyphs, rules and delimiters alike, and its radius is in the page's own
 * units, which are points.
 */
function addHalo(svg, color, radiusPt) {
  const make = (name, attrs) => {
    const el = document.createElementNS(SVG_NS, name);
    for (const key of Object.keys(attrs)) el.setAttribute(key, attrs[key]);
    return el;
  };
  // sRGB, not the linearRGB filters default: the halo is a flat colour picked
  // to contrast in the space the panel is painted in, not in a linear one.
  const filter = make("filter", { id: HALO_ID, "color-interpolation-filters": "sRGB" });
  filter.appendChild(make("feMorphology", {
    in: "SourceAlpha", operator: "dilate", radius: radiusPt, result: "fattened",
  }));
  filter.appendChild(make("feFlood", { "flood-color": color, result: "wash" }));
  filter.appendChild(make("feComposite", {
    in: "wash", in2: "fattened", operator: "in", result: "halo",
  }));
  const merge = make("feMerge", {});
  merge.appendChild(make("feMergeNode", { in: "halo" }));
  merge.appendChild(make("feMergeNode", { in: "SourceGraphic" }));
  filter.appendChild(merge);

  const defs = make("defs", {});
  defs.appendChild(filter);
  svg.insertBefore(defs, svg.firstChild);
  for (const page of svg.querySelectorAll("g.typst-page")) {
    page.setAttribute("filter", `url(#${HALO_ID})`);
  }
}

/**
 * Outline the artwork if any of its ink is too close to the panel's own
 * background, and say whether it did.
 *
 * The halo is the theme's *text* colour, which contrasts with the background by
 * construction — and so with ink that was close enough to it to need this.
 *
 * @param {SVGElement} svg
 * @param {number} pxPerPt How large the artwork is being drawn, so that a halo
 *   in points can be kept visible on screen.
 */
function haloIfNeeded(svg, pxPerPt) {
  const surface = getComputedStyle(document.body);
  const background = parseColor(surface.backgroundColor);
  if (!background) return false;
  const worst = inkColors(svg)
    .reduce((lowest, ink) => Math.min(lowest, contrast(ink, background)), Infinity);
  if (!(worst < HALO_BELOW)) return false;
  addHalo(svg, surface.color, Math.max(
    HALO_EM * emPoints(svg, 10),
    pxPerPt > 0 ? HALO_MIN_PX / pxPerPt : 0,
  ));
  return true;
}

/* ----------------------------------------------------------------- preview */

function paint(res, spec) {
  stage.textContent = "";

  if (!res.ok) {
    // An `info` diagnostic — "Nothing to render." — is not a complaint about
    // the source; it is the state of the stage, so it is drawn *as* the stage
    // and taken off the status line. Printed in both places it read as two
    // separate objections to one empty box.
    const onStage = res.diagnostics.find((d) => d.severity === "info");
    const box = document.createElement("span");
    box.className = "placeholder";
    box.textContent = onStage ? onStage.message : "—";
    stage.appendChild(box);
    showDiagnostics(res.diagnostics.filter((d) => d !== onStage));
    return;
  }

  const art = document.createElement("div");
  art.id = "art";

  // Scale to fit the stage, but never blow tiny expressions up past MAX_SCALE.
  const wPx = res.metrics.width * PT_TO_PX;
  const hPx = res.metrics.height * PT_TO_PX;
  const avail = { w: Math.max(40, stage.clientWidth - 34), h: Math.max(30, stage.clientHeight - 28) };
  const scale = Math.min(MAX_SCALE, avail.w / wPx, avail.h / hPx);

  art.style.width = `${wPx * scale}px`;
  art.style.height = `${hPx * scale}px`;
  art.innerHTML = res.svg;
  const svg = art.querySelector("svg");
  let haloed = false;
  if (svg) {
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.width = "100%";
    svg.style.height = "100%";
    haloed = haloIfNeeded(svg, PT_TO_PX * scale);
  }

  // The one thing worth seeing before you commit: where the maths baseline is
  // relative to the box InDesign will anchor.
  if (spec && spec.mode !== "display") {
    const guide = document.createElement("div");
    guide.id = "baseline";
    const frac = (res.metrics.height - res.metrics.depth) / res.metrics.height;
    guide.style.top = `${Math.max(0, Math.min(1, frac)) * hPx * scale}px`;
    art.appendChild(guide);
  }

  stage.appendChild(art);

  const m = res.metrics;
  statusEl.className = "";
  // Size only: depth is what the placement turns on, but as a number on screen
  // it explains nothing the dashed baseline guide does not already show. The
  // outline is the exception — it is a visible change to the artwork that the
  // document will not have, so it is worth a note.
  statusEl.textContent = `${m.width.toFixed(2)} × ${m.height.toFixed(2)} pt` +
    (haloed ? " · outlined for contrast (preview only)" : "");
}

/**
 * The status line, in order of what it is worth saying: whatever went wrong,
 * else the size of what was drawn, else what engine is waiting to draw it.
 * Never blank, and never a second copy of what the stage already says.
 */
function showDiagnostics(diagnostics) {
  const lines = (diagnostics || []).map((d) => {
    const where = d.line != null ? `${d.line}:${d.column ?? 0}: ` : "";
    return `${where}${d.severity === "warning" ? "warning: " : ""}${d.message}`;
  });
  statusEl.className = lines.length && diagnostics.some((d) => d.severity === "error") ? "error" : "";
  statusEl.textContent = lines.length ? lines.join("\n") : engineLabel;
}

/* Re-fit on panel resize without recompiling. */
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastResult && lastResult.ok) paint(lastResult, lastSpec);
  }, 80);
});

/* -------------------------------------------------------------------- boot */

(async () => {
  let engine = "typst.ts";
  try {
    const url = new URL("../vendor/versions.json", import.meta.url).href;
    const versions = await fetch(url).then((r) => r.json());
    engine = `typst ${versions.typst} · typst.ts ${versions["typst.ts"]}`;
  } catch { /* versions.json is a convenience, not a requirement */ }

  try {
    await init();
    stage.innerHTML = '<span class="placeholder">Type an expression…</span>';
    engineLabel = engine;
    // Which loading strategy won is worth having when startup breaks, and is
    // noise on screen; it also reaches the panel, for About and Settings.
    console.log(`[typst] ${engine} · wasm via ${wasmSource()}`);
    readyMessage = { type: "ready", engine, wasmSource: wasmSource() };
  } catch (err) {
    stage.innerHTML = '<span class="placeholder">Compiler failed to start</span>';
    engineLabel = String((err && err.message) || err);
    readyMessage = { type: "ready", engine, error: String((err && err.message) || err) };
  }
  send(readyMessage);
  refreshStatus(true);
  // Keep announcing until the panel confirms it heard us: the panel may attach
  // its listener after this point, and a message sent into a dead bridge is
  // dropped without error.
  const retry = setInterval(() => {
    if (acknowledged) return clearInterval(retry);
    unanswered++;
    send(readyMessage);
    refreshStatus(true);
  }, 1000);
  setTimeout(() => clearInterval(retry), 30000);
})();

