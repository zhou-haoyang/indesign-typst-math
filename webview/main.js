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

/* ----------------------------------------------------------------- preview */

function paint(res, spec) {
  stage.textContent = "";

  if (!res.ok) {
    const box = document.createElement("span");
    box.className = "placeholder";
    box.textContent = res.diagnostics.some((d) => d.severity === "info")
      ? res.diagnostics[0].message
      : "—";
    stage.appendChild(box);
    showDiagnostics(res.diagnostics);
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
  if (svg) {
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.width = "100%";
    svg.style.height = "100%";
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
  // it explains nothing the dashed baseline guide does not already show.
  statusEl.textContent = `${m.width.toFixed(2)} × ${m.height.toFixed(2)} pt`;
}

function showDiagnostics(diagnostics) {
  const lines = (diagnostics || []).map((d) => {
    const where = d.line != null ? `${d.line}:${d.column ?? 0}: ` : "";
    return `${where}${d.severity === "warning" ? "warning: " : ""}${d.message}`;
  });
  statusEl.className = diagnostics.some((d) => d.severity === "error") ? "error" : "";
  statusEl.textContent = lines.join("\n");
}

/* Re-fit on panel resize without recompiling. */
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (lastResult && lastResult.ok) paint(lastResult, { mode: lastResult.mode });
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

