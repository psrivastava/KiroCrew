#!/usr/bin/env python3
"""Recolor the CCrew brand PNGs from the upstream purple ghost to CCrew lime.

The dashboard tints the sidebar glyph in the DOM via a CSS filter, but that
filter never reaches the browser favicon (`<link rel=icon href=/logo.png>`) or
the desktop .app/Dock icon (icon.icns) — which is why those stay purple. This
script bakes the recolor into the raster assets so all three surfaces match.

Approach: per-pixel HSL hue REPLACEMENT (not hue-rotate). hue-rotate preserves
the purple's luminance and lands on a dark olive; a hue SET to lime plus a
lightness/saturation lift reproduces the bright Monokai lime (#a6e22e) the brand
uses. Neutral pixels (near-black outline, near-white, fully transparent) are left
alone so only the coloured ghost body shifts. Alpha is preserved.

Usage:  .venv/bin/python scripts/ccrew-tint-icons.py <in.png> <out.png>
"""
import colorsys
import sys

from PIL import Image

# Target lime = Monokai accent (#a6e22e). Its HSL hue/sat anchor the recolor.
_TR, _TG, _TB = 0xA6 / 255, 0xE2 / 255, 0x2E / 255
LIME_H, LIME_L, LIME_S = colorsys.rgb_to_hls(_TR, _TG, _TB)  # h≈0.22, l≈0.53, s≈0.76


def _recolor_pixel(r: int, g: int, b: int) -> tuple[int, int, int]:
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    # Leave near-neutral pixels (the black outline, white highlights, greys)
    # untouched: they carry no purple to convert, and shifting them muddies the
    # edges.
    if s < 0.12:
        return (r, g, b)
    # Set hue to lime. Pull saturation and lightness toward the lime anchor so a
    # dark purple body becomes a BRIGHT lime rather than a dark olive, while
    # keeping some of the pixel's own light/shade variation for depth.
    new_h = LIME_H
    new_s = min(1.0, s * 0.45 + LIME_S * 0.55)
    new_l = l * 0.45 + LIME_L * 0.55
    nr, ng, nb = colorsys.hls_to_rgb(new_h, new_l, new_s)
    return (round(nr * 255), round(ng * 255), round(nb * 255))


def tint(in_path: str, out_path: str) -> None:
    im = Image.open(in_path).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            nr, ng, nb = _recolor_pixel(r, g, b)
            px[x, y] = (nr, ng, nb, a)
    im.save(out_path)
    print(f"wrote {out_path} ({w}x{h})")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: ccrew-tint-icons.py <in.png> <out.png>")
    tint(sys.argv[1], sys.argv[2])
