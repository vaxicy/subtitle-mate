#!/usr/bin/env python3
"""Generate SubtitleMate store assets: icon + bilingual promo + screenshots.

All colors are read from the brand spec in subtitlemate-ai-prompt.md.
Outputs:
  icons/icon16.png, icon48.png, icon128.png
  store-assets/promo/440x280.png, 1400x560.png  (bilingual: EN + 中文 in one image)
  store-assets/screenshots/{zh,en}/screenshot-*.png
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "icons")
PROMO = os.path.join(ROOT, "store-assets", "promo")
SHOTS = os.path.join(ROOT, "store-assets", "screenshots")

PRIMARY = (0x58, 0x65, 0xF2)   # #5865F2
ACCENT = (0xFF, 0x4E, 0x6A)    # #FF4E6A
WHITE = (0xFF, 0xFF, 0xFF)
TEXT = (0x1F, 0x29, 0x37)
SECONDARY = (0x6B, 0x72, 0x80)
SOFT = (0xF5, 0xF6, 0xFA)
BTN = (0x58, 0x65, 0xF2)

FONT_DIR = r"C:\Windows\Fonts"
F_REG = os.path.join(FONT_DIR, "segoeui.ttf")
F_BOLD = os.path.join(FONT_DIR, "segoeuib.ttf")
F_CJK = os.path.join(FONT_DIR, "msyh.ttc")  # Microsoft YaHei


def font(size, bold=False, cjk=False):
    try:
        if cjk:
            return ImageFont.truetype(F_CJK, size)
        return ImageFont.truetype(F_BOLD if bold else F_REG, size)
    except Exception:
        return ImageFont.load_default()


def draw_center(d, cx, cy, s, f, fill):
    b = d.textbbox((0, 0), s, font=f)
    w = b[2] - b[0]
    h = b[3] - b[1]
    d.text((cx - w / 2 - b[0], cy - h / 2 - b[1]), s, font=f, fill=fill)


# ---------- Icon ----------
def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size, size], radius=r, fill=PRIMARY)
    # Speech bubble body
    m = int(size * 0.20)
    bw, bh = size - 2 * m, int(size * 0.42)
    bx, by = m, int(size * 0.18)
    d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=int(size * 0.12), fill=WHITE)
    # tail
    t = int(size * 0.12)
    d.polygon([(bx + int(bw * 0.30), by + bh - 1),
               (bx + int(bw * 0.30) + t, by + bh + t),
               (bx + int(bw * 0.30) + t, by + bh - 1)], fill=WHITE)
    # CC mark
    cy = by + bh / 2
    gap = int(size * 0.05)
    cw = int(size * 0.055)
    ch = int(size * 0.055)
    for i, cx in enumerate([bx + int(bw * 0.28), bx + int(bw * 0.55)]):
        d.rounded_rectangle([cx, cy - ch, cx + cw, cy + ch], radius=2, outline=PRIMARY, width=max(1, int(size * 0.012)))
        d.line([cx + 1, cy, cx + cw - 1, cy], fill=PRIMARY, width=max(1, int(size * 0.012)))
    # AI sparkle accent (top-right)
    sx, sy = size - m - int(size * 0.12), by + int(size * 0.02)
    sr = int(size * 0.05)
    d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=ACCENT)
    draw_center(d, sx, sy, "+", font(int(size * 0.10), bold=True), WHITE)
    return img


def gen_icons():
    os.makedirs(ICONS, exist_ok=True)
    for s in (16, 48, 128):
        make_icon(s).save(os.path.join(ICONS, f"icon{s}.png"), "PNG")
    print("icons generated")


# ---------- Promo ----------
def rounded_card(d, box, radius, fill):
    d.rounded_rectangle(box, radius=radius, fill=fill)


def draw_promo(w, h, filepath):
    """Draw bilingual promo tile with size-aware absolute positioning."""
    is_small = (w == 440)
    scale = w / 1400.0  # normalize to big promo baseline
    img = Image.new("RGB", (w, h), WHITE)
    d = ImageDraw.Draw(img)

    panel_w = int(w * 0.42)
    d.rectangle([0, 0, panel_w, h], fill=PRIMARY)

    # Decorative accents (subtle, bottom of panel)
    d.ellipse([panel_w - int(80*scale), h - int(110*scale), panel_w - int(20*scale), h - int(50*scale)], fill=ACCENT)
    d.ellipse([int(20*scale), h - int(80*scale), int(70*scale), h - int(30*scale)], fill=(0x6A, 0x72, 0xF3))

    # Icon
    ic_sz = int(56 * scale) if not is_small else int(34 * scale * (1400/440))
    ic = make_icon(ic_sz)
    img.paste(ic, (int(36*scale), int(36*scale)), ic)

    # Title (bilingual)
    title_en = "SubtitleMate"
    title_zh = "字幕助手"
    ty = int(120 * scale)
    draw_center(d, panel_w/2, ty, title_en, font(int(30*scale), bold=True), WHITE)
    draw_center(d, panel_w/2, ty + int(34*scale), title_zh, font(int(22*scale), cjk=True), (230, 233, 250))

    # Right side: headline + CTA (bilingual)
    rx = panel_w + int(48*scale)
    hy = int(80*scale)
    headline_en = "Auto captions & translation"
    headline_zh = "自动字幕与翻译"
    if is_small:
        # Small tile: drop body subtitle, larger headline, larger CTA
        d.text((rx, hy), headline_en, font=font(int(16*scale*(1400/440)), bold=True), fill=TEXT)
        d.text((rx, hy + int(22*scale*(1400/440))), headline_zh, font=font(int(13*scale*(1400/440)), cjk=True), fill=SECONDARY)
        btn_w, btn_h = int(140*scale*(1400/440)), int(34*scale*(1400/440))
        btn_y = h - int(26*scale*(1400/440)) - btn_h
        rounded_card(d, [rx, btn_y, rx + btn_w, btn_y + btn_h], int(7*scale*(1400/440)), BTN)
        bcx = rx + btn_w/2
        bcy = btn_y + btn_h/2 - int(5*scale*(1400/440))
        draw_center(d, bcx, bcy, "Add", font(int(12*scale*(1400/440)), bold=True), WHITE)
        draw_center(d, bcx, bcy + int(12*scale*(1400/440)), "添加", font(int(10*scale*(1400/440)), cjk=True), (220, 224, 250))
    else:
        d.text((rx, hy), headline_en, font=font(int(26*scale), bold=True), fill=TEXT)
        d.text((rx, hy + int(34*scale)), headline_zh, font=font(int(20*scale), cjk=True), fill=SECONDARY)
        sub_en = "Set it once, watch global videos forever."
        sub_zh = "一次设置，看懂全球视频。"
        sy = hy + int(78*scale)
        d.text((rx, sy), sub_en, font=font(int(15*scale)), fill=SECONDARY)
        d.text((rx, sy + int(22*scale)), sub_zh, font=font(int(15*scale), cjk=True), fill=SECONDARY)
        btn_w, btn_h = int(220*scale), int(48*scale)
        btn_y = h - int(56*scale) - btn_h
        rounded_card(d, [rx, btn_y, rx + btn_w, btn_y + btn_h], int(10*scale), BTN)
        bcx = rx + btn_w/2
        bcy = btn_y + btn_h/2 - int(8*scale)
        draw_center(d, bcx, bcy, "Add to Chrome", font(int(18*scale), bold=True), WHITE)
        draw_center(d, bcx, bcy + int(20*scale), "添加到 Chrome", font(int(14*scale), cjk=True), (220, 224, 250))

    img.save(filepath, "PNG")


def gen_promo():
    os.makedirs(PROMO, exist_ok=True)
    draw_promo(440, 280, os.path.join(PROMO, "440x280.png"))
    draw_promo(1400, 560, os.path.join(PROMO, "1400x560.png"))
    print("promo generated")


# ---------- Screenshots ----------
def draw_popup_mock(scale, lang):
    """Render the popup UI mockup card (transparent bg) used in screenshots."""
    w = int(360 * scale)
    h = int(460 * scale)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    card_w = int(360 * scale)
    card_x = 0
    card_y = 0
    pad = int(24 * scale)
    inner_x = card_x + pad
    inner_w = card_w - 2 * pad
    # calculate height dynamically
    y = int(22 * scale)
    y += int(50 * scale)       # header
    y += int(62 * scale)       # auto row
    y += int(20+38+54)*scale   # source lang
    y += int(20+38+54)*scale   # target lang
    y += int(30 * scale) * 2   # checks
    y += int(18 * scale)       # bottom pad
    card_h = y
    img = Image.new("RGBA", (int(card_w), int(card_h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rounded_card(d, [card_x, card_y, card_x + card_w, card_y + card_h], int(16*scale), WHITE)

    y = card_y + int(22 * scale)

    # header
    ic = make_icon(int(28*scale))
    img.paste(ic, (inner_x, y), ic)
    en = (lang == 'en')
    name = "SubtitleMate" if en else "字幕助手"
    d.text((inner_x + int(38*scale), y + int(4*scale)), name,
           font=font(int(17*scale), bold=True, cjk=not en), fill=TEXT)
    y += int(50 * scale)

    # auto captions row
    rounded_card(d, [inner_x, y, inner_x + inner_w, y + int(46*scale)], int(12*scale), SOFT)
    lbl = "Auto Captions" if en else "自动字幕"
    d.text((inner_x + int(14*scale), y + int(15*scale)), lbl,
           font=font(int(14*scale), cjk=not en), fill=TEXT)
    # toggle ON
    tw, th = int(42*scale), int(22*scale)
    tx, ty = inner_x + inner_w - tw - int(12*scale), y + int(12*scale)
    d.rounded_rectangle([tx, ty, tx+tw, ty+th], int(th/2), fill=PRIMARY)
    d.ellipse([tx+tw-th+2, ty+2, tx+tw-2, ty+th-2], fill=WHITE)
    y += int(62 * scale)

    def block(label):
        nonlocal y
        d.text((inner_x, y), label, font=font(int(12*scale), cjk=not en), fill=SECONDARY)
        y += int(20*scale)
        rounded_card(d, [inner_x, y, inner_x+inner_w, y+int(38*scale)], int(10*scale), WHITE)
        # filled down-chevron
        cx = inner_x + inner_w - int(20*scale)
        cy = y + int(19*scale)
        r = int(4*scale)
        d.polygon([(cx-r, cy-r+1), (cx, cy+r+1), (cx+r, cy-r+1)], fill=SECONDARY)
        y += int(54 * scale)

    block("Translation Language" if en else "字幕语言")
    block("Target Language" if en else "目标语言")

    # checks
    checks = ["Remember language preference", "Enable automatically on YouTube"] if en \
        else ["记住语言偏好", "在 YouTube 上自动启用"]
    for c in checks:
        d.ellipse([inner_x, y+int(2*scale), inner_x+int(16*scale), y+int(18*scale)], fill=PRIMARY)
        # white check mark
        d.line([(inner_x+int(5*scale), y+int(10*scale)), (inner_x+int(8*scale), y+int(13*scale))], fill=WHITE, width=max(1, int(2*scale)))
        d.line([(inner_x+int(8*scale), y+int(13*scale)), (inner_x+int(13*scale), y+int(6*scale))], fill=WHITE, width=max(1, int(2*scale)))
        d.text((inner_x + int(26*scale), y), c, font=font(int(13*scale), cjk=not en), fill=TEXT)
        y += int(30 * scale)

    return img


def gen_screenshots():
    scenes = {
        "screenshot-1-browser.png": ("Open a YouTube video — captions turn on automatically",
                                       "打开 YouTube 视频 — 字幕自动开启"),
        "screenshot-2-translate.png": ("Subtitle language switches to your target language",
                                         "字幕自动切换为你设定的目标语言"),
        "screenshot-3-popup.png": ("Popup shows your saved language preference",
                                    "弹窗显示已保存的语言偏好"),
    }
    W, H = 1280, 800
    for lang in ("en", "zh"):
        out_dir = os.path.join(SHOTS, lang)
        os.makedirs(out_dir, exist_ok=True)
        for fname, (cap_en, cap_zh) in scenes.items():
            img = Image.new("RGB", (W, H), (0xF0, 0xF1, 0xF6))
            d = ImageDraw.Draw(img)
            # browser chrome
            d.rectangle([0, 0, W, int(48*scale(1))], fill=(0xDE, 0xDF, 0xE6))
            d.rounded_rectangle([int(16), int(12), int(700), int(36)], int(8), fill=WHITE)
            d.text((int(28), int(16)), "youtube.com/watch", font=font(14), fill=SECONDARY)
            # YouTube stage
            stage = [int(60), int(80), W - int(60), int(470)]
            d.rectangle(stage, fill=(0x0F, 0x0F, 0x13))
            ic = make_icon(48)
            img.paste(ic, (W//2 - 24, int(250)), ic)
            # caption bar
            cb_y = stage[3] - int(70)
            d.rounded_rectangle([stage[0]+int(120), cb_y, stage[2]-int(120), cb_y+int(44)], int(8), fill=(0,0,0))
            cc_text = cap_en if lang == 'en' else cap_zh
            draw_center(d, W//2, cb_y+int(22), cc_text[:48], font(16, cjk=(lang=='zh')), WHITE)
            # popup mock (floating card, bottom-right corner)
            popup = draw_popup_mock(1.0, lang)
            px = W - popup.width - int(60)
            py = H - popup.height - int(40)
            img.paste(popup, (px, py), popup)
            # caption text bottom
            d.text((int(80), H - int(60)), cap_en if lang == 'en' else cap_zh,
                   font=font(18, cjk=(lang=='zh')), fill=TEXT)
            img.save(os.path.join(out_dir, fname), "PNG")
        print(f"screenshots generated: {lang}")


def scale(s):
    return s


if __name__ == "__main__":
    gen_icons()
    gen_promo()
    gen_screenshots()
    print("ALL ASSETS DONE")
