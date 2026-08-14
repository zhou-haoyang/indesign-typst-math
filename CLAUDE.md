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

node tools/probe-uxp-css.mjs                   # does the host implement these
node tools/probe-uxp-css.mjs position:sticky   # CSS properties, or drop them?
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

The UI splits along what needs the host. `store`, `status`, `spec`, `theme`,
`selection` and the Spectrum token extractor are covered headless in the unit
suite (`tools/test-store.mjs`, `test-spec.mjs`, `test-theme.mjs`,
`test-selection.mjs`, `test-tokens.mjs`), as are `prefs` and the preamble
envelope (`test-prefs.mjs`) — all of them by stubbing `indesign`, `uxp` and
`localStorage` before the module under test loads, the way `test-prefs.mjs`
does. `panel-view.js` joins them via a small DOM stub (`test-view.mjs`), which
asserts *when* a control is written — the caret rules, the tab stack, which
editor holds which buffer — since that is where its regressions live.
Everything under `webview/` is covered by the browser suite, being plain
browser code.

Not covered: `actions.js` and `settings-dialog.js`, which need a human reloading
the plugin. Their *logic* has mostly been lifted into the pure modules above;
what is left is DOM wiring and orchestration. And no stub can say whether UXP
lays any of it out, whether a widget honours a property, or whether the result
is legible, so the checks worth doing by hand stay the same — type in each
editor and watch the caret, type a decimal into the size field, switch tabs,
select an equation, insert and watch the status line persist.

### Looking at the panel without InDesign

`node tools/render-panel.mjs [--width 340]` screenshots `index.html` in headless
Chrome into `.ui-shots/`, pulling the markup out of the real file so it cannot
drift. It catches the mistakes that are yours — wrong order, a missing label, a
control with no spacing — in seconds rather than a plugin reload.

**It is not a test of the panel, and it is blind to the whole class of bug this
UI has actually had**: `gap` that works in Chrome and collapses in UXP, a
`<button>` that ignores `background` and draws a native pill, a `<textarea>` in a
hidden subtree that never becomes focusable, a `<textarea>` with no caret.
Treat a clean screenshot as "my markup is sane", never as "this works".

And read its own caveat before believing a negative: `--window-size` sets the
screenshot canvas, not the layout viewport, so the page is given an explicit
body width. Without that it lays out wide and the screenshot merely *crops* —
which reads convincingly as every right-aligned control having disappeared. When
a shot looks wrong, measure the geometry (`getBoundingClientRect` through
`tools/harness.mjs`) before changing any CSS.

### When the panel itself misbehaves

The webview has its own console, separate from the panel's, so a broken bridge
looks like silence on both sides. The readouts for that are worth extending
rather than deleting, but they belong in the **console**, not on screen — a
status line is read by whoever is using the plugin, and a line of counters there
is noise at best and alarming at worst. Both consoles carry a `[typst]` prefix.

- the webview logs the bridge state on every announcement
  (`[typst] bridge: uxpHost present · in 148 · out uxpHost`), and puts it on
  screen only once the panel has failed to answer four announcements — by then
  it is a fault rather than a slow start;
- the panel logs the frame's actual read-back state when placement formatting
  fails, the applied Y offset with its residual on every insert, the worst
  residual across a re-render pass, and which wasm strategy won at startup.

Panel status messages are `console.log`ged too, which survives the panel moving
on.

**A compile error belongs to the preview, not to the panel.** In
`webview/main.js` the render case calls `paint()` before `send()`, on the same
object, so every failure the panel hears about has already been drawn under the
artwork that failed. Reporting it again stacked two copies of one Typst error
in two formats — and in one case two *different* wrong ones, since the panel
filters `info` diagnostics out and then falls through to "Could not render."
while the preview said "Nothing to render." The panel now logs them and stays
quiet. It still reports a compile failure for the actions it owns
(Insert/Update, re-render all), where the message answers a button press, and
for the `catch` around the render call, which is a bridge failure: there the
webview never replied and has painted nothing.

**The preview's own two lines must not agree with each other.** The stage and
the status line beneath it are two places to look, so saying one thing in both
is a wasted line — "Nothing to render." in the middle of the empty stage and
again underneath it read as two objections to one empty box. An `info`
diagnostic *is* the state of the stage, so `paint()` draws it there and hands
`showDiagnostics` the rest. What is left decides the line: the diagnostics if
there are any, otherwise the size of what was drawn, otherwise the engine
string it shows at rest. It is never blank: `tools/smoke-preview.mjs` checks
that of every failing case, along with the two lines differing, and pins the
fallback on the empty one.

**An operation that succeeded says nothing.** The equation appearing in the
document is the feedback, and a panel that announces every success trains
people to ignore the line the failures also arrive on. So the status line
carries errors, progress while something is running, notes about the render
(a spot colour approximated, a preamble that has moved on), and exactly two
things that are neither success nor failure: that a placement landed on the
page rather than inline, and that a re-render found nothing to do — both of
which are otherwise indistinguishable from the command not working. Anything
set while busy must be taken down by `setBusy(false)`, or a silent success
leaves "Inserting…" on screen reading as a hang.

## Architecture

```
index.html + main.js   panel shell, entrypoints, flyout menu
src/ui/panel.js        composition root: build store, actions and view, start
src/ui/panel-view.js   the panel's DOM: bind, wire, render from the store
src/ui/actions.js      preview, insert/update, selection, preamble, fonts
src/ui/store.js        the state, and who to tell when it changes
src/ui/status.js       what the status line is allowed to say  (pure)
src/ui/spec.js         panel state <-> render request  (pure)
src/ui/selection.js    finding the selected equation
src/ui/theme.js        which palette to paint in, and keeping it current
src/ui/widgets.js      the only module that knows what tag a control is
src/ui/settings-dialog.js  the modal: fonts, defaults, engine info
src/ui/prefs.js        per-user settings in localStorage
src/ui/fonts.js        per-user extra font files
src/backends/          rendering-backend contract + the Typst client
src/id/                everything touching the InDesign DOM
webview/               the wasm compiler host, and the preview surface
scripts/vendor.mjs     vendors typst.ts, and bakes the Spectrum theme colours
scripts/spectrum-theme.mjs  resolves Spectrum tokens to literal rgb()
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
bounds, probes both signs, and solves from the measured slope. Every insert logs
the applied offset and the residual (`[typst] inserted inline, depth 4.57 pt, Y
offset +4.57, off by 0.00 (baseline: anchor)`), and a re-render pass logs the
worst residual across the document. A non-zero residual is the signal to look
here.

### What InDesign will not do

Once anchored, InDesign owns line breaking, justification, leading and
baseline-grid alignment — don't interfere. But it will **not** scale an anchored
frame with the surrounding type, and it **cannot** recolour placed vector art. So
point size and colour are baked into the render, read from the text at the
insertion point. That is why "re-render all" exists: equations recorded as `auto`
re-read their context, making the pass a sync rather than a recompile.

A fixed colour is not read from anywhere: it is a **Typst expression the user
typed** (`red`, `rgb("#c00")`, or something the preamble names), so `spec.color`
is either `{space, values}` from a swatch or `{typst}` from the box, and
everything it passes through — `src/ui/spec.js`, the record in `src/id/label.js`,
`src/id/rerender.js`, `webview/template.js` — has to carry both. Nothing
validates the expression, because only Typst can: a bad one is a compile error,
and a compile error belongs to the preview. It is emitted **parenthesised** into
the `#set text(…)` line so that a stray comma cannot break out of the argument
list and turn a colour error into a baffling one about the template.

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
  strategies in order; which won is logged to both consoles and shown in
  Settings and About.
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
  panel.** Four met so far: `gap` on a flex row silently does nothing in some
  contexts (a label and its hint rendered as "FontsAdded to the compiler…"), so
  vertical rhythm in the dialog comes from margins; a `<button>` is drawn as a
  native pill that ignores `background`/`border`, so the tab strip is built from
  `<span>`s; a `<textarea>` that spends its life inside a `display: none`
  subtree never becomes editable, which is why the two editor tabs stack their
  controls and park the inactive one off-stage rather than hiding it.
- **Each editor tab owns its control; nothing is swapped in and out of one.**
  One shared `sp-textarea` was the earlier answer to the `display: none` trap
  above, and it let the tabs bleed into one another: the widget keeps whatever
  was typed into it and can refuse a `.value` write, so a swap could leave the
  previous tab's source on screen — and the next keystroke saved that text into
  the other buffer. Both editors now live in `.editor-stack`, absolutely
  positioned on top of each other at full size, and `.offstage` moves the
  inactive one 20000px to the left. Neither is ever hidden, neither is ever
  reloaded on a tab switch, and `tools/test-view.mjs` pins both. `position`,
  `top`, `left` and `opacity` were measured as implemented before being relied
  on (`node tools/probe-uxp-css.mjs`), and the editors state a width and height
  regardless, so that if positioning ever stops working the failure is loud —
  two editors down the panel — rather than two zero-size custom elements.
- **Prefer the native Spectrum widget, and accept that it is a sealed box.** The
  editors are `sp-textarea`, per Adobe's documented order (Spectrum Web
  Components, then `sp-*` widgets, then plain HTML) and by the maintainer's
  preference. It themes itself and draws its own caret. It also renders into a
  **closed** shadow root — `element.shadowRoot` is `null` — so its font,
  colours, caret and padding cannot be touched from outside, by host
  inheritance, by `::part`, or by injection. All three were measured, not
  assumed. **A monospace face for the Typst source is therefore not available,
  and that was decided knowingly**; do not add `font-family` or colour rules for
  these elements expecting them to land. Set the box and nothing else, because a
  custom element has no useful intrinsic size. SWC proper is not reachable here
  regardless: `document.createElement` does not work for it and it needs a build
  step this project deliberately does not have.
  Read and write the widget through the three helpers at the top of
  `src/ui/panel.js`, never `.value` directly; that is what has kept each swap of
  this control to two files.
- **The standard controls are already the native ones.** UXP extends a plain
  `<button>` and `<select>` with `uxpVariant` / `uxpQuiet` / `uxpSelected`
  properties, which is why they render as Spectrum controls with no `sp-*` tag
  in sight. Setting those (see `applyButtonVariants` in `src/ui/panel.js`) is
  the whole of what converting to `sp-button` would buy, and it keeps the CSS
  that sizes them — an `sp-*` widget's shadow root is closed, so
  `.font-list button { min-width }` would stop applying.
  Measured in this host, so as not to be re-probed: `sp-button`,
  `sp-action-button`, `sp-picker`, `sp-dropdown`, `sp-textfield` (including
  `type="number"` and `multiline`), `sp-textarea`, `sp-label` and `sp-checkbox`
  are implemented; **`sp-tabs` is not**, which is why the tab strip is `<span>`s
  and should stay that way. `sp-picker`/`sp-dropdown` accepted a `value` write
  and read back `undefined` when built inside a hidden container, so they
  probably need to be connected and laid out before their menu is usable —
  worth knowing before anyone converts the six `<select>`s.
  A plain `<input type="text">` holds and reports back an arbitrary string and
  honours `disabled`, which is what the colour box relies on. Its neighbour is
  the trap: `<input type="number">` **silently discards a value it cannot
  parse** — assigning `rgb("#cc0000")` to one leaves it reading `""` — so
  copying the point-size field's markup for anything else empties the box with
  no error anywhere.
  How to test this again, since three obvious approaches do not work here:
  `getBoundingClientRect` returns 0x0 outside the visible flow, `constructor
  .name` is unavailable on every element, and `customElements.get` denies
  `sp-textarea`, which demonstrably works — the Spectrum widgets are host
  built-ins, not registered custom elements. What does work is comparing an
  element's prototype against the one the host gives a **deliberately nonexistent
  hyphenated tag**. Always include that nonsense tag and a known-good control in
  any such probe; two versions of this one reported confident nonsense and were
  caught only by their controls.
- **UXP's CSS parser silently drops what it does not implement.** `caret-color`
  is discarded, exactly as the `monospace` generic is discarded from a font
  stack — ask for `Menlo, Monaco, Consolas, monospace` and it reports back
  `Menlo,Monaco,Consolas`. So a declaration having no effect here does **not**
  mean the value was wrong: check whether the *property* survives before
  theorising about the value. Ignoring that turned one editor-caret bug into
  four rounds of plausible, confidently-argued, wrong explanations.
  **That check takes seconds and needs no reload**: `node tools/probe-uxp-css
  .mjs position:sticky` asks the host directly. A UXP script has a document of
  its own — not the panel's, but the same CSS engine — so a declaration can be
  set and read back: a kept property round-trips through `element.style`, a
  dropped one reads back `undefined` there and `""` from `getComputedStyle`.
  It reports both an inline style and a real stylesheet, since the panel's CSS
  arrives the second way, and it carries `gap` and `caret-color` as controls so
  a broken probe says so instead of reporting everything kept. Measured this
  way so far: `position`, `top`, `left`, `opacity`, `z-index`, `overflow`,
  `transform`, `display`, `width`, `height`, `flex` and `min-height` are kept;
  `gap`, `caret-color`, `grid-template-columns` and `backdrop-filter` are
  dropped. What it cannot answer is whether a kept property lays out sensibly —
  that is still an eye and `tools/shoot-indesign.mjs`.
  Worth keeping if the editor ever goes back to a plain `<textarea>`: it draws
  no caret at all under `ui-monospace, SFMono-Regular, …` (Chromium/Apple
  keywords the host cannot resolve — name faces that exist), and once it does
  draw one it is the theme's text colour on the white background the control
  paints for itself on focus, so the element's own background and text have to
  be pinned per theme. Its `line-height` is irrelevant; that was a guess too.
- **One muted grey does not serve both themes.** The panel resolves the host's
  theme (see below) and stamps `spectrum--light`/`spectrum--dark` on `<body>`;
  the `--ui-*` colours are declared under those classes in
  `vendor/spectrum-theme.css`, generated at `npm run setup` from Adobe's own
  token ramps. **Consume them at `body` or below, never at `:root`** — the class
  is on `<body>` and `:root` is its *parent*, so a `:root` consumer silently
  resolves every `var()` to its fallback and nothing tracks the theme.
- **`gap` is not implemented, so all spacing comes from margins.** It computes
  to `null` in this host, which is how a label and its hint once rendered as
  "FontsAdded to the compiler…". There are no `gap` declarations left in
  `panel.css` and none should be added: a rule that works in Chrome and
  collapses in UXP is worse than no rule.
- **`flex-basis: 0`, not `auto`, is what makes a proportional split hold.** The
  editor and preview share the panel's leftover height 2:3 via `flex: 2 1 0` and
  `flex: 3 1 0` inside `.workspace`; with `auto` the intrinsic content sizes
  dominate and the ratio is ignored. Their container needs `min-height: 0` or
  the `min-height: auto` flex-item rule stops either from shrinking. The same
  shape gives the settings dialog a scrolling `.dlg-body` and a pinned
  `.dlg-footer` — and note that scrolling belongs to the body, not the
  `<dialog>`, or the footer scrolls away with everything else.
- **A native file picker cannot be opened from an open modal, on macOS.** The
  modal owns the application's modal loop, so `getFileForOpening` draws its
  dialog and then ignores every click in it — the picker looks frozen and the
  settings dialog behind it still has the focus. Nothing throws and nothing is
  logged. So "Add font files…" does not pick: it records a reason and closes,
  and `showSettings` opens the dialog in a **loop**, doing the picking between
  iterations with nothing modal on screen. Two consequences worth keeping if
  that loop is ever rewritten: whatever the picker has to say has to be carried
  back and shown after the reopen, because there is nowhere to say it meanwhile;
  and the compiler rebuild is started *unawaited* just after reopening, so
  "Rebuilding the compiler…" lands in a status line that is visible.
- **Getting the theme wrong is nearly silent.** `currentTheme()` matched
  `/dark|darkest|medium/` *case-sensitively* and fell back to `"light"` when the
  read threw, so a dark panel was served the light palette — and the symptom is
  not an error but a panel that is merely hard to read: light greys on light
  greys, a white preview, a white editor whatever the theme. It now matches
  case-insensitively, treats "light" explicitly, and when the host says nothing
  useful infers the theme from the luma of what it actually painted
  (`getComputedStyle(document.body).backgroundColor`). The panel logs
  `[typst] theme: "<raw>" → <resolved>`; check it before believing any
  theme-dependent colour is at fault.
- **`uxp.host.theme` is `undefined` in InDesign, and both fallbacks were dead
  too.** Measured on 21.4.1.4: `require("uxp").host.theme` is `undefined`
  (Adobe documents only `name`, `version`, `uiLocale` for ID), `require("uxp")
  .versions` is `{}`, and **`matchMedia` does not exist at all**, so
  `prefers-color-scheme` is not reachable either. `themeFromPaint()` cannot
  cover for it, because `getComputedStyle` here is a *specified*-value API: it
  returns an explicitly-set value correctly (`color: rgb(1,2,3)` reads back
  `rgb(1,2,3)`) but hands back `"initial"` for anything merely inherited or
  defaulted — so `document.body`'s `backgroundColor` is `"initial"` and the
  luma regex never matches. Trace `currentTheme()` with those two facts and it
  returns `"light"` unconditionally: **the panel served the light palette on a
  dark host, always.** That is the real cause of "some elements don't follow the
  theme", and it is invisible because each individual colour looks deliberate.
  What does work is asking the application:
  `require("indesign").app.generalPreferences.uiBrightnessPreference` — a number
  in 0..1, readable both over the scripting bridge and from inside the panel.
  **Its four presets are 0, 0.5, 0.51 and 1**, and the dark/light boundary falls
  between the middle two, so the test is `<= 0.5` → dark. Calibrated by setting
  each value and measuring the chrome: mean luma runs 0.61 · 0.67 · 0.86 · 0.95,
  and the 0.5 → 0.51 step is where InDesign's own labels flip from white to
  black. The property also *snaps* — writing 0.25 stores 0, writing 0.75 stores
  0.51 — which is how the preset values were found. Do not treat it as a
  continuous slider, and do not put the threshold at 0.75: 0.51 is a light
  theme, and the gap either side of the boundary is one hundredth.
- **Custom properties work in CSS but cannot be read back from JS.**
  `getComputedStyle(el).getPropertyValue("--x")` returns `""` even for a
  property a matching class demonstrably declares. `var()` substitution itself
  is fine — a `.spectrum--dark` div containing elements styled
  `background: var(--ui-accent)` paints correctly. So a theme value can be
  *used*, never *verified*, from script; verify with `tools/shoot-indesign.mjs`.
- **A plain element with no explicit colour renders black, whatever the theme.**
  Nothing inherits a sensible default from the host chrome, so an unstyled
  `<span>` is unreadable on a dark panel. Every plain text node needs a colour
  from the token layer.
- **The Spectrum typography widgets are real, and they refuse an inherited
  colour.** `sp-body`, `sp-heading`, `sp-detail` and `sp-label` are all
  implemented (as is `sp-divider`), and they paint themselves correctly for the
  host theme even when the panel's own CSS is wrong — in the probe that caught
  the bug above, they were the only white text on the dark panel. The catch:
  setting `color` on an ancestor does nothing to them. A parent forced to
  magenta turned a plain `<span>` magenta and left all four widgets white. **So
  they cannot be muted, and a hint cannot be an `sp-body`** — muted secondary
  text has to stay a plain element on a token colour. Their boxes also differ
  from the panel's 11px: heading 29px tall, label 25, body 24, detail 16.
  Measured with the prototype-vs-nonexistent-tag recipe below plus a
  screenshot; `sp-textarea` and `sp-tabs` were carried along as controls and
  both classified as expected.
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
- **`app.doScript` keeps only scalars out of what it returns.** A returned
  number arrives; a returned *object* arrives as an object with **no properties
  at all** — `Object.keys()` is `[]`, no throw, no warning. So the undo wrapper
  cannot pass a result back by returning it: `asOneUndo` assigns it to a closure
  variable inside the call instead, which survives intact, DOM proxies included.
  Getting this wrong is quiet and confusing rather than fatal — `{frame,
  anchored}` came back as `{}`, so every inline insert announced itself as
  "Inserted on the page", and the panel lost the frame it had just placed. It
  hid because the live test drove `placeNew` directly and never crossed the
  doScript boundary; the `undo-result` case in `tools/test-plugin.mjs` now does.
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
