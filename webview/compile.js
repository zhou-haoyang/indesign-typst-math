/**
 * Thin wrapper around the typst.ts wasm compiler.
 *
 * Lives in the webview rather than the panel because UXP's JS engine is not a
 * browser: no WebAssembly, and its SVG renderer only handles simple icons.
 * Inside the webview we get real Chromium, so the compiler runs natively and
 * the preview is a genuine SVG rendering.
 *
 * We drive the compiler's world API directly instead of the `$typst.svg/pdf/
 * query` sugar, for two reasons:
 *
 *   1. `$typst.query()` is broken in typst.ts 0.7.0 — it snapshots a world
 *      without compiling it ("document is not compiled") and then JSON.parses
 *      an already-parsed value.
 *   2. One `world.compile()` can feed metrics, vector and PDF at once, instead
 *      of paying for three separate compiles of the same source.
 */
// Imported for the side effect of defining window.$typst, and for loadFonts,
// which is not exposed as a global.
import { loadFonts, TypstSnippet } from "../vendor/typst-all-in-one-lite.js";
import { buildSource } from "./template.js";

/**
 * Resolve against this module's own URL so the same code works whether the page
 * was loaded as `plugin:/webview/index.html` inside UXP or over http:// by the
 * headless tests.
 */
function assetUrl(relative) {
  try {
    return new URL(relative, import.meta.url).href;
  } catch {
    return relative;
  }
}

const WASM = {
  compiler: "typst_ts_web_compiler_bg.wasm",
  renderer: "typst_ts_renderer_bg.wasm",
};

/** Which strategy actually got the bytes; surfaced in the ready message. */
let loadedVia = null;

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Load a wasm module as *bytes*, trying the environments this page can run in.
 *
 * Two separate hazards, both invisible over plain http:
 *
 *  1. Handing typst.ts a `Response` routes into `WebAssembly.instantiateStreaming`,
 *     which rejects anything not served as `application/wasm`. wasm-bindgen has
 *     a fallback for that, but it is gated on the response `type` being
 *     `basic`/`cors`/`default`, which a non-http response is not — so it
 *     rethrows and startup dies with "Unexpected response MIME type". Passing a
 *     BufferSource skips the branch entirely.
 *
 *  2. UXP resolves a `plugin:/` page to a `file://` origin, where Chromium
 *     blocks fetch and XHR ("HTTP 0"). ES module imports still work, since that
 *     is how this very file was loaded — so a base64 sidecar module (written by
 *     scripts/vendor.mjs) is the guaranteed way in.
 *
 * Ordered cheapest first; the sidecar is only touched if the rest fail.
 */
async function wasmBytes(name) {
  const resolved = assetUrl(`../vendor/${name}`);
  const failures = [];
  // Set by the headless tests to exercise one strategy in isolation — over
  // http the first one always wins, so the fallbacks would never be covered.
  const only = globalThis.__IDT_WASM_STRATEGY || null;
  const wanted = (via) => !only || only === via;

  for (const [via, url] of [["plugin", `plugin:/vendor/${name}`], ["url", resolved]]) {
    if (!wanted(via)) continue;
    try {
      const response = await fetch(url);
      if (response.ok) {
        loadedVia = via;
        return await response.arrayBuffer();
      }
      failures.push(`${via}: HTTP ${response.status}`);
    } catch (err) {
      failures.push(`${via}: ${(err && err.message) || err}`);
    }
  }

  if (wanted("xhr")) try {
    const bytes = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", resolved);
      xhr.responseType = "arraybuffer";
      xhr.onload = () => (xhr.response ? resolve(xhr.response) : reject(new Error("empty")));
      xhr.onerror = () => reject(new Error("blocked"));
      xhr.send();
    });
    loadedVia = "xhr";
    return bytes;
  } catch (err) {
    failures.push(`xhr: ${(err && err.message) || err}`);
  }

  if (wanted("module")) try {
    const module = await import(`${resolved}.b64.js`);
    loadedVia = "module";
    return base64ToBytes(module.default).buffer;
  } catch (err) {
    failures.push(`module: ${(err && err.message) || err}`);
  }

  throw new Error(`could not load ${name} — ${failures.join("; ")}`);
}

/** How the wasm was obtained, for the status line. */
export function wasmSource() {
  return loadedVia;
}

const MAIN = "/main.typ";

let initialised = null;
let extraFonts = [];

/** Initialise (or, after a font change, rebuild) the compiler and renderer. */
export function init(force = false) {
  if (initialised && !force) return initialised;
  initialised = (async () => {
    const { $typst } = window;
    if (force) {
      // Fonts can only be registered at build time, so new fonts mean a new
      // compiler. `cc` has to go back to being a *builder function*: typst.ts
      // treats "not a function" as "already built" and would either refuse the
      // new init options or hand back the stale instance.
      $typst.setCompiler(TypstSnippet.buildLocalCompiler);
    }
    $typst.setCompilerInitOptions({
      getModule: () => wasmBytes(WASM.compiler),
      beforeBuild: extraFonts.length ? [loadFonts(extraFonts)] : [],
    });
    // The renderer knows nothing about fonts, so it is built once and kept.
    // Re-initialising it throws "renderer has been initialized".
    if (!force) {
      $typst.setRendererInitOptions({ getModule: () => wasmBytes(WASM.renderer) });
    }
    await $typst.getCompiler();
    await $typst.getRenderer();
    return true;
  })();
  return initialised;
}

/** Replace the set of user-supplied fonts and rebuild. Returns the font count. */
export async function setFonts(fonts) {
  extraFonts = (fonts || []).map((f) => base64ToBytes(f.data));
  initialised = null;
  await init(true);
  return extraFonts.length;
}

/* ------------------------------------------------------------- diagnostics */

/**
 * Map a diagnostic on the generated source back onto the user's expression.
 * Typst reports 0-indexed `line:column` in `range` ("2:16-2:16").
 */
function mapDiagnostic(d, src) {
  const m = String(d.range || "").match(/^(\d+):(\d+)/);
  const out = { severity: d.severity || "error", message: d.message || String(d) };
  if (!m) return out;
  const line = +m[1];
  const column = +m[2];
  if (line === src.bodyLine) {
    out.line = 1;
    out.column = Math.max(1, column - src.bodyColumn + 1);
  } else if (line > src.bodyLine) {
    out.line = line - src.bodyLine + 1;
    out.column = column + 1;
  } else if (src.preambleLines > 0 && line >= src.preambleLine &&
             line < src.preambleLine + src.preambleLines) {
    out.where = "preamble";
    out.line = line - src.preambleLine + 1;
    out.column = column + 1;
  } else {
    out.where = "template";
  }
  return out;
}

function parseDiagnostics(raw, src) {
  let list = raw;
  if (typeof list === "string") {
    try { list = JSON.parse(list); } catch { return [{ severity: "error", message: list }]; }
  }
  if (!Array.isArray(list)) return list ? [{ severity: "error", message: String(list) }] : [];
  return list.map((d) => mapDiagnostic(d, src));
}

function thrownToDiagnostics(err) {
  const text = String((err && err.message) || err);
  // The wasm layer stringifies Rust diagnostics; pull the messages out.
  const messages = [...text.matchAll(/message:\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return (messages.length ? messages : [text]).map((message) => ({ severity: "error", message }));
}

/* ------------------------------------------------------------------ base64 */

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/* ------------------------------------------------------------------ render */

/**
 * Compile one expression.
 *
 * @param {object} spec  body / mode / size / color / preamble
 * @param {{pdf?: boolean}} want
 * @returns {Promise<{ok: boolean, metrics?: {width, height, depth},
 *                    svg?: string, pdfBase64?: string, diagnostics: object[]}>}
 */
export async function render(spec, want = {}) {
  await init();
  const { $typst } = window;
  const src = buildSource(spec);

  if (!src.body) {
    return { ok: false, diagnostics: [{ severity: "info", message: "Nothing to render." }] };
  }

  const compiler = await $typst.getCompiler();
  compiler.addSource(MAIN, src.source);

  let out;
  try {
    out = await compiler.runWithWorld({ mainFilePath: MAIN }, async (world) => {
      const res = await world.compile({ diagnostics: "full" });
      const diagnostics = parseDiagnostics(res && res.diagnostics, src);
      if (res && res.hasError) return { diagnostics, failed: true };

      const metricsRows = await world.query({ selector: "<idt-metrics>", field: "value" });
      const row = Array.isArray(metricsRows) ? metricsRows[0] : metricsRows;
      const vector = world.vector({ diagnostics: "none" });
      const pdf = want.pdf ? world.pdf({ diagnostics: "none" }) : null;
      return {
        diagnostics,
        metrics: row && { width: +row.w, height: +row.h, depth: +row.d },
        vector: vector && vector.result,
        pdf: pdf && pdf.result,
      };
    });
  } catch (err) {
    return { ok: false, diagnostics: thrownToDiagnostics(err) };
  }

  if (out.failed) return { ok: false, diagnostics: out.diagnostics };
  if (!out.metrics || !(out.metrics.width > 0) || !(out.metrics.height > 0)) {
    return {
      ok: false,
      diagnostics: out.diagnostics.concat([
        { severity: "error", message: "Expression renders to an empty box." },
      ]),
    };
  }

  const result = { ok: true, metrics: out.metrics, diagnostics: out.diagnostics };
  try {
    result.svg = await $typst.svg({ vectorData: out.vector });
  } catch (err) {
    return { ok: false, metrics: out.metrics, diagnostics: thrownToDiagnostics(err) };
  }
  if (want.pdf) {
    if (!out.pdf || !out.pdf.length) {
      return {
        ok: false, metrics: out.metrics, svg: result.svg,
        diagnostics: [{ severity: "error", message: "PDF export produced no data." }],
      };
    }
    result.pdfBase64 = bytesToBase64(out.pdf);
  }
  return result;
}
