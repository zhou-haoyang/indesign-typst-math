#!/usr/bin/env node
/**
 * Builds a `.ccx` — the zip Creative Cloud installs a UXP plugin from.
 *
 * There is no bundler here, so "packaging" is really three checks and an
 * archive: that the two version numbers agree, that vendor/ holds exactly what
 * `npm run setup` emits, and that nothing outside the runtime set gets in.
 *
 * The clean rebuild is the point rather than politeness. vendor/ is gitignored
 * and long-lived, so it accumulates: at the time this script was written it
 * still carried 588 KB of Spectrum Web Components left over from an experiment
 * that never shipped, which nothing references and `scripts/vendor.mjs` does
 * not produce. Deleting it and rebuilding is the only way to be sure the
 * bundle is what the build makes and not what the folder has collected.
 *
 *   node scripts/package.mjs
 *   node scripts/package.mjs --keep-vendor   # trust vendor/ as it stands
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Everything UXP loads, and nothing else. tools/, scripts/ and node_modules/
 * are unreachable at runtime; an include list rather than an ignore list is
 * what keeps them out for good, since a new stray file defaults to excluded.
 *
 * LICENSE is the exception that is not loaded by anything: the archive
 * redistributes Apache-2.0 wasm, whose licence text vendor.mjs puts in
 * vendor/licenses/, and shipping theirs while leaving ours out would be an odd
 * way round.
 */
const SHIP = ["manifest.json", "LICENSE", "index.html", "main.js", "icons", "src", "webview", "vendor"];

const keepVendor = process.argv.includes("--keep-vendor");

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const exists = (path) => stat(join(ROOT, path)).then(() => true, () => false);

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });

const json = async (path) => JSON.parse(await readFile(join(ROOT, path), "utf8"));

/* ------------------------------------------------------------- the versions */

const pkg = await json("package.json");
const manifest = await json("manifest.json");

if (manifest.version !== pkg.version) {
  fail(`version mismatch: manifest.json ${manifest.version}, package.json ${pkg.version}\n` +
    `Both have to move together — the manifest names the plugin to InDesign,\n` +
    `and package.json is what vendor/versions.json stamps into the About box.`);
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  fail(`version "${manifest.version}" is not x.y.z, which UXP requires.`);
}

/* --------------------------------------------------------- what it points at */

// A manifest icon path is a base name: UXP appends @1x/@2x per `scale`, so
// `icons/dark.png` with scale [1, 2] means two files, neither of them that one.
const iconFiles = (icon) => {
  const ext = extname(icon.path);
  const base = icon.path.slice(0, -ext.length);
  const scales = icon.scale?.length ? icon.scale : [1];
  return scales.map((s) => `${base}@${s}x${ext}`);
};

const wanted = [
  manifest.main,
  ...(manifest.icons ?? []).flatMap(iconFiles),
  ...(manifest.entrypoints ?? []).flatMap((e) => (e.icons ?? []).flatMap(iconFiles)),
];
const missing = [];
for (const path of wanted) if (!(await exists(path))) missing.push(path);
if (missing.length) {
  fail(`manifest.json points at files that do not exist:\n  ${missing.join("\n  ")}\n` +
    `(icons take an @1x/@2x suffix per their "scale")`);
}

/* -------------------------------------------------------------- the compiler */

if (keepVendor) {
  console.log("keeping vendor/ as it stands (--keep-vendor)");
} else {
  // Check node_modules before deleting anything: vendor.mjs exits non-zero
  // without it, and having removed vendor/ first would leave nothing to load.
  if (!(await exists("node_modules/@myriaddreamin"))) {
    fail("node_modules is not populated — run `npm install` first.");
  }
  console.log("rebuilding vendor/ from scratch");
  await rm(join(ROOT, "vendor"), { recursive: true, force: true });
  await run(process.execPath, [join(ROOT, "scripts", "vendor.mjs")]);
}

// vendor.mjs stamps this from package.json, so a mismatch means the rebuild
// did not happen — a stale versions.json is what the About box would show.
const stamped = await json("vendor/versions.json").catch(() => null);
if (!stamped) fail("vendor/versions.json is missing — run `npm run setup`.");
if (stamped.plugin !== pkg.version) {
  fail(`vendor/versions.json says plugin ${stamped.plugin}, package.json says ${pkg.version}.\n` +
    `Re-run \`npm run setup\` so the stamp matches, or drop --keep-vendor.`);
}

/* ---------------------------------------------------------------- the bundle */

for (const path of SHIP) {
  if (!(await exists(path))) fail(`missing: ${path}`);
}

const ccx = join("dist", `${manifest.id}-${manifest.version}.ccx`);
await mkdir(join(ROOT, "dist"), { recursive: true });
// zip *updates* an existing archive rather than replacing it, which would keep
// entries no longer in SHIP. Start from nothing.
await rm(join(ROOT, ccx), { force: true });

try {
  await run("zip", ["-q", "-r", "-X", ccx, ...SHIP, "-x", "*/.DS_Store", ".DS_Store"]);
} catch (error) {
  fail(`could not run zip: ${error.message}\n` +
    `Or package from UXP Developer Tools: the plugin's ⋯ menu → Package.`);
}

const { size } = await stat(join(ROOT, ccx));
console.log(`\n${ccx}  ${mb(size)}`);
console.log(`${manifest.name} ${manifest.version} · typst.ts ${stamped["typst.ts"]} · Typst ${stamped.typst}`);
console.log("\nInstalls on double-click via Creative Cloud. Run the tests first if you have not:");
console.log("  npm run test:all && npm run test:app");
