#!/usr/bin/env python3
"""Generate a simple text-on-transparent PNG for Slack custom emoji."""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size=size)
            except OSError:
                continue
    raise RuntimeError("No usable Japanese font found")


def render(text: str, out: Path, *, color=(0, 0, 0, 255), size=128, padding=16):
    font = load_font(size)
    img = Image.new("RGBA", (size * 2 + padding * 2, size * 2 + padding * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Place text in center using textbbox
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (img.width - tw) // 2 - bbox[0]
    y = (img.height - th) // 2 - bbox[1]
    draw.text((x, y), text, font=font, fill=color)
    # Crop to tight square
    img = img.crop(img.getbbox())
    # Pad to square
    maxdim = max(img.width, img.height)
    square = Image.new("RGBA", (maxdim + padding * 2, maxdim + padding * 2), (0, 0, 0, 0))
    square.paste(img, ((square.width - img.width) // 2, (square.height - img.height) // 2))
    # Resize to 128x128
    square = square.resize((128, 128), Image.LANCZOS)
    square.save(out)
    print(f"wrote {out}")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    # Red for the action-requested emoji, green for the completion marker
    render("休明\nよろ", root / "kyuake-yoro.png", color=(200, 40, 40, 255))
    render("休明\n済", root / "kyuake-zumi.png", color=(40, 140, 40, 255))
