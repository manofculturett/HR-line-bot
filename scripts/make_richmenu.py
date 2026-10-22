#!/usr/bin/env python3
"""Generate the LINE rich-menu images for HR-line-bot.

LINE has no text-layout in a rich menu: the button labels are baked into the image, and
the tappable areas are declared separately (via OA Manager or the Messaging API). So the
image must be produced here.

Outputs (LINE's "compact" 2500x843 canvas):
    assets/richmenu-registered.png    3 panels: เข้างาน | เลิกงาน | สถานะของฉัน
    assets/richmenu-unregistered.png  1 panel:  ลงทะเบียน

Run:  python3 scripts/make_richmenu.py
"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 2500, 843
# Thonburi covers Thai; it has NO Latin glyphs (they come out as tofu boxes), so the
# English sub-labels use Helvetica instead.
FONT = "/System/Library/Fonts/ThonburiUI.ttc"
LATIN = "/System/Library/Fonts/Helvetica.ttc"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")

# LINE accepts two canvases. Everything below is laid out as fractions of H and the type
# is scaled by S, so the same code produces either size.
#   compact 2500x843   (one row of panels)
#   large   2500x1686  (taller panels)
S = 1.0


def set_canvas(height):
    global H, S
    H = height
    S = height / 843.0

BG = (255, 255, 255)
INK = (38, 42, 46)
MUTED = (128, 136, 144)
LINE = (228, 232, 236)


def font(size, bold=False):
    # ThonburiUI is a .ttc; index 0 is the regular face.
    try:
        return ImageFont.truetype(FONT, size, index=1 if bold else 0)
    except Exception:
        return ImageFont.truetype(FONT, size)


def font_latin(size):
    try:
        return ImageFont.truetype(LATIN, size, index=1)
    except Exception:
        return ImageFont.truetype(LATIN, size)


# A scratch canvas just for measuring text.
_measure = ImageDraw.Draw(Image.new("RGB", (8, 8)))


def fit_font(text, max_w, start_size, latin=False, bold=False):
    """Largest size whose rendered width still fits max_w.

    The large canvas is taller but NOT wider — the three panels are still 833px each — so
    scaling type by height alone makes long Thai labels overflow and clip. Always fit to
    the panel width.
    """
    size = max(14, int(start_size))
    while size > 14:
        f = font_latin(size) if latin else font(size, bold)
        l, _, r, _ = _measure.textbbox((0, 0), text, font=f)
        if (r - l) <= max_w:
            return f
        size = int(size * 0.94)
    return font_latin(14) if latin else font(14, bold)


def centered(d, box, text, f, fill):
    x0, y0, x1, y1 = box
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    d.text((x0 + (x1 - x0 - (r - l)) / 2 - l, y0 + (y1 - y0 - (b - t)) / 2 - t),
           text, font=f, fill=fill)


def check_icon(d, cx, cy, r, color):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    w = int(r * 0.22)
    d.line([(cx - r * 0.42, cy + r * 0.04), (cx - r * 0.10, cy + r * 0.36)], fill=BG, width=w)
    d.line([(cx - r * 0.10, cy + r * 0.36), (cx + r * 0.46, cy - r * 0.34)], fill=BG, width=w)


def out_icon(d, cx, cy, r, color):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    w = int(r * 0.20)
    d.line([(cx - r * 0.52, cy), (cx + r * 0.34, cy)], fill=BG, width=w)
    d.polygon([(cx + r * 0.54, cy), (cx + r * 0.16, cy - r * 0.32),
               (cx + r * 0.16, cy + r * 0.32)], fill=BG)


def clock_icon(d, cx, cy, r, color):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    w = int(r * 0.18)
    d.line([(cx, cy), (cx, cy - r * 0.52)], fill=BG, width=w)
    d.line([(cx, cy), (cx + r * 0.40, cy + r * 0.18)], fill=BG, width=w)


def person_icon(d, cx, cy, r, color):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    hr = r * 0.24
    d.ellipse([cx - hr, cy - r * 0.52 - hr, cx + hr, cy - r * 0.52 + hr], fill=BG)
    d.pieslice([cx - r * 0.46, cy + r * 0.02, cx + r * 0.46, cy + r * 0.86],
               start=180, end=360, fill=BG)


def panel(d, x0, y0, x1, y1, icon, color, thai, eng):
    """One tappable panel. Type is sized from the PANEL height, then shrunk to fit the
    panel WIDTH — a taller canvas must not make a long Thai label overflow sideways."""
    panel_w, panel_h = x1 - x0, y1 - y0
    icon(d, (x0 + x1) / 2, y0 + panel_h * 0.30, panel_h * 0.145, color)
    centered(d, (x0, y0 + panel_h * 0.48, x1, y0 + panel_h * 0.72),
             thai, fit_font(thai, panel_w * 0.86, panel_h * 0.135), INK)
    centered(d, (x0, y0 + panel_h * 0.73, x1, y0 + panel_h * 0.90),
             eng, fit_font(eng, panel_w * 0.86, panel_h * 0.055, latin=True), MUTED)


def build_registered():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    third = W / 3
    for i in range(1, 3):
        d.line([(third * i, H * 0.16), (third * i, H * 0.84)], fill=LINE, width=3)

    panel(d, 0, 0, third, H, check_icon,  (34, 160, 90),  "เข้างาน", "Check in")
    panel(d, third, 0, third * 2, H, out_icon, (232, 138, 32), "เลิกงาน", "Check out")
    panel(d, third * 2, 0, W, H, clock_icon, (96, 116, 132), "สถานะของฉัน", "My status")
    return img


def build_four():
    """The one menu to actually use: a 2x2 grid on the large canvas.

    Only ONE rich menu can be displayed at a time, so registration cannot live on a second
    menu — it needs its own button here. Five-across on the compact canvas would squeeze
    the Thai labels; 2x2 gives each panel 1250x843."""
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    hw, hh = W / 2, H / 2
    d.line([(hw, H * 0.06), (hw, H * 0.94)], fill=LINE, width=3)
    d.line([(W * 0.06, hh), (W * 0.94, hh)], fill=LINE, width=3)

    panel(d, 0, 0, hw, hh, check_icon,  (34, 160, 90),  "เข้างาน", "Check in")
    panel(d, hw, 0, W, hh, out_icon,    (232, 138, 32), "ออกงาน", "Check out")
    panel(d, 0, hh, hw, H, clock_icon,  (96, 116, 132), "สถานะของฉัน", "My status")
    panel(d, hw, hh, W, H, person_icon, (40, 110, 220), "ลงทะเบียน", "Register")
    return img


def build_unregistered():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([120, 120, W - 120, H - 120], radius=48, fill=(238, 245, 255))
    d.rounded_rectangle([120, 120, W - 120, H - 120], radius=48,
                        outline=(40, 110, 220), width=6)
    person_icon(d, W / 2, H * 0.36, H * 0.15, (40, 110, 220))
    centered(d, (0, H * 0.52, W, H * 0.74), "ลงทะเบียน",
             fit_font("ลงทะเบียน", W * 0.80, H * 0.135, bold=True), INK)
    centered(d, (0, H * 0.75, W, H * 0.90), "Register",
             fit_font("Register", W * 0.80, H * 0.055, latin=True), MUTED)
    return img


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', choices=['compact', 'large', 'both'], default='both',
                    help='compact=2500x843, large=2500x1686 (match your OA Manager template)')
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    variants = [('compact', 843)] if args.size == 'compact' else \
               [('large', 1686)] if args.size == 'large' else \
               [('compact', 843), ('large', 1686)]

    for label, height in variants:
        set_canvas(height)
        suffix = '' if label == 'compact' else '-large'
        outputs = [("richmenu-registered%s.png" % suffix, build_registered()),
                   ("richmenu-unregistered%s.png" % suffix, build_unregistered())]
        if height == 1686:      # a 2x2 grid only fits on the large canvas
            outputs.append(("richmenu-four.png", build_four()))
        for name, img in outputs:
            path = os.path.join(OUT, name)
            img.save(path, "PNG", optimize=True)
            print("%-58s %dx%d  %d bytes" % (path, img.width, img.height, os.path.getsize(path)))


if __name__ == "__main__":
    main()
