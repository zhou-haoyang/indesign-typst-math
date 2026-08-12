/**
 * Typst backend: a client for the wasm compiler running inside the panel's
 * <webview>.
 *
 * The webview is not just an implementation detail of the compiler — it is also
 * the preview surface, so a render both returns metrics here and paints there.
 */
const { extractMessage, describeEvent } = require("./message");

const READY_TIMEOUT_MS = 60000;
const CALL_TIMEOUT_MS = 30000;
const PING_MS = 400;

let webview = null;
let nextId = 1;
const pending = new Map();
let loadError = null;
let messagesIn = 0;
let unreadable = 0;
let unreadableSample = null;
let settled = false;
const UNREADABLE_LIMIT = 12;

/** Turn "it just hangs" into something actionable. */
function diagnoseStall() {
  if (loadError) return `the preview failed to load: ${loadError}`;
  if (messagesIn > 0) {
    // The shape of what did arrive is what fixes this, and is a dump of an
    // object in a status line, so it goes to the console.
    console.log(`[typst] unreadable message from the preview: ${unreadableSample || "unknown"}`);
    return "the preview is sending messages the panel cannot read " +
      `(${messagesIn} received).`;
  }
  // The preview puts its own bridge readout on screen once the panel has stayed
  // silent for a few seconds, which by here it has.
  return "no messages from the preview. If it shows \"uxpHost MISSING\", the " +
    "message bridge is off: check requiredPermissions.webview.enableMessageBridge " +
    "in manifest.json and re-add the plugin in UXP Developer Tools.";
}

let readyResolve;
let readyReject;
const readyPromise = new Promise((resolve, reject) => {
  readyResolve = resolve;
  readyReject = reject;
});
let readyTimer = null;
/** The resolved value, so callers can ask without awaiting a 60s timeout. */
let readyValue = null;

function post(message) {
  if (!webview) throw new Error("preview is not attached yet");
  webview.postMessage(JSON.stringify(message));
}

function call(message, timeout = CALL_TIMEOUT_MS) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("the Typst compiler did not respond"));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    try {
      post({ ...message, id });
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

function onMessage(event) {
  messagesIn++;
  const msg = extractMessage(event.data) || extractMessage(event);
  if (!msg) {
    if (!unreadableSample) unreadableSample = describeEvent(event);
    unreadable++;
    // If this many have arrived and not one parsed, the shape is wrong and
    // waiting out the full timeout tells us nothing new.
    if (unreadable >= UNREADABLE_LIMIT && !settled) {
      clearTimeout(readyTimer);
      readyReject(new Error(diagnoseStall()));
    }
    return;
  }

  if (msg.type === "ready") {
    clearTimeout(readyTimer);
    settled = true;
    // Tell the webview to stop re-announcing and drop its bridge readout.
    try { post({ type: "ack" }); } catch { /* nothing to lose */ }
    if (msg.error) {
      readyReject(new Error(msg.error));
    } else {
      readyValue = { engine: msg.engine, wasmSource: msg.wasmSource };
      readyResolve(readyValue);
    }
    return;
  }
  const entry = pending.get(msg.id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(msg.id);
  entry.resolve(msg);
}

/** Base64 (as it crosses the bridge) to bytes (as the filesystem wants them). */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const backend = {
  id: "typst",
  label: "Typst",
  assetFormat: "pdf",
  supportsPreamble: true,
  supportsFonts: true,

  /** Wire the backend to the panel's <webview> element. */
  attach(element) {
    webview = element;
    webview.addEventListener("message", onMessage);

    // We are otherwise blind to the webview: it has its own console, so a
    // failure to load looks identical to a slow compiler.
    for (const name of ["loaderror", "error"]) {
      try {
        webview.addEventListener(name, (event) => {
          loadError = String((event && (event.message || event.type)) || name);
        });
      } catch { /* this UXP version does not emit that event */ }
    }

    readyTimer = setTimeout(() => readyReject(new Error(diagnoseStall())), READY_TIMEOUT_MS);
    // The webview may finish booting before this listener exists, and a message
    // posted before the webview's script runs is simply dropped — so poll until
    // one of the two lands.
    const ping = setInterval(() => {
      try { post({ type: "ping" }); } catch { /* webview not up yet */ }
    }, PING_MS);
    readyPromise.then(() => clearInterval(ping), () => clearInterval(ping));
  },

  ready() {
    return readyPromise;
  },

  /**
   * Whether the compiler is up *right now*, without awaiting.
   * A menu command has no webview of its own — the compiler lives in the
   * panel's — so it needs to be able to ask rather than hang for the ready
   * timeout when the panel was never opened.
   */
  isReady() {
    return !!readyValue;
  },

  setTheme(theme) {
    if (webview) {
      try { post({ type: "theme", theme }); } catch { /* not attached yet */ }
    }
  },

  async setFonts(fonts) {
    const res = await call({ type: "fonts", fonts }, CALL_TIMEOUT_MS);
    if (!res.ok) {
      const first = (res.diagnostics || [])[0];
      throw new Error(first ? first.message : "could not load fonts");
    }
    return res.fontCount;
  },

  /**
   * @param {object} spec  { body, mode, size, color, preamble }
   * @param {{pdf?: boolean}} want
   */
  async render(spec, want = {}) {
    await readyPromise;
    const res = await call({ type: "render", spec, want });
    return {
      ok: !!res.ok,
      metrics: res.metrics || null,
      asset: res.pdfBase64
        ? { format: "pdf", bytes: base64ToBytes(res.pdfBase64) }
        : null,
      diagnostics: res.diagnostics || [],
    };
  },
};

module.exports = backend;
