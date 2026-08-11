#!/usr/bin/env node
/**
 * Verify every relative require/import resolves to a real file.
 *
 * UXP's module resolver is not Node's: it does **not** resolve a directory to
 * its `index.js`, so `require("../backends")` throws at runtime even though the
 * same line works fine under Node. Nothing else here catches that — the
 * headless tests never load the panel-side modules, because those require the
 * `indesign` module, which only exists inside InDesign.
 *
 *   node tools/check-requires.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Modules UXP provides; anything else non-relative is a mistake in a plugin. */
const HOST_MODULES = new Set(["uxp", "indesign", "fs", "os", "path", "photoshop"]);

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.js$/.test(p)) files.push(p);
  }
};
walk(join(ROOT, "src"));
walk(join(ROOT, "webview"));
files.push(join(ROOT, "main.js"));

const SPECIFIER = /(?:require\(\s*|(?:^|\s)from\s+|import\s*\(\s*)["']([^"'`]+)["']/g;

let failures = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(SPECIFIER)) {
    const spec = match[1];
    if (!spec.startsWith(".")) {
      if (!HOST_MODULES.has(spec)) {
        console.log(`  FAIL ${relative(ROOT, file)}: bare specifier "${spec}" ` +
          "— UXP has no node_modules at runtime");
        failures++;
      }
      continue;
    }
    const target = resolve(dirname(file), spec);
    const isFile = (p) => existsSync(p) && statSync(p).isFile();

    if (isFile(target) || isFile(`${target}.js`) || isFile(`${target}.mjs`)) continue;

    if (existsSync(target) && statSync(target).isDirectory()) {
      console.log(`  FAIL ${relative(ROOT, file)}: "${spec}" is a directory. ` +
        "UXP does not resolve directories to index.js — name the file.");
    } else {
      console.log(`  FAIL ${relative(ROOT, file)}: "${spec}" does not exist`);
    }
    failures++;
  }
}

console.log(failures
  ? `\n${failures} unresolvable specifier(s)`
  : `all specifiers in ${files.length} files resolve`);
process.exit(failures ? 1 : 0);
