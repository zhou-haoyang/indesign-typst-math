# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An Adobe InDesign UXP plugin: write a maths expression in Typst, preview it, and
place it into the document as an editable anchored object. Typst compiles
in-plugin via WebAssembly; no `typst` binary is needed at runtime (though the CLI
is used by the checks).

**Before investigating anything that misbehaves inside InDesign, read
"Debugging: measure, don't guess" below.** The application is scriptable from
this shell, and most of the difficult bugs in this plugin's history were solved
only after someone stopped reasoning about InDesign and measured it instead.

## Commands

```sh
npm install && npm run setup   # setup populates vendor/ (~65 MB, gitignored)

npm test              # unit + render suites — no app needed, ~6s
npm run test:all      # every suite, ~20s
npm run test:browser  # headless Chrome: wasm, preview, message bridge
npm run test:app      # the real plugin code, in a live InDesign
npm run probe         # ask InDesign a question, see below
```

Suites are split by what they need (`tools/run-tests.mjs`): **unit** needs only
node, **render** needs the `typst` CLI, **browser** needs headless Chrome and a
populated `vendor/`, **app** needs InDesign running. Individual tests are
standalone scripts under `tools/` and can be run directly.

## Loading into InDesign

UXP Developer Tools → **Add Plugin** → this folder's `manifest.json` → **Load**.

**Changes to `manifest.json` (entrypoints, `requiredPermissions`) require
removing and re-adding the plugin — Reload does not pick them up.** JS/CSS
changes only need Reload. Getting this wrong looks exactly like a code bug: the
panel loads but `entrypoints.setup()` throws "Could not find panel".

## Debugging: measure, don't guess

**InDesign is drivable from this shell.** `tools/id.mjs` runs ExtendScript in
the running app over AppleScript and returns JSON, so DOM questions are
answerable in seconds:

```sh
node tools/probe-indesign.mjs                  # standard report: properties,
                                               # anchoring geometry, stroke
node tools/probe-indesign.mjs --scratch 'return J({ n: frame.lines.length });'
node tools/probe-indesign.mjs 'J({ v: app.version })'
```

`--scratch` runs the snippet inside a throwaway document with `doc`, `page` and
`frame` (a text frame containing text) in scope; it must `return` a JSON string,
and the document is closed without saving. Two helpers are always available:
`J(value)` serialises (ExtendScript has no `JSON`), and `probe(fn)` returns
`{ok, value}` or `{ok: false, error}` — the way to ask *does this property even
exist*.

Reach for this first. Nearly every hard bug in this plugin was InDesign
behaviour that contradicted the documentation, and several were guessed at
three or four times — costing a screenshot round-trip each — when one probe
would have settled them. If you catch yourself reasoning about what InDesign
"should" do, stop and measure it.

Two rules that follow from how those bugs hid:

- **A tolerant read turns a missing property into silent no-op.** `tryGet(() =>
  x.foo, null)` on a property that does not exist looks exactly like a property
  that is legitimately absent. `PageItem.storyOffset` throws, and because every
  call site swallowed it, three features did nothing at all for a long time
  without a single error. When a feature mysteriously does nothing, probe the
  properties it reads before re-reading its logic.
- **Assignments can be refused without throwing.** Read the value back. See
  `src/id/frame.js`, where the read-back is what exposed that assigning
  `strokeWeight = 0` can *set it to 1*.

### What the automated tests cover

`npm run test:app` runs the **real** `src/id/*` modules inside a live InDesign.
A UXP script shares the plugin's module system, so `tools/test-plugin.mjs`
`require`s the actual code rather than reimplementing it — placement, anchoring,
the baseline solve, labels, embedding, updating in place, and reading the
typographic context. That is the difference between testing the plugin and
testing a copy of it, and it is how the enum-comparison bug below was found.

The route is osascript → ExtendScript → `app.doScript(..., UXPSCRIPT)`, because
AppleScript refuses a `.idjs` directly. `tools/uxp.mjs` wraps it.

It also exercises the document preamble through the real DOM, which is the one
thing a mock cannot prove: `extractLabel` returns `""` both for a key that was
never set and for one holding an empty preamble.

Not covered: `src/ui/panel.js` and `src/ui/settings-dialog.js` (the controller
and the modal), which still need a human reloading the plugin — though
`src/ui/prefs.js` and the preamble envelope are covered headless by
`tools/test-prefs.mjs`, which stubs `localStorage` and the `indesign` module.
Everything under `webview/` is covered by the browser suite, being plain browser
code.

### Looking at the panel without InDesign

`node tools/render-panel.mjs [--width 340]` screenshots `index.html` in headless
Chrome into `.ui-shots/`, pulling the markup out of the real file so it cannot
drift. It catches the mistakes that are yours — wrong order, a missing label, a
control with no spacing — in seconds rather than a plugin reload.

**It is not a test of the panel, and it is blind to the whole class of bug this
UI has actually had**: `gap` that works in Chrome and collapses in UXP, a
`<button>` that ignores `background` and draws a native pill, a `<textarea>` in a
hidden subtree that never becomes focusable. Chrome shows none of those. Treat a
clean screenshot as "my markup is sane", never as "this works".

And read its own caveat before believing a negative: `--window-size` sets the
screenshot canvas, not the layout viewport, so the page is given an explicit
body width. Without that it lays out wide and the screenshot merely *crops* —
which reads convincingly as every right-aligned control having disappeared. When
a shot looks wrong, measure the geometry (`getBoundingClientRect` through
`tools/harness.mjs`) before changing any CSS.

### When the panel itself misbehaves

The webview has its own console, separate from the panel's, so a broken bridge
looks like silence on both sides. Two readouts exist for that and are worth
extending rather than deleting:

- the webview's status line doubles as a bridge readout
  (`bridge: uxpHost present · in 148 · out uxpHost`) until the panel acks;
- the panel reports the frame's actual read-back state when placement
  formatting fails, and the applied Y offset with its residual on every insert.

Panel status messages are also `console.log`ged with a `[typst]` prefix, which
survives the panel moving on.

## Architecture

```
index.html + main.js   panel shell, entrypoints, flyout menu
src/ui/panel.js        controller: editor, live preview, insert/update, tabs
src/ui/settings-dialog.js  the modal: fonts, defaults, engine info
src/ui/prefs.js        per-user settings in localStorage
src/ui/fonts.js        per-user extra font files
src/backends/          rendering-backend contract + the Typst client
src/id/                everything touching the InDesign DOM
webview/               the wasm compiler host, and the preview surface
scripts/vendor.mjs     copies typst.ts out of node_modules into vendor/
```

No bundler; the folder loads into UXP as-is. **Panel code is CommonJS, webview
code is ESM.** They cannot share modules — `webview/template.js` is duplicated in
Python inside `tools/validate-template.py` on purpose, so the check is an
independent implementation.

### Surfaces, and why settings are split the way they are

Three scopes, three homes, and the split is deliberate:

| Scope | Where it lives | Read by |
| --- | --- | --- |
| per equation | JSON on the frame's script label | `src/id/label.js` |
| per document | JSON envelope on the document's label | `readDocumentPreamble` |
| per user | `localStorage` | `src/ui/prefs.js`, `src/ui/fonts.js` |

**A modal dialog draws over the panel, so nothing that wants live preview can
live in one.** That is the whole reason the document preamble is a *tab* in the
panel rather than a section of the settings dialog: you edit `#let` macros and
`#set text(font: …)` while watching the preview. Fonts, the personal default
preamble and the new-equation defaults need no such feedback, so they are in the
dialog. Before moving anything between the two, check which side of that line it
falls on.

The preamble is per-document so a `.indd` still re-renders identically on someone
else's machine; the per-user default only *seeds* a document that has never had
one. That seeding is why `readDocumentPreamble` returns `{text, present}` rather
than a string — see the trap about `extractLabel` below.

InDesign offers a short menu of surfaces, and the ones not used here were
measured or researched rather than assumed:

- **panel flyout** (`menuItems` + `invokeMenu` in `main.js`) — runtime only, no
  manifest change. Static items only: InDesign does not reliably honour mutating
  a flyout after registration.
- **command entrypoints** — Plug-Ins ▸ Typst Math. A command has no webview of
  its own, so it reaches the compiler only through the panel's; `ensureCompiler`
  in `panel.js` waits a moment and then says so rather than hanging.
- **a second panel** — rejected. Adobe's model shares the *same* HTML document
  and JS context, so it buys no isolation, and InDesign has open bugs where the
  wrong panel loads and flyouts attach to the wrong panel.
- **right-click menu items** — do not work; see the trap below.

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

These cost several debugging rounds each and none reproduce outside the host
application. The InDesign ones are demonstrated by
`node tools/probe-indesign.mjs`.

- **`require` does not resolve directories** to `index.js`. Extensionless *file*
  paths are fine. `npm test` guards this.
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
- **UXP's CSS and native controls are not Chromium's, in ways that bite the
  panel.** Three met so far: `gap` on a flex row silently does nothing in some
  contexts (a label and its hint rendered as "FontsAdded to the compiler…"), so
  vertical rhythm in the dialog comes from margins; a `<button>` is drawn as a
  native pill that ignores `background`/`border`, so the tab strip is built from
  `<span>`s; and a `<textarea>` that spends its life inside a `display: none`
  subtree never becomes editable, which is why the two editor tabs share one
  textarea and swap its contents rather than hiding one.
- **A flyout `menuItems` entry without an `id` takes the commands down with it.**
  Every item needs one, *including a separator* — `{label: "-"}` is rejected with
  "'id' should be defined in menuItem object". Because `entrypoints.setup` may
  only be called once, the whole call fails, so the `commands` registered
  alongside the panel never register either: the menu items still appear (the
  manifest declares them) and simply do nothing. `main.js` now falls back to
  registering without the flyout rather than losing both.
- **`ScriptMenuAction` callbacks never fire in UXP.** `app.scriptMenuActions.add`,
  `addEventListener("onInvoke", …)` and `menus.item("Layout Context Menu")
  .menuItems.add(action)` all succeed, `eventListeners.length` reports the
  listeners, the action survives across script runs — and the handler is never
  called. Not synchronously, not later, not for `afterInvoke` or `beforeDisplay`,
  not with the listener on `app` instead, not when invoked through the menu
  item's `associatedMenuAction`. **The identical sequence in ExtendScript fires
  correctly**, which is how this was pinned down. So a plugin cannot put a
  working item on a context menu this way; use the flyout or a command
  entrypoint. (Measured on 21.4.1.4.)
- **UXP enum values do not compare with `===`.** `swatch.space` and
  `ColorSpace.CMYK` both stringify to "CMYK" and are still not equal, so a
  direct comparison silently fails every branch — which is how "match text
  colour" rendered everything black for a long time without an error. Use
  `sameEnum` from `src/id/doc.js`.
- **An embedded graphic is still a `Link`.** `link.unlink()` embeds it; the
  Link remains and its `status` becomes `LINK_EMBEDDED`. Checking for the
  absence of a link reports every insert as unembedded.
- **Applying an object style resets anchored-object settings**, so anchoring is
  the very last thing `placeNew`/`replaceIn` do. A clean-up pass placed after
  `anchorInline` silently wiped the baseline offset.

## Updating Typst

Bump the three `@myriaddreamin/*` versions in `package.json`, add the matching
upstream Typst version to `TYPST_FOR` in `scripts/vendor.mjs`, then
`npm install && npm run setup` and re-run the checks. typst.ts 0.7.0 tracks
Typst 0.14.2.
