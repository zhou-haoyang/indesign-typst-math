# Typst Math for InDesign

A UXP panel for Adobe InDesign: write a maths expression in Typst, watch it
render, and place it into the document. With the text cursor in a story it goes
in as an **inline anchored object** sitting correctly on the baseline; otherwise
it lands as a frame on the page. Either way the expression stays **editable** —
select it and the panel loads its source back.

Typst compiles inside the panel via WebAssembly. Nothing is installed system-wide
and no `typst` binary is required at runtime.

## Setup

Requires InDesign 2026 (21.4.1+), Node 18+, and
[UXP Developer Tools](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/).

```sh
npm install
npm run setup      # puts the Typst wasm in vendor/ (~65 MB, gitignored)
```

Then in UXP Developer Tools: **Add Plugin** → pick this folder's `manifest.json`
→ **Load**. The panel appears under **Plugins › Typst Math**.

## Using it

Type an expression — the body of the maths, so `sum_(i=1)^n x_i / 2` rather than
`$sum_(i=1)^n x_i / 2$`, though pasting the `$…$` form works too. The preview
updates as you type and draws a dashed guide showing where the maths baseline
will land. `Cmd/Ctrl+Enter` inserts.

| Control | What it does |
| --- | --- |
| **Style** | `Inline` anchors on the baseline; `Display` anchors above the line, centred |
| **Size** | `Match text` reads the point size at the cursor; `Fixed` uses the value you set |
| **Colour** | `Match text` reads the fill of the text at the cursor, CMYK values included; `Fixed` takes a Typst colour of your own — `black`, `red`, `rgb("#cc0000")`, `cmyk(0%, 100%, 100%, 0%)`, or anything your preamble names |

On `Match text` the box beside the menu is a readout: it shows what was found at
the cursor — `24` pt, `cmyk(0%, 0%, 0%, 100%)` — which is what the next insert
will use. Switching that control to `Fixed` keeps the value it is showing, so
matching the text and then adjusting it is two clicks rather than a retype.
| **Preamble** tab | Typst prelude shared by every equation in *this document* — `#let` macros, `#set text(font: …)`, `#show` rules |

To edit an equation, select it: the panel loads its source, and the button
becomes **Update**. Updating re-renders into the same frame, so its anchor point
in the text never moves.

### Settings

The panel keeps the tight loop — type, look, insert — and everything else lives
one step away. The panel's flyout menu (**≡**) opens **Settings**; the same
actions are under **Plug-Ins ▸ Typst Math** so they work without the panel
open.

| Setting | Scope |
| --- | --- |
| **Fonts** | Extra `.otf`/`.ttf` files handed to the compiler, so maths can match a document set in something other than Typst's defaults. Per user |
| **Default preamble** | Seeds any document that has never had one. Per user |
| **New equations start as** | The style, size and colour a fresh equation opens with, instead of resetting every time the panel reloads. Per user |
| **Re-render all** | Recompiles every equation in the document |

The preamble stays in the panel rather than moving into Settings because a modal
dialog covers the preview, and editing macros is exactly when you want to watch
the result. It belongs to the document, not to you, so a file sent to a colleague
still renders the same; your personal default only fills in a document that has
none, and is written into that document when you insert the first equation. The
**•** on the Preamble tab means this document carries one.

## How it sits in the document

The artwork is a PDF, placed and then embedded, so the `.indd` carries no
external dependency. The expression and its settings live in the frame's script
label, which is what survives saving, closing and copy/paste — and is what makes
a pasted duplicate editable too.

Equation frames carry no object style, deliberately. A frame from `place()`
inherits the document's *current default* object attributes, and
`objectStyles.add()` captures those same defaults — so a plugin-owned style is
not a neutral container, it is a way to stamp whatever the defaults happened to
be (a 1pt stroke, a corner radius) onto every equation. Frames are detached from
any style and their fill, stroke and corner options are set explicitly, then
read back, since these properties can refuse an assignment without throwing.

### What InDesign handles, and what it cannot

Once a frame is anchored, InDesign owns line breaking, justification, leading and
baseline-grid alignment; the plugin does not interfere.

Three things it will not do for a placed graphic:

- **Vertical position** — InDesign anchors the *bottom edge of the frame* to the
  text baseline. It has no idea where the maths baseline is inside the artwork,
  so anything with a descender would float high. The plugin measures that depth
  in Typst and applies it as the anchored object's Y offset.
- **Size** — an anchored frame never scales with the surrounding type, so the
  point size is baked in at render time.
- **Colour** — placed vector artwork cannot be recoloured. (InDesign's native
  colorize path needs a grayscale image with an *opaque* background, which would
  put a white tile behind maths in running text.) So colour is baked in too.

Because size and colour are baked, restyling body text leaves equations stale.
That is what **Re-render all** is for: equations recorded as `Match text` re-read
the point size and fill of the text they are anchored in, so the pass behaves as
a sync rather than a plain recompile.

## Development

```
webview/     the compiler host and preview surface — real Chromium, so wasm and
             SVG work; also where the Typst source template lives
src/backends/ the rendering-backend contract, and the Typst client
src/id/      everything that touches the InDesign DOM
src/ui/      the panel: store, view, actions, settings dialog, styles
tools/       headless checks (see below)
```

The UI splits along what needs the host. `actions.js` never touches a control —
it changes state and talks to InDesign or the compiler. `panel-view.js` never
talks to either — it draws the state and calls an action when the user asks for
something. Neither requires the other; `panel.js` joins them. The state itself
is a small observable store, and the decisions worth asserting live in pure
modules beside it (`status`, `spec`, `theme`, `selection`), which is what lets
most of the UI be tested under bare node.

Settings live in three scopes and three places: per equation on the frame's
script label, per document on the document's label (the preamble), and per user
in `localStorage` (fonts, defaults). A modal dialog draws over the panel, so
anything that needs the live preview has to stay in the panel — that line is
what decides where a new setting goes.

Rendering sits behind a small backend contract (`src/backends/index.js`) that
returns an `asset` plus `{width, height, depth}`, rather than assuming a PDF —
MathJax, the likely next backend, produces SVG and no PDF at all.

No bundler: the folder loads into UXP as-is. The panel is CommonJS, the webview
is ESM. `npm run setup` vendors what cannot be checked in — the typst.ts wasm,
and the Spectrum theme colours, which are resolved from Adobe's token ramps to
literal `rgb()` at build time so that UXP's CSS parser never sees a `var()`
chain it might quietly drop.

### Checks

```sh
npm test              # unit + render — no app needed
npm run test:all      # every suite
npm run test:browser  # headless Chrome: wasm, preview, message bridge
npm run test:app      # the real plugin code, in a live InDesign
```

`npm test` is the one to run after any refactor: it includes a check that every
relative `require` resolves, because UXP's module resolver is not Node's — it
will not resolve a directory to its `index.js`. It also covers most of the
panel, including the two rules that no amount of looking will reliably catch —
that a focused editor is never rewritten underneath the person typing in it, and
that a half-typed decimal in the size field survives the state round trip.

What it cannot cover is anything about how the host actually behaves: whether
UXP lays a rule out, whether a widget honours a property, whether the result is
legible. Those need a reload, and `node tools/shoot-indesign.mjs` will
photograph the result. One question does not: UXP's CSS parser silently discards
properties it has not implemented, and `node tools/probe-uxp-css.mjs` asks the
running host which ones survive, so a rule that does nothing can be diagnosed
before anyone theorises about its value.

`npm run test:app` is the interesting one. A UXP script shares the plugin's
module system, so the test drives the actual `src/id/*` code inside a live
InDesign over AppleScript rather than reimplementing it: placement, anchoring,
the baseline solve, labels, embedding and updating in place, all in a scratch
document that is closed without saving.

### Packaging

```sh
npm run package       # → dist/indesign-typst-<version>.ccx, ~25 MB
```

A `.ccx` is a zip with `manifest.json` at the top level, which Creative Cloud
installs on double-click; UXP Developer Tools will make one too, from the
plugin's **⋯** menu. There is nothing to compile, so the script is really three
checks and an archive: that `manifest.json` and `package.json` carry the same
version (the first names the plugin to InDesign, the second is what
`vendor/versions.json` stamps into the About box), that every file the manifest
points at exists — icons take an `@1x`/`@2x` suffix per their `scale`, so
`icons/dark.png` names two files and neither of them is that one — and that
vendor/ holds exactly what `npm run setup` emits.

That last one is why it rebuilds vendor/ from scratch rather than trusting it.
The folder is gitignored and long-lived, so it accumulates: it was carrying
588 KB of Spectrum Web Components from an experiment that never shipped, which
nothing references and `scripts/vendor.mjs` does not produce. `--keep-vendor`
skips the rebuild when the wait is not worth it.

What ships is an include list — `manifest.json`, `index.html`, `main.js`,
`icons/`, `src/`, `webview/`, `vendor/` — not an ignore list, so a new stray
file is excluded by default rather than by remembering to exclude it. Both
copies of each wasm go in: the base64 sidecars are the fallback for when
`fetch` is blocked, not a build artefact.

### Icons

Three variants of the Typst mark — the "t" from Typst's own wordmark
(`typst.app/assets/images/typst.svg`), rasterised by the `typst` CLI and set in
a canvas by hand:

| File | Size (@1x/@2x) | What it is | Where InDesign shows it |
| --- | --- | --- | --- |
| `icons/dark.png` | 23 / 46 | white mark, no background | panel tab, dark themes |
| `icons/light.png` | 23 / 46 | `#2C2C2C` mark, no background | panel tab, light themes |
| `icons/plugin.png` | 24 / 48 | white mark on Typst's green→teal gradient | the plugins list |

The two panel icons are the mark alone because the tab draws its own chrome, and
they are a flat colour rather than the brand gradient because they sit against
the panel's own background at 23px. The plugins-list icon is the badge, its
gradient and its 56%-of-the-square glyph lifted from Typst's app icon. The pixel
sizes are the ones the placeholder set already used, and `manifest.json` states a
size alongside each path, so moving off them means editing it too.

### Releasing

Publishing a GitHub release runs `.github/workflows/release.yml`, which builds
the `.ccx` and attaches it to that release. Nothing is committed for it — the
wasm is fetched from npm and vendored on the runner, so a release is a tag and
nothing else. Running the workflow by hand does the same build and attaches
nothing, leaving the `.ccx` as a workflow artifact; that is how to test a change
to it without publishing something.

Two checks are there because they fail quietly otherwise. The tag has to be the
manifest's version (`v0.1.0` for `0.1.0`), since InDesign shows one and the
release page shows the other. And the Typst CLI is installed at the version
`vendor/versions.json` names, then checked — the render suite *skips* itself
when the CLI is missing and reports a pass while doing it, which on a runner
looks exactly like having run.

Everything but the app suite runs there, including the browser one: `$CHROME`
aside, `tools/harness.mjs` finds Chrome in `/Applications` or under any of its
usual names on `PATH`, so a Linux runner needs no help. That suite skips when it
finds none — and skipping is also an exit 0, so with `$CI` set it fails instead.
A green run that opened no browser is worse than a red one.

The app suite needs a running InDesign, so it stays a local step before tagging:

```sh
npm run test:app
```

### The depth measurement

`validate-template` is the check that matters most. Inline anchoring rests
entirely on `depth` — the distance from the maths baseline to the bottom of the page box —
and Typst has no API that reports it. Two plausible routes are quietly wrong:
`here().position()` on an inline marker gives the line-box bottom, and
`measure()` with `bottom-edge: "baseline"` clamps at the font's descender, which
is short by 7.7 pt for `cases(..)` at 40 pt. What works is forcing a descent
deeper than any real content with a zero-size strut to expose the ascent:

```
height(body + strut(D)) = ascent + D
height(body)            = ascent + depth
=> depth = height(body) - height(body + strut(D)) + D
```

`validate-template.py` renders each expression beside an `H`, finds the baseline
from that glyph's ink, and checks the reported depth against it. Also note
`top-edge`/`bottom-edge: "bounds"`: Typst's default bottom edge is the baseline,
which makes an auto-height page clip every descender.

### Getting the wasm into the webview

Harder than it sounds, and none of it reproduces over http — which is why
`smoke-wasm-loading.mjs` forces each strategy in turn.

UXP resolves a `plugin:/` page to a `file://` origin, where Chromium blocks both
`fetch` and `XHR` (they fail as "HTTP 0"). ES module imports still work, since
that is how the webview's own scripts load, so `scripts/vendor.mjs` also emits
each wasm as a base64 ES module and `compile.js` falls back to importing it.

Separately, the bytes are passed to typst.ts as a `BufferSource` rather than a
`Response`. A Response routes into `WebAssembly.instantiateStreaming`, which
demands `application/wasm`; wasm-bindgen's fallback for that is gated on the
response `type` being `basic`/`cors`/`default`, which a non-http response is
not, so it rethrows instead of recovering.

Which strategy won (`wasm via module`, etc.) is logged at startup and shown in
Settings and About — the first thing to check if startup breaks after a UXP
update.

### The message bridge

UXP wraps webview messages in an envelope that carries its own `type`, so a
parser keying off `type` alone drops every message while the bridge itself is
perfectly healthy. `src/backends/message.js` therefore *searches* for our
payload — parsing strings and descending through the usual envelope keys —
instead of assuming a shape. `tools/test-messages.mjs` pins that down.

Because both sides can go silent without an error anywhere, the webview logs a
bridge readout with each announcement until the panel acknowledges a round trip:

```
[typst] bridge: uxpHost present · in 148 · out uxpHost
```

`uxpHost MISSING` means the bridge is off (manifest); `in 0` means panel→webview
is not arriving; both healthy while the panel still complains means the payload
shape changed again. It stays in the console during a normal start, and goes on
screen only if four announcements go unanswered.

### Updating Typst

Bump the three `@myriaddreamin/*` versions in `package.json`, add the matching
upstream Typst version to `TYPST_FOR` in `scripts/vendor.mjs`, then
`npm install && npm run setup` and re-run the checks. typst.ts 0.7.0 tracks
Typst 0.14.2.

## Limitations

- `#import "@preview/…"` packages do not resolve. The compiler has no package
  registry wired up, which would need network permission in the manifest and a
  cache. Local `#let` macros, `#set` and `#show` rules in the preamble all work.
- Adobe Fonts cannot be added as font files — they are not readable as ordinary
  fonts on disk.
- Equations are re-rendered, never edited as vectors; the Typst source in the
  label is always the source of truth.
