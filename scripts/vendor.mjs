#!/usr/bin/env node
/**
 * Copies the typst.ts runtime out of node_modules into vendor/.
 *
 * The plugin folder has to be self-contained for UXP to load it, but the wasm
 * is ~30 MB and has no business in git. `npm install && npm run setup` puts it
 * in place; vendor/ is gitignored.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modules = join(root, "node_modules", "@myriaddreamin");
const vendor = join(root, "vendor");

const FILES = [
  ["typst.ts/dist/esm/contrib/all-in-one-lite.bundle.js", "typst-all-in-one-lite.js"],
  ["typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm", "typst_ts_web_compiler_bg.wasm"],
  ["typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm", "typst_ts_renderer_bg.wasm"],
];

/** Upstream Typst version each typst.ts release compiles against. */
const TYPST_FOR = {
  "0.7.0": "0.14.2",
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

await mkdir(vendor, { recursive: true });

let total = 0;
for (const [from, to] of FILES) {
  const src = join(modules, from);
  try {
    await stat(src);
  } catch {
    console.error(`missing: ${src}\nRun \`npm install\` first.`);
    process.exit(1);
  }
  const dest = join(vendor, to);
  await copyFile(src, dest);
  const { size } = await stat(dest);
  total += size;
  console.log(`  ${to.padEnd(34)} ${mb(size).padStart(9)}`);
}
// Emit each wasm a second time as an ES module carrying base64.
//
// Inside UXP's webview a `plugin:/` page resolves to a `file://` origin, where
// Chromium blocks fetch() and XHR outright — but ES module imports still work,
// since that is how the webview's own scripts load. So this sidecar is the one
// way in that does not depend on a scheme handler. It is only imported if the
// cheaper fetch paths fail, and vendor/ is gitignored.
for (const [, name] of FILES.filter(([from]) => from.endsWith(".wasm"))) {
  const bytes = await readFile(join(vendor, name));
  const out = join(vendor, `${name}.b64.js`);
  await writeFile(out, `export default "${bytes.toString("base64")}";\n`);
  const { size } = await stat(out);
  total += size;
  console.log(`  ${(name + ".b64.js").padEnd(34)} ${mb(size).padStart(9)}`);
}

// Stamp the versions actually installed, so the panel can report them honestly
// instead of carrying a hardcoded string that drifts.
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const installed = JSON.parse(
  await readFile(join(modules, "typst.ts", "package.json"), "utf8"),
);
await writeFile(
  join(vendor, "versions.json"),
  JSON.stringify({ "typst.ts": installed.version, typst: TYPST_FOR[installed.version] ?? "unknown", plugin: pkg.version }, null, 2) + "\n",
);
console.log(`vendor/ ready (${mb(total)})`);
