# Development

Building, testing, packaging and releasing the plugin. For how the thing
actually works inside, see [internals.md](internals.md); for the environment
traps that cost the most debugging time, see [`CLAUDE.md`](../CLAUDE.md) in the
repository root.

## Running from source

Requires Node 18+, InDesign 2026 (21.4.1+) and
[UXP Developer Tools](https://developer.adobe.com/photoshop/uxp/2022/guides/devtool/).

```sh
npm install
npm run setup      # puts the Typst wasm in vendor/ (~65 MB, gitignored)
```

Then in UXP Developer Tools: **Add Plugin** → this folder's `manifest.json` →
**Load**.

**Changes to `manifest.json` (entrypoints, `requiredPermissions`) need the
plugin removed and re-added — Reload does not pick them up.** JS and CSS changes
only need Reload. Getting this wrong looks exactly like a code bug: the panel
loads and `entrypoints.setup()` throws "Could not find panel".

There is no bundler and no compile step. The folder loads into UXP as it stands;
`npm run setup` is the whole build.

## Layout

```
index.html + main.js   panel shell, entrypoints, flyout menu
src/ui/                the panel: store, view, actions, settings dialog, styles
src/backends/          the rendering-backend contract, and the Typst client
src/id/                everything that touches the InDesign DOM
webview/               the wasm compiler host and preview surface, and the
                       Typst source template
scripts/vendor.mjs     vendors typst.ts, and bakes the Spectrum theme colours
tools/                 the checks, and the probes
```

The UI splits along what needs the host. `actions.js` never touches a control —
it changes state and talks to InDesign or the compiler. `panel-view.js` never
talks to either — it draws the state and calls an action when the user asks for
something. Neither requires the other; `panel.js` joins them. The state itself is
a small observable store, and the decisions worth asserting live in pure modules
beside it (`status`, `spec`, `theme`, `selection`), which is what lets most of
the UI be tested under bare node.

The panel is CommonJS and the webview is ESM, so they cannot share modules —
which is why `webview/template.js` is reimplemented in Python inside
`tools/validate-template.py` on purpose, as an independent check.

Settings live in three scopes and three places: per equation on the frame's
script label, per document on the document's label (the preamble), and per user
in `localStorage` (fonts, defaults). A modal dialog draws over the panel, so
anything that needs the live preview has to stay in the panel — that line is
what decides where a new setting goes.

Rendering sits behind a small backend contract (`src/backends/index.js`) that
returns an `asset` plus `{width, height, depth}` rather than assuming a PDF —
MathJax, the likely next backend, produces SVG and no PDF at all.

## Checks

```sh
npm test              # unit + render — no app needed, ~6s
npm run test:all      # every suite, ~20s
npm run test:browser  # headless Chrome: wasm, preview, message bridge
npm run test:app      # the real plugin code, in a live InDesign
```

Suites are split by what they need (`tools/run-tests.mjs`): **unit** needs only
node, **render** needs the `typst` CLI, **browser** needs headless Chrome and a
populated `vendor/`, **app** needs InDesign running. Individual tests are
standalone scripts under `tools/` and can be run directly.

`npm test` is the one to run after any refactor. It includes a check that every
relative `require` resolves, because UXP's module resolver is not Node's — it
will not resolve a directory to its `index.js`. It also covers most of the panel,
including the two rules that no amount of looking will reliably catch: that a
focused editor is never rewritten underneath the person typing in it, and that a
half-typed decimal in the size field survives the state round trip.

`npm run test:app` is the interesting one. A UXP script shares the plugin's
module system, so the test drives the actual `src/id/*` code inside a live
InDesign over AppleScript rather than reimplementing it: placement, anchoring,
the baseline solve, labels, embedding and updating in place, all in a scratch
document that is closed without saving.

What no suite can cover is how the host actually behaves — whether UXP lays a
rule out, whether a widget honours a property, whether the result is legible.
Those need a reload and an eye.

## Probes

**InDesign is drivable from this shell**, and reaching for that first is worth
the habit: nearly every hard bug in this plugin was host behaviour that
contradicted the documentation, and several were guessed at three or four times
when one probe would have settled them.

```sh
node tools/probe-indesign.mjs                  # properties, anchoring geometry,
                                               # stroke — the standard report
node tools/probe-indesign.mjs --scratch 'return J({ n: frame.lines.length });'
node tools/probe-uxp-css.mjs position:sticky   # does the host implement this
                                               # CSS property, or drop it?
node tools/render-panel.mjs                    # screenshot index.html in
                                               # headless Chrome
node tools/shoot-indesign.mjs                  # photograph the real panel
```

`--scratch` runs the snippet in a throwaway document with `doc`, `page` and
`frame` in scope. `probe-uxp-css.mjs` matters more than it looks: UXP's CSS
parser silently discards properties it has not implemented, so a declaration
having no effect does not mean the value was wrong, and asking the host takes
seconds where theorising about it has taken days.

`render-panel.mjs` catches the mistakes that are yours — wrong order, a missing
label, a control with no spacing — in seconds rather than a plugin reload. It is
**not** a test of the panel: it is Chromium, and it is blind to the whole class
of bug this UI has actually had.

## Packaging

```sh
npm run package       # → dist/indesign-typst-<version>.ccx, ~25 MB
npm run package -- --keep-vendor   # skip the vendor/ rebuild
```

A `.ccx` is a zip with `manifest.json` at the top level. There is nothing to
compile, so the script is really three checks and an archive: that
`manifest.json` and `package.json` carry the same version (the first names the
plugin to InDesign, the second is what `vendor/versions.json` stamps into the
About box), that every file the manifest points at exists — icons take an
`@1x`/`@2x` suffix per their `scale`, so `icons/dark.png` names two files and
neither of them is that one — and that `vendor/` holds exactly what
`npm run setup` emits.

That last one is why it rebuilds `vendor/` from scratch rather than trusting it.
The folder is gitignored and long-lived, so it accumulates: it was carrying
588 KB of Spectrum Web Components from an experiment that never shipped, which
nothing references and `scripts/vendor.mjs` does not produce.

What ships is an include list — `manifest.json`, `LICENSE`, `index.html`,
`main.js`, `icons/`, `src/`, `webview/`, `vendor/` — not an ignore list, so a new
stray file is excluded by default rather than by remembering to exclude it. Both
copies of each wasm go in: the base64 sidecars are the fallback for when `fetch`
is blocked, not a build artefact.

`LICENSE` is the one entry nothing loads. The archive redistributes Apache-2.0
wasm, so `scripts/vendor.mjs` copies typst.ts's licence text into
`vendor/licenses/` alongside a generated `THIRD-PARTY.md` naming each vendored
component, its installed version and its declared licence. Two things there fail
the build rather than going quiet, because nothing downstream reads either file:
typst.ts no longer shipping a `LICENSE`, and any of the four packages declaring
something other than Apache-2.0 — which would make both that index and the
README's licence note wrong.

## Releasing

Publishing a GitHub release runs `.github/workflows/release.yml`, which builds
the `.ccx` on a runner and attaches it to that release. Nothing is committed for
it — the wasm is fetched from npm and vendored there — so a release is a tag and
nothing else. Running the workflow by hand does the same build and attaches
nothing, leaving the `.ccx` as a workflow artifact; that is how to test a change
to it without publishing anything.

One trap governs what is safe to put in that workflow: **a check that cannot find
its tool skips by exiting 0**, which on a runner is indistinguishable from a
check that ran and passed. `validate-template.py` does it without the `typst`
CLI and `tools/harness.mjs` does it without Chrome. Both are right locally and
wrong in CI, so the workflow installs Typst at the version `vendor/versions.json`
names and then asserts the binary reports it, and `requirements()` turns its skip
into an exit 1 when `$CI` is set. Before adding a check there, ask what it does
when its tool is missing — a green run that ran nothing is worse than a red one.

The tag has to be the manifest's version (`v0.1.0` for `0.1.0`), and the workflow
fails if it is not: InDesign shows one number and the release page shows the
other.

Everything but the app suite runs on the runner, including the browser one:
`$CHROME` aside, `tools/harness.mjs` finds Chrome in `/Applications` or under any
of its usual names on `PATH`, so a Linux runner needs no help. The app suite
needs a running InDesign, so it stays a local step before tagging:

```sh
npm run test:app
```

## Icons

Three variants of the Typst mark — the "t" from Typst's own wordmark
(`typst.app/assets/images/typst.svg`), rasterised by the `typst` CLI and set in a
canvas by hand:

| File | Size (@1x/@2x) | What it is | Where InDesign shows it |
| --- | --- | --- | --- |
| `icons/dark.png` | 23 / 46 | white mark, no background | panel tab, dark themes |
| `icons/light.png` | 23 / 46 | `#2C2C2C` mark, no background | panel tab, light themes |
| `icons/plugin.png` | 24 / 48 | white mark on Typst's green→teal gradient | the plugins list |

The two panel icons are the mark alone because the tab draws its own chrome, and
they are a flat colour rather than the brand gradient because they sit against
the panel's own background at 23px. The plugins-list icon is the badge, its
gradient and its 56%-of-the-square glyph lifted from Typst's app icon.
`manifest.json` states a size alongside each path, so moving off these pixel
sizes means editing it too.

## Updating Typst

Bump the three `@myriaddreamin/*` versions in `package.json`, add the matching
upstream Typst version to `TYPST_FOR` in `scripts/vendor.mjs`, then
`npm install && npm run setup` and re-run the checks. typst.ts 0.7.0 tracks
Typst 0.14.2.
