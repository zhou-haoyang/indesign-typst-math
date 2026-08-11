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
| **Colour** | `Match text` reads the fill of the text at the cursor, CMYK values included |
| **Document preamble** | Typst prelude shared by every equation in the document — `#let` macros, `#set text(font: …)`, `#show` rules |
| **Fonts** | Extra `.otf`/`.ttf` files handed to the compiler, so maths can match a document set in something other than Typst's defaults |
| **Re-render all** | Recompiles every equation in the document |

To edit an equation, select it: the panel loads its source, and the button
becomes **Update**. Updating re-renders into the same frame, so its anchor point
in the text never moves.

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
src/ui/      panel controller, styles, font management
tools/       headless checks (see below)
```

Rendering sits behind a small backend contract (`src/backends/index.js`) that
returns an `asset` plus `{width, height, depth}`, rather than assuming a PDF —
MathJax, the likely next backend, produces SVG and no PDF at all.

No bundler: the folder loads into UXP as-is. The panel is CommonJS, the webview
is ESM.

### Checks

```sh
npm run check                      # module resolution, message envelopes, baseline offset
npm run validate-template          # depth arithmetic vs pixel-measured ground truth
node tools/smoke-webview.mjs       # wasm compiler vs the typst CLI, headless
node tools/smoke-preview.mjs       # message bridge, preview painting, diagnostics
node tools/smoke-wasm-loading.mjs  # each wasm-loading strategy in isolation
npm run test:indesign              # geometry, against a live InDesign
```

InDesign is also drivable ad hoc, which is the fastest way to settle a question
about its DOM:

```sh
node tools/probe-indesign.mjs                  # properties, anchoring, stroke
node tools/probe-indesign.mjs --scratch 'return J({ n: frame.lines.length });'
```

`test:indesign` drives the running InDesign over AppleScript (`tools/id.mjs`),
places real Typst PDFs in a scratch document and checks the whole chain: the
PDF page box becomes the frame size, the frame's bottom edge sits on the text
baseline at offset 0, and the depth offset lands the maths baseline on the text
baseline — on a first line and a later one, which behave differently. The
scratch document is closed without saving.

`npm run check` is the one to run after any refactor. UXP's module resolver is
not Node's — it will not resolve a directory to its `index.js` — and nothing
else catches that, because the headless tests never load the panel-side modules
(those require `indesign`, which only exists inside InDesign).

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

The panel's status line reports which strategy won (`wasm via module`, etc.) —
the first thing to check if startup breaks after a UXP update.

### The message bridge

UXP wraps webview messages in an envelope that carries its own `type`, so a
parser keying off `type` alone drops every message while the bridge itself is
perfectly healthy. `src/backends/message.js` therefore *searches* for our
payload — parsing strings and descending through the usual envelope keys —
instead of assuming a shape. `tools/test-messages.mjs` pins that down.

Because both sides can go silent without an error anywhere, the webview's status
line doubles as a bridge readout until the panel acknowledges a round trip:

```
bridge: uxpHost present · in 148 · out uxpHost
```

`uxpHost MISSING` means the bridge is off (manifest); `in 0` means panel→webview
is not arriving; both healthy while the panel still complains means the payload
shape changed again. The readout disappears once a round trip completes.

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
