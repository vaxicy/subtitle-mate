#!/usr/bin/env python3
"""Take the user-provided desktop icon.png, remove the outer background,
keep the enclosed white/red icon body, and output 16/48/128 toolbar icons
plus a full-resolution store-assets/icon-source.png for screenshots."""
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = Path(os.path.expanduser("~")) / "Desktop"
SRC = DESKTOP / "icon.png"
OUT_DIR = ROOT / "icons"
STORE_SOURCE = ROOT / "store-assets" / "icon-source.png"
SIZES = [16, 48, 128]


def remove_outer_background(src_path: Path) -> Image.Image:
    img = Image.open(src_path).convert("RGBA")
    w, h = img.size
    rgb = img.convert("RGB")
    px = list(rgb.get_flattened_data())

    # Mask for red-ish pixels (border + CC letters + sparkle).
    red_mask_data = [
        255 if (r > 150 and g < 120 and b < 120) else 0
        for (r, g, b) in px
    ]
    red_mask = Image.new("L", (w, h))
    red_mask.putdata(red_mask_data)

    # Dilate the red mask so small anti-aliased gaps in the border act as a
    # solid barrier during flood fill.
    red_mask = red_mask.filter(ImageFilter.MaxFilter(7))

    # Build a barrier image: red areas are black (0), everything else white (255).
    barrier = Image.new("L", (w, h), 255)
    barrier.paste(0, mask=red_mask)

    # Flood fill from the top-left corner. The fill marks every pixel reachable
    # from the outside as background (128). Pixels enclosed by the red barrier
    # stay white (255), i.e. the icon body is preserved.
    ImageDraw.floodfill(barrier, (0, 0), 128)

    barrier_data = list(barrier.get_flattened_data())
    fg_data = [255 if v != 128 else 0 for v in barrier_data]
    fg_mask = Image.new("L", (w, h))
    fg_mask.putdata(fg_data)

    # Apply the mask.
    out = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    out.paste(img, (0, 0), fg_mask)

    # Crop to content.
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    return out


def make_square(src: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    src = src.copy()
    src.thumbnail((size, size), Image.LANCZOS)
    x = (size - src.width) // 2
    y = (size - src.height) // 2
    canvas.paste(src, (x, y), src)
    return canvas


def main():
    if not SRC.exists():
        raise FileNotFoundError(f"Desktop icon not found: {SRC}")
    icon = remove_outer_background(SRC)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for s in SIZES:
        out = make_square(icon, s)
        out.save(OUT_DIR / f"icon{s}.png", "PNG")
        print(f"saved {OUT_DIR / f'icon{s}.png'}")
    # High-res source for store-asset scripts later.
    icon.save(STORE_SOURCE, "PNG")
    print(f"saved {STORE_SOURCE}")

    # Quick sanity check.
    check = Image.open(OUT_DIR / "icon128.png")
    print(f"icon128: mode={check.mode}, size={check.size}, corner={check.getpixel((0, 0))}")


if __name__ == "__main__":
    main()
