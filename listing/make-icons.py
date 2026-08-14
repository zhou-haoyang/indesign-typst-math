#!/usr/bin/env python3
"""Build the icons Adobe Developer Distribution asks for: 48, 96 and 192 px.

    python3 listing/make-icons.py            # -> listing/icon-{48,96,192}.png

These are listing artwork, not plugin files: nothing here goes into the .ccx
(scripts/package.mjs ships an include list, so this folder is excluded by being
absent from it rather than by being ignored).

What it draws: an equation over a page of type — the maths on top, two lines of
text beneath, both ranged left off the same margin — which says "an InDesign
plugin" by showing what the plugin does rather than by borrowing Adobe's mark. That distinction matters: Adobe's
product icons cannot be used or altered in third-party artwork, and doing so is
grounds for rejection at review. The maths is rendered by the typst CLI, as the
icons in icons/ were, so the glyph is real Typst output in New Computer Modern
rather than a drawing of one.

The background is the shipped badge's own gradient, lifted from
icons/plugin@2x.png rather than re-modelled. Measuring it found a best-fit
linear axis of 56 degrees with an rms of 4/255 — the noise floor of a 48 px
source — so a two-stop approximation would be inventing detail that is not
there. The glyph and the corners cannot be lifted that way, being the parts
that have to stay sharp, so they are redrawn at each size; a gradient is the
one thing that scales without loss.

Corner radius is 20% of the square, measured off the same file: the 50% alpha
crossing on row 0 sits at x=6.5 of 48, which is r=9.6.

Needs: the typst CLI, and Pillow (`pip install pillow`). Neither is a runtime
dependency of the plugin; this is run by hand when the artwork changes.
"""

import math
import subprocess
import sys
from pathlib import Path
from statistics import median

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    sys.exit("this needs Pillow: pip install pillow")

HERE = Path(__file__).parent
BADGE = HERE.parent / "icons" / "plugin@2x.png"
SIZES = (48, 96, 192)

SS = 4              # supersample, then downsample once at the end
RADIUS = 0.20       # corner radius, as a fraction of the square
AXIS = 56           # the gradient's measured direction, degrees

EXPR = "x"          # what sits above the text
GLYPH = 0.34        # its height, as a fraction of the square
BOTTOM = 0.15       # the block is anchored bottom-left, on this margin and INSET
INSET = 0.15        # margin either side of the block
BAR = 0.052         # text line thickness
GAP = 0.055         # space between lines
LEAD = 0.08        # space between the maths and the first line
LINES = (1.0, 0.62)


def gradient(big):
    """The shipped badge's gradient, with glyph and soft corners taken out.

    Every pixel that is not solid background is replaced by the median of its
    band across the gradient axis, so what is scaled up is the full square with
    nothing of the old glyph or the antialiased corner left in it to smear.
    """
    img = Image.open(BADGE).convert("RGBA")
    w, h = img.size
    px = img.load()

    mask = Image.new("L", (w, h), 0)
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if min(r, g, b) > 200 and a > 76:
                mp[x, y] = 255
    mask = mask.filter(ImageFilter.MaxFilter(5))       # and its antialiased fringe
    mp = mask.load()

    th = math.radians(AXIS)
    cos, sin = math.cos(th), math.sin(th)
    band = lambda x, y: round(x * cos + y * sin)

    bands = {}
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 253 and not mp[x, y]:
                bands.setdefault(band(x, y), []).append(px[x, y][:3])
    medians = {k: tuple(median(c[i] for c in v) for i in range(3))
               for k, v in bands.items() if len(v) >= 4}
    known = sorted(medians)

    plate = Image.new("RGB", (w, h))
    pp = plate.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 253 and not mp[x, y]:
                pp[x, y] = (r, g, b)
            else:
                k = band(x, y)
                fill = medians.get(k) or medians[min(known, key=lambda j: abs(j - k))]
                pp[x, y] = tuple(int(round(v)) for v in fill)

    # Bicubic rather than Lanczos: there is no detail here to preserve, and
    # Lanczos would ring against the plate's edges.
    plate = plate.resize((big, big), Image.BICUBIC).convert("RGBA")

    corners = Image.new("L", (big, big), 0)
    ImageDraw.Draw(corners).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=RADIUS * big, fill=255)
    plate.putalpha(corners)
    return plate


def maths(big):
    """EXPR, white on transparent, GLYPH tall — rendered by the typst CLI."""
    src, png = HERE / ".expr.typ", HERE / ".expr.png"
    # Both edges must be "bounds". Typst's default bottom edge is the baseline,
    # so an auto-height page clips whatever hangs below it — which for an
    # italic x is the tail. webview/template.js sets the same two for the same
    # reason; this is that trap in miniature.
    src.write_text(
        "#set page(width: auto, height: auto, margin: 0pt, fill: none)\n"
        '#set text(fill: white, size: 120pt, top-edge: "bounds", '
        'bottom-edge: "bounds")\n'
        f"${EXPR}$\n")
    try:
        subprocess.run(["typst", "compile", "--format", "png", "--ppi", "400",
                        str(src), str(png)], check=True, capture_output=True)
    except FileNotFoundError:
        sys.exit("this needs the typst CLI on PATH")
    g = Image.open(png).convert("RGBA")
    g = g.crop(g.getchannel("A").getbbox())            # typst pads the page a little
    src.unlink(); png.unlink()

    height = round(GLYPH * big)
    return g.resize((max(1, round(g.width * height / g.height)), height),
                    Image.LANCZOS)


def mark(big):
    """The maths, then three lines of text under it."""
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    inset, span = INSET * big, big - 2 * INSET * big
    bar, gap = BAR * big, GAP * big

    glyph = maths(big)
    block = (glyph.height + LEAD * big
             + len(LINES) * bar + (len(LINES) - 1) * gap)
    y = big - BOTTOM * big - block          # whatever is left over falls above

    # Left edge on INSET, so the maths starts where the text does.
    layer.alpha_composite(glyph, (round(inset), round(y)))
    y += glyph.height + LEAD * big

    for width in LINES:
        draw.rounded_rectangle((inset, y, inset + span * width, y + bar),
                               radius=bar / 2, fill=(255, 255, 255, 255))
        y += bar + gap
    return layer


for size in SIZES:
    big = size * SS
    icon = gradient(big)
    icon.alpha_composite(mark(big))
    icon = icon.resize((size, size), Image.LANCZOS)

    path = HERE / f"icon-{size}.png"
    icon.save(path, optimize=True)
    print(f"{path.name}  {size}x{size}  {path.stat().st_size / 1024:.1f} KB")
