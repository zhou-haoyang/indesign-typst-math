# How it works

The parts that are more interesting than they look. For the build, the checks
and the release process, see [development.md](development.md).

## The shape of it

The panel is a UXP plugin — HTML and JavaScript running inside InDesign. UXP's
own JS engine has no WebAssembly and only a toy SVG renderer, so the Typst
compiler cannot live there. It lives in a `<webview>`, which is real Chromium,
and that webview does double duty: it hosts the compiler *and* it is the preview
surface. A render therefore returns metrics to the panel and paints the artwork
in the same call.

```
panel  ──── JSON message bridge ────►  webview
(UXP)                                  (Chromium)
  │                                      │
  │  spec: source, mode, size, colour    │  typst.ts (wasm)
  ◄── metrics {width, height, depth} ────┤  → PDF for placement
      + the PDF                          │  → SVG painted as the preview
  │
  ▼
InDesign DOM — place, format, embed, anchor, label
```

Rendering sits behind a backend contract (`src/backends/index.js`) that returns a
generic `asset` plus `{width, height, depth}` rather than "a PDF", because
MathJax — the likely next backend — produces SVG and no PDF at all.

## `depth` is the load-bearing number

InDesign anchors the **bottom edge of the frame** to the text baseline, and has
no idea where the maths baseline sits inside the artwork. Anything with a
descender would float high. So every inline equation needs a downward Y offset
equal to the artwork's depth below its own baseline — and Typst has no API that
reports it.

Two plausible routes are quietly wrong. `here().position()` on an inline marker
gives the line-box bottom. `measure()` with `bottom-edge: "baseline"` clamps at
the font's descender, which is short by 7.7 pt for `cases(..)` at 40 pt. What
works is forcing a descent deeper than any real content with a zero-size strut,
which exposes the ascent:

```
height(body + strut(D)) = ascent + D
height(body)            = ascent + depth
=> depth = height(body) - height(body + strut(D)) + D
```

`tools/validate-template.py` holds that honest: it renders each expression beside
an `H`, finds the baseline from that glyph's ink, and checks the reported depth
against it. It runs in the render suite (`npm test`), and directly with
`python3 tools/validate-template.py` — worth doing after touching
`webview/template.js`.

Also note `top-edge`/`bottom-edge: "bounds"`. Typst's default bottom edge is the
baseline, which makes an auto-height page clip every descender.

Applying that depth is its own problem, solved by measurement in
`src/id/baseline.js`. Two traps: the sign of `anchorYoffset` that means "down" is
not clearly documented, and **on the first line of a frame the baseline itself
moves** when a tall inline object moves — so the frame's own bottom-at-offset-0
is not a usable reference, which is why misalignment once appeared on first rows
only. The code reads the real baseline alongside the bounds, probes both signs,
and solves from the measured slope. Every insert logs the applied offset and the
residual:

```
[typst] inserted inline, depth 4.57 pt, Y offset +4.57, off by 0.00 (baseline: anchor)
```

A non-zero residual is the signal to look here.

## How the equation sits in the document

The artwork is a PDF, placed and then embedded, so the `.indd` carries no
external dependency. The expression and its settings live in a JSON record on the
frame's script label (`src/id/label.js`), which is the **only** source of truth —
nothing is recoverable from the artwork. It survives saving, closing and
copy/paste, which is what makes a pasted duplicate editable too.

Equation frames carry no object style, deliberately. A frame from `place()`
inherits the document's *current default* object attributes, and
`objectStyles.add()` captures those same defaults — so a plugin-owned style is
not a neutral container, it is a way to stamp whatever the defaults happened to
be (a 1 pt stroke, a corner radius) onto every equation. Frames are detached from
any style with `[None]`, their fill, stroke and corner options set explicitly,
and then read back, since these properties can refuse an assignment without
throwing.

Stroke weight is alignment-critical, incidentally: InDesign anchors the
*stroke-inclusive* bottom edge, so any weight shifts an equation by half of it —
even with colour None, when nothing is visible.

### What InDesign will not do

Once a frame is anchored, InDesign owns line breaking, justification, leading and
baseline-grid alignment, and the plugin does not interfere. But three things it
will not do for a placed graphic:

- **Vertical position** — see `depth`, above.
- **Size** — an anchored frame never scales with the surrounding type, so the
  point size is baked in at render time.
- **Colour** — placed vector artwork cannot be recoloured. (InDesign's native
  colorize path needs a grayscale image with an *opaque* background, which would
  put a white tile behind maths in running text.)

Because size and colour are baked, restyling body text leaves equations stale.
That is what **Re-render all** is for: equations recorded as `Match text` re-read
the point size and fill of the text they are anchored in, so the pass behaves as
a sync rather than a plain recompile.

A fixed colour is not read from anywhere — it is a Typst expression the user
typed — so `spec.color` is either `{space, values}` from a swatch or `{typst}`
from the box, and everything it passes through carries both. Nothing validates
the expression, because only Typst can: a bad one is a compile error, and a
compile error belongs to the preview.

## The preview outlines ink it would otherwise hide

The preview is the one place the artwork is seen against the panel's chrome
rather than the page it is going onto, and the two can be the same brightness:
black — InDesign's default ink — is all but invisible on the dark theme's
`#323232`. So when any ink falls below a WCAG contrast of 3 against the panel
background, the preview draws a thin outline in the theme's *text* colour behind
the artwork and says so in its status line. An outline nobody asked for otherwise
reads as the equation having one.

It is added to the painted SVG, **after** the compile that produced the metrics
and the PDF, which is what makes it preview-only by construction rather than by
remembering to strip it out. `tools/smoke-preview.mjs` pins that: the same
expression is rendered in both themes, the outline has to appear in one and not
the other, and the two PDFs have to be identical once the export metadata is
stripped.

Two measured facts shape the drawing. A rule — a fraction bar, a radical bar —
is a *stroked* path and cannot take a second stroke, while glyph outlines live in
a glyph space of their own; so this is one `feMorphology` dilate on the page
group rather than a stroke per element. And each text run is scaled by
`size/1000` from a glyph space of 1000 units to the em, so the run transforms
give the point size the artwork was actually drawn at, preamble overrides
included, and the outline is `0.015em` of that.

One more, because anything that positions itself against the SVG box will
otherwise be wrong: **the viewBox is not the page.** typst.ts rounds the page box
up to whole points in the markup it emits — a 34.53 × 12.39 pt page is written
`viewBox="0 0 35.000 13.000"` — and does not scale the contents to match, so the
artwork sits in the corner of a slightly larger box. A point of slack is 12% of
an 8 pt page. That is what drew the baseline guide half a point low, and it hid
for so long because the metrics agree with themselves. The preview now restates
the viewBox from the metrics.

## Getting the wasm into the webview

Harder than it sounds, and none of it reproduces over http — which is why
`tools/smoke-wasm-loading.mjs` forces each strategy in turn.

UXP resolves a `plugin:/` page to a `file://` origin, where Chromium blocks both
`fetch` and `XHR` (they fail as "HTTP 0"). ES module imports still work, since
that is how the webview's own scripts load, so `scripts/vendor.mjs` also emits
each wasm as a base64 ES module and `compile.js` falls back to importing it.

Separately, the bytes are passed to typst.ts as a `BufferSource` rather than a
`Response`. A `Response` routes into `WebAssembly.instantiateStreaming`, which
demands `application/wasm`; wasm-bindgen's fallback for that is gated on the
response `type` being `basic`/`cors`/`default`, which a non-http response is not,
so it rethrows instead of recovering.

Which strategy won (`wasm via module`, etc.) is logged at startup and shown in
Settings and About — the first thing to check if startup breaks after a UXP
update.

## The message bridge

UXP wraps webview messages in an envelope that carries its own `type`, so a
parser keying off `type` alone drops every message while the bridge itself is
perfectly healthy. `src/backends/message.js` therefore *searches* for the payload
— parsing strings and descending through the usual envelope keys — instead of
assuming a shape. `tools/test-messages.mjs` pins that down.

Because both sides can go silent without an error anywhere, the webview logs a
bridge readout with each announcement until the panel acknowledges a round trip:

```
[typst] bridge: uxpHost present · in 148 · out uxpHost
```

`uxpHost MISSING` means the bridge is off (a manifest problem); `in 0` means
panel→webview is not arriving; both healthy while the panel still complains means
the payload shape changed again. It stays in the console during a normal start,
and goes on screen only after four announcements go unanswered — by then it is a
fault rather than a slow start.

## What the status line is allowed to say

An operation that succeeded says nothing. The equation appearing in the document
is the feedback, and a panel that announces every success trains people to ignore
the line the failures also arrive on. So the status line carries errors, progress
while something is running, notes about the render (a spot colour approximated, a
preamble that has moved on), and exactly two things that are neither success nor
failure: that a placement landed on the page rather than inline, and that a
re-render found nothing to do — both of which are otherwise indistinguishable
from the command not working.

A compile error belongs to the preview, not to the panel: the webview has already
drawn it under the artwork that failed, so repeating it in the status line stacks
two copies of one Typst error in two formats. The panel reports a compile failure
only for the actions it owns, where the message answers a button press.
