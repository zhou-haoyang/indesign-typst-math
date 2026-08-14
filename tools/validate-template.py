#!/usr/bin/env python3
"""Check the Typst template's depth arithmetic against rendered pixels.

The whole inline-anchoring design rests on one number: `depth`, the distance
from the maths baseline to the bottom edge of the page box. This renders each
expression next to an `H` (which has no descender, so the bottom of its ink is
exactly the baseline), measures where the ink actually falls, and compares that
with what the template reports.

Requires the `typst` CLI. Run: npm run validate-template
"""
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

PPI = 720.0            # 10 px per pt, so ±0.1pt resolution
PXPT = PPI / 72.0
SIZE = 40              # measure large; scale-invariant errors show up clearly
TOLERANCE_PT = 0.1     # at 40pt type

CASES = [
    "x", "x_j", "a/b", "sum_(i=1)^n x_i / 2", "integral_0^1 f(x) dif x",
    "mat(1, 2; 3, 4)", "cases(x &> 0, y &<= 1)", "sqrt(x^2 + y^2)",
    "vec(1, 2, 3)", "lim_(x -> oo) 1/x", "e^(i pi) + 1 = 0",
    "root(3, x) + sum_(k=0)^oo binom(n, k)",
]


def build_source(body, mode="inline", size=SIZE, extra_prefix=""):
    """Mirror of webview/template.js buildSource(), kept deliberately literal."""
    expr = f"box($ {body} $)" if mode == "display" else f"${body}$"
    strut = 1000
    return (
        "#set page(width: auto, height: auto, margin: 0pt, fill: none)\n"
        f'#set text(size: {size}pt, fill: rgb("#000000"), '
        'top-edge: "bounds", bottom-edge: "bounds")\n'
        f"#let __idt = {expr}\n"
        "#context [#metadata((w: measure(__idt).width.pt(), "
        "h: measure(__idt).height.pt(), "
        "d: (measure(__idt).height"
        f" - measure([#__idt#box(width: 0pt, height: 0pt, baseline: {strut}pt)]).height"
        f" + {strut}pt).pt())) <idt-metrics>]{extra_prefix}#__idt\n"
    )


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr.strip().splitlines()[0] if p.stderr.strip() else "failed")
    return p.stdout


def reported(body):
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "m.typ")
        with open(src, "w") as fh:
            fh.write(build_source(body))
        out = run(["typst", "query", src, "<idt-metrics>", "--field", "value"])
    return json.loads(out)[0]


def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat = 8, b""
    w = h = nch = None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and interlace == 0
            nch = {0: 1, 2: 3, 4: 2, 6: 4}[color]
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * nch
    rows, prev, p = [], bytearray(stride), 0
    for _ in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if ft == 1:
            for i in range(nch, stride):
                line[i] = (line[i] + line[i - nch]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - nch] if i >= nch else 0
                b, c = prev[i], (prev[i - nch] if i >= nch else 0)
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        rows.append(line); prev = line
    return w, h, nch, rows


def column_ink(w, h, nch, rows):
    bottom = [None] * w
    for y in range(h):
        line = rows[y]
        for x in range(w):
            base = x * nch
            if nch >= 3:
                if nch == 4 and line[base + 3] < 128:
                    continue
                lum = (line[base] * 299 + line[base + 1] * 587 + line[base + 2] * 114) // 1000
            else:
                if nch == 2 and line[base + 1] < 128:
                    continue
                lum = line[base]
            if lum < 128:
                bottom[x] = y
    return bottom


def measured(body):
    """True depth: page height minus the baseline, found from an `H`'s ink."""
    with tempfile.TemporaryDirectory() as d:
        src, png, svg = (os.path.join(d, n) for n in ("p.typ", "p.png", "p.svg"))
        with open(src, "w") as fh:
            fh.write(build_source(body, extra_prefix="H"))
        run(["typst", "compile", src, png, "--ppi", str(int(PPI))])
        run(["typst", "compile", src, svg])
        page_h = float(re.search(r'height="([0-9.]+)pt"', open(svg).read(400)).group(1))
        w, h, nch, rows = read_png(png)
        bottom = column_ink(w, h, nch, rows)
        xs = [x for x in range(w) if bottom[x] is not None]
        run_x = [xs[0]]
        for x in xs[1:]:
            if x - run_x[-1] > 4:
                break
            run_x.append(x)
        baseline = max(bottom[x] for x in run_x) / PXPT
    return page_h - baseline


def main():
    try:
        run(["typst", "--version"])
    except Exception:
        # Skipping locally is right — not everyone has the CLI. Skipping in CI
        # is not: this returns 0, so a runner without typst would report a pass
        # for the check on `depth`, the number inline anchoring rests on. The
        # release workflow installs the CLI before running this, but that is
        # another file's promise; $CI is what makes the check say so itself.
        if os.environ.get("CI"):
            print("typst CLI not found, and $CI is set — refusing to skip.")
            return 1
        print("typst CLI not found; skipping template validation.")
        return 0

    print(f"{'expression':38} {'reported':>9} {'measured':>9} {'delta':>7}")
    failures = 0
    for body in CASES:
        try:
            rep = reported(body)["d"]
            got = measured(body)
        except Exception as exc:  # noqa: BLE001 - surface whatever typst said
            print(f"{body:38} ERROR {exc}")
            failures += 1
            continue
        delta = rep - got
        flag = "" if abs(delta) <= TOLERANCE_PT else "  OUT OF TOLERANCE"
        if flag:
            failures += 1
        print(f"{body:38} {rep:9.3f} {got:9.3f} {delta:+7.3f}{flag}")

    print("\nall within tolerance" if not failures else f"\n{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
