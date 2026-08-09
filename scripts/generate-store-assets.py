#!/usr/bin/env python3
"""Generate SubtitleMate store assets: icons, bilingual promo, screenshots.

Colors match popup.css (red brand).
Outputs:
  icons/icon16.png, icon48.png, icon128.png
  store-assets/promo/440x280.png, 1400x560.png (bilingual EN + 中文 in one image)
  store-assets/screenshots/{zh,en}/screenshot-*.png (1280x800 RGB)
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "icons")
PROMO = os.path.join(ROOT, "store-assets", "promo")
SHOTS = os.path.join(ROOT, "store-assets", "screenshots")

# Brand colors from popup.css
PRIMARY = (0xE5, 0x39, 0x35)      # #E53935
ACCENT = (0xFF, 0x3B, 0x30)       # #FF3B30
WHITE = (0xFF, 0xFF, 0xFF)
TEXT = (0x1F, 0x1F, 0x1F)
SECONDARY = (0x75, 0x75, 0x75)
SURFACE = (0xFF, 0xF5, 0xF5)
BORDER = (0xFF, 0xE0, 0xE0)
SOFT_BG = (0xF5, 0xF6, 0xFA)
STAGE_BG = (0x0F, 0x0F, 0x13)

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


# ---------- Icons ----------
ICON_SOURCE = os.path.join(ROOT, "store-assets", "icon-source.png")
_source_icon = None


def clean_icon_source(img):
    """Remove the decorative sparkle in the top-right corner of the source icon."""
    cleaned = img.copy()
    w, h = cleaned.size
    px = cleaned.load()
    x0, y1 = int(w * 0.70), int(h * 0.32)
    for y in range(y1):
        for x in range(x0, w):
            r, g, b, _ = px[x, y]
            px[x, y] = (r, g, b, 0)
    return cleaned


def make_icon(size):
    global _source_icon
    if _source_icon is None:
        _source_icon = clean_icon_source(Image.open(ICON_SOURCE).convert("RGBA"))
    return _source_icon.resize((size, size), Image.LANCZOS)


def make_toolbar_icon(source, target_size=16, fill_ratio=0.92):
    alpha = source.split()[-1]
    bbox = alpha.getbbox()
    if not bbox:
        return source.resize((target_size, target_size), Image.LANCZOS)
    content = source.crop(bbox)
    cw, ch = content.size
    scale = (target_size * fill_ratio) / max(cw, ch)
    new_w = max(1, int(round(cw * scale)))
    new_h = max(1, int(round(ch * scale)))
    scaled = content.resize((new_w, new_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (target_size, target_size), (0, 0, 0, 0))
    x = (target_size - new_w) // 2
    y = (target_size - new_h) // 2
    canvas.paste(scaled, (x, y), scaled)
    return canvas


def gen_icons():
    os.makedirs(ICONS, exist_ok=True)
    src = clean_icon_source(Image.open(ICON_SOURCE).convert("RGBA"))
    for s in (128, 48):
        src.resize((s, s), Image.LANCZOS).save(os.path.join(ICONS, f"icon{s}.png"), "PNG")
    make_toolbar_icon(src, 16, fill_ratio=0.92).save(os.path.join(ICONS, "icon16.png"), "PNG")
    print("icons generated")


# ---------- Promo ----------
def rounded_card(d, box, radius, fill):
    d.rounded_rectangle(box, radius=radius, fill=fill)


def draw_promo(w, h, filepath):
    """Draw bilingual promo tile with size-aware absolute positioning."""
    is_small = (w == 440)
    scale = w / 1400.0
    img = Image.new("RGB", (w, h), WHITE)
    d = ImageDraw.Draw(img)

    panel_w = int(w * 0.42)
    d.rectangle([0, 0, panel_w, h], fill=PRIMARY)

    # Decorative accents
    d.ellipse([panel_w - int(80*scale), h - int(110*scale), panel_w - int(20*scale), h - int(50*scale)], fill=ACCENT)
    d.ellipse([int(20*scale), h - int(80*scale), int(70*scale), h - int(30*scale)], fill=(0xF5, 0x6A, 0x6A))

    # Icon on a white rounded card for contrast against the red panel
    if is_small:
        ic_sz = int(54 * scale * (1400/440))
        pad = int(10 * scale * (1400/440))
    else:
        ic_sz = int(120 * scale)
        pad = int(18 * scale)
    card_x = int(36 * scale)
    card_y = int(36 * scale)
    card_sz = ic_sz + pad * 2
    card_radius = int(card_sz * 0.22)
    rounded_card(d, [card_x, card_y, card_x + card_sz, card_y + card_sz], card_radius, WHITE)
    ic = make_icon(ic_sz)
    img.paste(ic, (card_x + pad, card_y + pad), ic)

    # Title — placed below the icon card (English brand name only)
    title_en = "SubtitleMate"
    ty = card_y + card_sz + int(28 * scale)
    draw_center(d, panel_w/2, ty, title_en, font(int(34*scale), bold=True), WHITE)

    # Right side: headline + CTA
    rx = panel_w + int(48*scale)
    hy = int(80*scale)
    headline_en = "Auto-enable captions"
    headline_zh = "自动开启字幕"
    if is_small:
        d.text((rx, hy), headline_en, font=font(int(16*scale*(1400/440)), bold=True), fill=TEXT)
        d.text((rx, hy + int(22*scale*(1400/440))), headline_zh, font=font(int(13*scale*(1400/440)), cjk=True), fill=SECONDARY)
        btn_w, btn_h = int(140*scale*(1400/440)), int(34*scale*(1400/440))
        btn_y = h - int(26*scale*(1400/440)) - btn_h
        rounded_card(d, [rx, btn_y, rx + btn_w, btn_y + btn_h], int(7*scale*(1400/440)), PRIMARY)
        bcx = rx + btn_w/2
        bcy = btn_y + btn_h/2 - int(5*scale*(1400/440))
        draw_center(d, bcx, bcy, "Add", font(int(12*scale*(1400/440)), bold=True), WHITE)
        draw_center(d, bcx, bcy + int(12*scale*(1400/440)), "添加", font(int(10*scale*(1400/440)), cjk=True), (255, 220, 220))
    else:
        d.text((rx, hy), headline_en, font=font(int(26*scale), bold=True), fill=TEXT)
        d.text((rx, hy + int(34*scale)), headline_zh, font=font(int(20*scale), cjk=True), fill=SECONDARY)
        sub_en = "Set it once, captions work on every video."
        sub_zh = "一次设置，每部视频自动出字幕。"
        sy = hy + int(78*scale)
        d.text((rx, sy), sub_en, font=font(int(15*scale)), fill=SECONDARY)
        d.text((rx, sy + int(22*scale)), sub_zh, font=font(int(15*scale), cjk=True), fill=SECONDARY)
        btn_w, btn_h = int(220*scale), int(48*scale)
        btn_y = h - int(56*scale) - btn_h
        rounded_card(d, [rx, btn_y, rx + btn_w, btn_y + btn_h], int(10*scale), PRIMARY)
        bcx = rx + btn_w/2
        bcy = btn_y + btn_h/2 - int(8*scale)
        draw_center(d, bcx, bcy, "Add to Chrome", font(int(18*scale), bold=True), WHITE)
        draw_center(d, bcx, bcy + int(20*scale), "添加到 Chrome", font(int(14*scale), cjk=True), (255, 220, 220))

    img.save(filepath, "PNG")


def gen_promo():
    os.makedirs(PROMO, exist_ok=True)
    draw_promo(440, 280, os.path.join(PROMO, "440x280.png"))
    draw_promo(1400, 560, os.path.join(PROMO, "1400x560.png"))
    print("promo generated")


# ---------- Popup mockup ----------
def draw_popup_mock(lang):
    """Render the popup UI mockup card (transparent bg) used in screenshots."""
    scale = 1.25
    card_w = int(230 * scale)
    pad = int(10 * scale)
    inner_x = pad
    inner_w = card_w - 2 * pad

    # Calculate height top-down
    y = 0
    y += int(22 * scale)          # top padding
    y += int(30 * scale)          # header
    y += int(6 * scale)           # margin
    y += int(46 * scale)          # auto row
    y += int(6 * scale)           # margin
    y += int(60 * scale)          # caption mode block
    y += int(6 * scale)           # margin
    y += int(70 * scale)          # target lang block
    y += int(2 * scale)           # margin
    y += int(38 * scale)          # checks
    y += int(10 * scale)          # top margin before support
    y += int(10 * scale)          # border padding
    y += int(16 * scale)          # support link
    y += int(10 * scale)          # bottom padding
    card_h = y

    img = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    rounded_card(d, [0, 0, card_w, card_h], int(10*scale), WHITE)  # match real popup border radius

    en = (lang == 'en')
    y = int(22 * scale)

    # header
    ic = make_icon(int(22*scale))
    img.paste(ic, (inner_x, y), ic)
    name = "SubtitleMate"
    d.text((inner_x + int(28*scale), y + int(4*scale)), name,
           font=font(int(15*scale), bold=True, cjk=not en), fill=TEXT)
    # lang switch pill
    switch_w = int(58 * scale)
    switch_h = int(22 * scale)
    switch_x = card_w - pad - switch_w
    rounded_card(d, [switch_x, y, switch_x + switch_w, y + switch_h], int(6*scale), SURFACE)
    d.rectangle([switch_x, y, switch_x + switch_w, y + switch_h], outline=BORDER, width=1)
    d.text((switch_x + int(8*scale), y + int(4*scale)), "EN / 中文",
           font=font(int(10*scale), cjk=True), fill=SECONDARY)
    y += int(30 * scale) + int(6 * scale)

    # auto captions row
    rounded_card(d, [inner_x, y, inner_x + inner_w, y + int(46*scale)], int(10*scale), SURFACE)
    lbl = "Auto-enable captions" if en else "自动开启字幕"
    d.text((inner_x + int(12*scale), y + int(14*scale)), lbl,
           font=font(int(13*scale), bold=True, cjk=not en), fill=TEXT)
    tw, th = int(40*scale), int(22*scale)
    tx = inner_x + inner_w - tw - int(10*scale)
    ty = y + int(12*scale)
    d.rounded_rectangle([tx, ty, tx+tw, ty+th], int(th/2), fill=PRIMARY)
    d.ellipse([tx+tw-th+2, ty+2, tx+tw-2, ty+th-2], fill=WHITE)
    y += int(46 * scale) + int(6 * scale)

    # caption mode block
    d.text((inner_x, y), "Caption mode" if en else "字幕模式",
           font=font(int(11*scale), cjk=not en), fill=SECONDARY)
    y += int(20 * scale)
    rounded_card(d, [inner_x, y, inner_x + inner_w, y + int(38*scale)], int(8*scale), WHITE)
    d.rectangle([inner_x, y, inner_x + inner_w, y + int(38*scale)], outline=BORDER, width=1)
    cm_text = "Translated captions" if en else "翻译字幕"
    d.text((inner_x + int(10*scale), y + int(10*scale)), cm_text,
           font=font(int(13*scale), cjk=not en), fill=TEXT)
    # chevron
    cx = inner_x + inner_w - int(18*scale)
    cy = y + int(19*scale)
    r = int(4*scale)
    d.polygon([(cx-r, cy-r+1), (cx, cy+r+1), (cx+r, cy-r+1)], fill=SECONDARY)
    y += int(38 * scale) + int(6 * scale)

    # target lang block
    d.text((inner_x, y), "Translation language" if en else "翻译语言",
           font=font(int(11*scale), cjk=not en), fill=SECONDARY)
    y += int(14 * scale)
    hint = "Only in Translated-captions mode" if en else "仅在「翻译字幕」模式下生效"
    d.text((inner_x, y), hint, font=font(int(10*scale), cjk=not en), fill=SECONDARY)
    y += int(20 * scale)
    rounded_card(d, [inner_x, y, inner_x + inner_w, y + int(38*scale)], int(8*scale), WHITE)
    d.rectangle([inner_x, y, inner_x + inner_w, y + int(38*scale)], outline=BORDER, width=1)
    tl_text = "Chinese (Simplified)" if en else "中文（简体）"
    d.text((inner_x + int(10*scale), y + int(10*scale)), tl_text,
           font=font(int(13*scale), cjk=not en), fill=TEXT)
    d.polygon([(cx-r, cy-r+1), (cx, cy+r+1), (cx+r, cy-r+1)], fill=SECONDARY)
    y += int(38 * scale) + int(2 * scale)

    # checks
    check_items = [
        "Enable automatically on YouTube" if en else "在 YouTube 上自动启用",
        "Auto-reload page if it fails" if en else "应用失败时自动刷新页面",
    ]
    for c in check_items:
        d.rounded_rectangle([inner_x, y, inner_x + int(16*scale), y + int(16*scale)], int(3*scale), fill=PRIMARY)
        d.line([(inner_x+int(5*scale), y+int(8*scale)), (inner_x+int(8*scale), y+int(12*scale))], fill=WHITE, width=max(1, int(2*scale)))
        d.line([(inner_x+int(8*scale), y+int(12*scale)), (inner_x+int(13*scale), y+int(5*scale))], fill=WHITE, width=max(1, int(2*scale)))
        d.text((inner_x + int(24*scale), y - int(2*scale)), c, font=font(int(12*scale), cjk=not en), fill=TEXT)
        y += int(19 * scale)

    # support
    y += int(10 * scale)
    d.line([(inner_x, y), (inner_x + inner_w, y)], fill=BORDER, width=1)
    y += int(10 * scale)
    support_text = "Support developer" if en else "支持开发者"
    b = d.textbbox((0, 0), support_text, font=font(int(11*scale), cjk=not en))
    sw = b[2] - b[0]
    d.text((inner_x + (inner_w - sw) // 2, y), support_text, font=font(int(11*scale), cjk=not en), fill=SECONDARY)

    return img


# ---------- Screenshots ----------
def draw_browser_stage(d, W, H):
    """Draw a generic browser chrome + YouTube video stage."""
    # Browser toolbar
    toolbar_h = int(48)
    d.rectangle([0, 0, W, toolbar_h], fill=(0xDE, 0xDF, 0xE6))
    d.rounded_rectangle([int(16), int(12), int(700), int(36)], int(8), fill=WHITE)
    d.text((int(28), int(16)), "youtube.com/watch", font=font(14), fill=SECONDARY)
    # Window controls dots
    dot_colors = [(0xFF, 0x5F, 0x56), (0xFF, 0xBD, 0x2E), (0x28, 0xC8, 0x40)]
    for i, col in enumerate(dot_colors):
        d.ellipse([int(1160 + i*20), int(18), int(1160 + i*20 + 12), int(30)], fill=col)

    # Video stage
    stage = [int(60), int(80), W - int(60), int(470)]
    d.rectangle(stage, fill=STAGE_BG)
    ic = make_icon(48)
    d._image.paste(ic, (W//2 - 24, int(250)), ic)
    return stage


def draw_caption_bar(d, stage, lang, caption_text):
    """Draw a YouTube-style caption bar inside the video stage."""
    W = d._image.width
    cb_y = stage[3] - int(90)
    cb_h = int(44)
    cb_w = min(int(680), W - int(240))
    cb_x = (W - cb_w) // 2
    d.rounded_rectangle([cb_x, cb_y, cb_x + cb_w, cb_y + cb_h], int(8), fill=(0, 0, 0))
    draw_center(d, W//2, cb_y + cb_h//2, caption_text, font(17, cjk=(lang=='zh')), WHITE)


def gen_screenshots():
    scenes = {
        "screenshot-1-browser.png": {
            "en": {
                "caption": "Open a YouTube video — captions turn on automatically",
                "bottom": "Auto-enable YouTube captions with one click",
            },
            "zh": {
                "caption": "打开 YouTube 视频 — 字幕自动开启",
                "bottom": "一键自动开启 YouTube 字幕",
            },
        },
        "screenshot-2-translate.png": {
            "en": {
                "caption": "Auto-opened captions appear instantly",
                "bottom": "Automatically open captions in your preferred language",
            },
            "zh": {
                "caption": "字幕自动呈现",
                "bottom": "按偏好自动打开对应语言字幕",
            },
        },
        "screenshot-3-autogen.png": {
            "en": {
                "caption": "English (auto-generated) captions ready to go",
                "bottom": "Switch to auto-generated captions when you prefer",
            },
            "zh": {
                "caption": "英语（自动生成）字幕随时可用",
                "bottom": "需要时直接启用自动生成字幕",
            },
        },
    }
    W, H = 1280, 800
    for lang in ("en", "zh"):
        out_dir = os.path.join(SHOTS, lang)
        os.makedirs(out_dir, exist_ok=True)
        for fname, texts in scenes.items():
            img = Image.new("RGB", (W, H), SOFT_BG)
            d = ImageDraw.Draw(img)
            stage = draw_browser_stage(d, W, H)
            t = texts[lang]
            draw_caption_bar(d, stage, lang, t["caption"])

            # Popup mock floating bottom-right
            popup = draw_popup_mock(lang)
            px = W - popup.width - int(50)
            py = H - popup.height - int(80)
            img.paste(popup, (px, py), popup)

            # Bottom description
            d.text((int(80), H - int(60)), t["bottom"],
                   font=font(18, cjk=(lang=='zh')), fill=TEXT)

            img.save(os.path.join(out_dir, fname), "PNG")
        print(f"screenshots generated: {lang}")


if __name__ == "__main__":
    gen_icons()
    gen_promo()
    gen_screenshots()
    print("ALL ASSETS DONE")
