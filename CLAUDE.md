# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An Adobe InDesign UXP plugin: write a maths expression in Typst, preview it, and
place it into the document as an editable anchored object. Typst compiles
in-plugin via WebAssembly; no `typst` binary is needed at runtime (though the CLI
is used by the checks).

## Commands

```sh
npm install && npm run setup   # setup populates vendor/ (~65 MB, gitignored)
npm run check                  # module resolution, message envelopes, baseline offset (fast)
npm run validate-template      # depth arithmetic vs pixel-measured ground truth
node tools/smoke-webview.mjs       # wasm compiler vs the typst CLI
node tools/smoke-preview.mjs       # message bridge, preview painting, diagnostics
node tools/smoke-wasm-loading.mjs  # each wasm-loading strategy in isolation
npm run test:indesign              # geometry, against a live InDesign
```

Each tool is standalone — run one directly rather than a suite runner. The
`smoke-*` ones drive headless Chrome via `tools/harness.mjs` and need
`vendor/` populated; `validate-template` needs the `typst` CLI.

## Loading into InDesign

UXP Developer Tools → **Add Plugin** → this folder's `manifest.json` → **Load**.

**Changes to `manifest.json` (entrypoints, `requiredPermissions`) require
removing and re-adding the plugin — Reload does not pick them up.** JS/CSS
changes only need Reload. Getting this wrong looks exactly like a code bug: the
panel loads but `entrypoints.setup()` throws "Could not find panel".

## What the checks do and do not cover

`src/` is not loadable by the headless tests: those modules `require("indesign")`,
which exists only inside InDesign.

**But InDesign itself is drivable from the shell** — `tools/id.mjs` runs
ExtendScript in the running app over AppleScript and returns JSON, so DOM
questions ("does this property exist", "which way does this move") are
answerable in seconds instead of by screenshot round-trip. `probe-indesign.mjs`
is the scratchpad for that; `test-indesign.mjs` is the standing geometry test.
Use it. Several bugs in this plugin survived multiple wrong guesses that one
probe would have settled.

Caveat: that channel is ExtendScript, not UXP. Layout behaviour is identical,
but which properties are *exposed* can differ, so treat property-existence
findings as strong evidence rather than proof for the plugin's own code.

`src/ui/` still needs a human reloading the plugin.

The webview side (`webview/`) *is* covered, because it is plain browser code.

## Architecture

```
index.html + main.js   panel shell and entrypoint
src/ui/panel.js        controller: editor, live preview, insert/update, settings
src/backends/          rendering-backend contract + the Typst client
src/id/                everything touching the InDesign DOM
webview/               the wasm compiler host, and the preview surface
scripts/vendor.mjs     copies typst.ts out of node_modules into vendor/
```

No bundler; the folder loads into UXP as-is. **Panel code is CommonJS, webview
code is ESM.** They cannot share modules — `webview/template.js` is duplicated in
Python inside `tools/validate-template.py` on purpose, so the check is an
independent implementation.

### The webview does double duty

It hosts the wasm compiler *and* is the preview surface. UXP's own JS engine has
no WebAssembly and only a toy SVG renderer, so both live in the `<webview>`,
which is real Chromium. A render therefore returns metrics to the panel *and*
paints in the same call. Panel↔webview is a JSON message bridge
(`src/backends/typst-wasm.js` ↔ `webview/main.js`).

### Backends

`src/backends/index.js` holds the contract and a name→module table. A backend
returns a generic `asset` plus `{width, height, depth}` rather than "a PDF",
because MathJax — the likely next backend — produces SVG and no PDF. Adding one
means a new module and a line in that table.

### `depth` is the load-bearing number

InDesign anchors the *bottom edge of the frame* to the text baseline and has no
idea where the maths baseline sits inside the artwork, so every inline equation
needs a downward Y offset equal to the artwork's depth below its baseline.

Typst has no baseline API, and two plausible routes are **wrong**:
`here().position()` on an inline marker gives the line-box bottom;
`measure()` with `bottom-edge: "baseline"` clamps at the font descender (short by
7.7 pt for `cases(..)` at 40 pt). What works is forcing a descent deeper than any
content with a zero-size strut to expose the ascent:

```
depth = height(body) - height(body + strut(1000pt)) + 1000pt
```

Also: Typst's default `bottom-edge` is the baseline, so an auto-height page
**clips every descender** unless both text edges are `"bounds"`.

`npm run validate-template` checks this against pixel-measured ink. If you touch
`webview/template.js`, run it.

Applying that depth is its own problem, solved by measurement in
`src/id/baseline.js` (free of InDesign imports, so
`tools/test-baseline-offset.mjs` can exercise it). Two traps:

- the sign of `anchorYoffset` that means "down" is not clearly documented;
- **on the first line of a frame the baseline itself moves** when a tall inline
  object moves, so the frame's own bottom-at-offset-0 is not a usable baseline
  reference — which is why misalignment appeared on first rows only.

So it reads the real baseline (`frame.storyOffset.baseline`) alongside the
bounds, probes both signs, and solves from the measured slope. The panel reports
the applied offset and the residual (`Y offset +2.46, off by 0.00 pt`), and the
re-render pass reports the worst residual across the document. A non-zero
residual is the signal to look here.

### What InDesign will not do

Once anchored, InDesign owns line breaking, justification, leading and
baseline-grid alignment — don't interfere. But it will **not** scale an anchored
frame with the surrounding type, and it **cannot** recolour placed vector art. So
point size and colour are baked into the render, read from the text at the
insertion point. That is why "re-render all" exists: equations recorded as `auto`
re-read their context, making the pass a sync rather than a recompile.

### Editability

A JSON record on the frame's script label (`src/id/label.js`) is the only source
of truth — nothing is recoverable from the artwork. It survives save/reopen and
copy/paste, so a pasted duplicate stays editable.

## Environment traps

These cost several debugging rounds each and none reproduce outside UXP.

- **`require` does not resolve directories** to `index.js`. Extensionless *file*
  paths are fine. `npm run check` guards this.
- **Webview local content** needs `src="plugin:/…"` (not a relative path) plus
  `requiredPermissions.webview.allowLocalRendering: "yes"`.
- **`plugin:/` resolves to a `file://` origin**, where Chromium blocks `fetch`
  and `XHR` ("HTTP 0"). ES module imports still work, so `scripts/vendor.mjs`
  also emits each wasm as a base64 ES module as a fallback. `compile.js` tries
  strategies in order and reports which won in the panel status line.
- **Pass wasm as a `BufferSource`, never a `Response`** — a Response routes into
  `instantiateStreaming`, and wasm-bindgen's MIME fallback is gated on a response
  `type` that `plugin:` does not produce.
- **UXP wraps webview messages in an envelope carrying its own `type`**, so
  `src/backends/message.js` *searches* for the payload instead of assuming a
  shape. `tools/test-messages.mjs` pins this down.
- **InDesign property assignments can be refused without throwing.** Set them one
  at a time — grouping means the first failure skips the rest — then read back
  and retry. `src/id/frame.js` is the worked example.
- **`objectStyles.add()` captures the document's current defaults**, so a
  plugin-owned object style is a way to stamp a stroke and corner radius onto
  every equation. Frames are detached with `[None]` and formatted explicitly.
- **`link.unlink()` (embedding) restores default frame attributes**, so
  formatting must be reapplied *after* embedding, not just before.
- **`PageItem.storyOffset` and `PageItem.parentStory` do not exist** despite
  appearing in scripting references — they throw. An anchored frame's anchor is
  its `parent`, which is a `Character`. All the anchor lookups live in
  `src/id/anchor.js`. Because the reads were tolerant, the throw was swallowed
  and three features silently did nothing for a long time.
- **Assigning `strokeWeight = 0` *creates* a 1pt stroke.** InDesign reads a
  weight assignment as "this object has a stroke" and substitutes the default;
  setting `strokeColor` afterwards settles it back to 0. So touch the stroke
  only when it is dirty, and always finish with the colour.
- **Stroke weight is alignment-critical.** InDesign anchors the
  *stroke-inclusive* bottom edge to the baseline, so any weight shifts an
  equation by half of it — even with colour None, when nothing is visible.
- **Applying an object style resets anchored-object settings**, so anchoring is
  the very last thing `placeNew`/`replaceIn` do. A clean-up pass placed after
  `anchorInline` silently wiped the baseline offset.

## Debugging approach

The webview has its own console, separate from the panel's, so a broken bridge
looks like silence on both sides. Two readouts exist for this and are worth
extending rather than replacing:

- the webview's status line doubles as a bridge readout
  (`bridge: uxpHost present · in 148 · out uxpHost`) until the panel acks;
- the panel reports the frame's actual read-back state when placement formatting
  fails.

When something InDesign-side misbehaves, add a readout rather than guessing —
guessing has a poor track record here.

## Updating Typst

Bump the three `@myriaddreamin/*` versions in `package.json`, add the matching
upstream Typst version to `TYPST_FOR` in `scripts/vendor.mjs`, then
`npm install && npm run setup` and re-run the checks. typst.ts 0.7.0 tracks
Typst 0.14.2.
