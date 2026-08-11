/**
 * Shared plumbing for the headless tests: serve the plugin folder, run a driver
 * page in Chrome, collect whatever it POSTs back.
 */
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm",
};

export function requirements() {
  if (!existsSync(join(ROOT, "vendor", "typst_ts_web_compiler_bg.wasm"))) {
    console.error("vendor/ is empty — run `npm install && npm run setup` first.");
    process.exit(1);
  }
  if (!existsSync(CHROME)) {
    console.error(`no Chrome at ${CHROME}; skipping.`);
    process.exit(0);
  }
}

/**
 * Write `html` into the plugin root (so its module imports resolve on the same
 * origin), open it in headless Chrome, and resolve with the JSON it POSTs to
 * /__result.
 */
export async function drive(name, html, timeoutMs = 240_000) {
  const driverPath = join(ROOT, `.${name}.html`);
  await writeFile(driverPath, html);
  const profile = await mkdtemp(join(tmpdir(), `idt-${name}-`));

  let resolveResult;
  const gotResult = new Promise((r) => (resolveResult = r));

  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__result") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => { res.writeHead(204).end(); resolveResult(JSON.parse(body)); });
      return;
    }
    const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT) || !existsSync(file)) return res.writeHead(404).end("not found");
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${server.address().port}/.${name}.html`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (d) => (stderr += d));

  const result = await Promise.race([
    gotResult,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for the driver page")), timeoutMs)),
  ]).catch((e) => e);

  chrome.kill();
  server.close();
  await rm(driverPath, { force: true });
  // Chrome keeps writing its profile for a moment after SIGTERM, so removing it
  // can race. It lives in the temp dir either way — never fail the run over it.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (result instanceof Error) {
    console.error(result.message);
    if (stderr.trim()) console.error(stderr.trim().split("\n").slice(0, 10).join("\n"));
    process.exit(1);
  }
  return result;
}
