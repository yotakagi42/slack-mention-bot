#!/usr/bin/env python3
"""Generate polished Slack custom emoji PNGs for kyuake markers."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

SIZE = 128
FONT_CANDIDATES = [
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc",
    "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
]


Color = tuple[int, int, int, int]
Rgb = tuple[int, int, int]


@dataclass(frozen=True)
class EmojiSpec:
    filename: str
    top_text: str
    bottom_text: str
    badge_top: Rgb
    badge_bottom: Rgb
    panel: Color
    panel_strong: Color
    text_fill: Color
    text_stroke: Color
    icon_fill: Color
    icon_glow: Color
    shadow: Color
    icon_kind: str


SPECS = [
    EmojiSpec(
        filename="kyuake-yoro.png",
        top_text="休明",
        bottom_text="よろ",
        badge_top=(246, 116, 96),
        badge_bottom=(193, 56, 70),
        panel=(125, 28, 42, 86),
        panel_strong=(112, 22, 37, 126),
        text_fill=(255, 248, 243, 255),
        text_stroke=(123, 34, 33, 255),
        icon_fill=(255, 228, 156, 255),
        icon_glow=(255, 246, 214, 120),
        shadow=(79, 17, 27, 110),
        icon_kind="sun",
    ),
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if not Path(path).exists():
            continue
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    raise RuntimeError("No usable Japanese font found")


def make_vertical_gradient(size: tuple[int, int], top: Rgb, bottom: Rgb) -> Image.Image:
    width, height = size
    gradient = Image.new("RGBA", size, (0, 0, 0, 0))
    pixels = gradient.load()
    for y in range(height):
        t = y / max(height - 1, 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(width):
            pixels[x, y] = (r, g, b, 255)
    return gradient


def add_badge_shadow(canvas: Image.Image, rect: tuple[int, int, int, int], radius: int, color: Color) -> None:
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(shadow)
    x0, y0, x1, y1 = rect
    draw.rounded_rectangle((x0, y0 + 4, x1, y1 + 4), radius=radius, fill=color)
    shadow = shadow.filter(ImageFilter.GaussianBlur(7))
    canvas.alpha_composite(shadow)


def add_badge_base(canvas: Image.Image, spec: EmojiSpec) -> tuple[int, int, int, int]:
    rect = (10, 8, 118, 118)
    radius = 30
    add_badge_shadow(canvas, rect, radius, spec.shadow)

    x0, y0, x1, y1 = rect
    badge_size = (x1 - x0, y1 - y0)
    badge = make_vertical_gradient(badge_size, spec.badge_top, spec.badge_bottom)
    mask = Image.new("L", badge_size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, badge_size[0], badge_size[1]), radius=radius, fill=255)
    badge.putalpha(mask)
    canvas.alpha_composite(badge, (x0, y0))

    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle((x0 + 6, y0 + 5, x1 - 6, y0 + 36), radius=18, fill=(255, 255, 255, 28))
    draw.rounded_rectangle((x0 + 1, y0 + 1, x1 - 1, y1 - 1), radius=radius, outline=(255, 255, 255, 52), width=2)
    draw.rounded_rectangle((x0 + 3, y0 + 3, x1 - 3, y1 - 3), radius=radius - 3, outline=(0, 0, 0, 32), width=1)
    canvas.alpha_composite(overlay)
    return rect


def add_text_panels(canvas: Image.Image, spec: EmojiSpec) -> None:
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle((22, 23, 106, 66), radius=18, fill=spec.panel, outline=(255, 255, 255, 30), width=1)
    draw.rounded_rectangle((27, 69, 101, 101), radius=16, fill=spec.panel_strong, outline=(255, 255, 255, 34), width=1)
    canvas.alpha_composite(overlay)


def add_icon(canvas: Image.Image, spec: EmojiSpec) -> None:
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    if spec.icon_kind == "sun":
        cx, cy = 96, 32
        for dx, dy in ((0, -11), (8, -8), (11, 0), (8, 8), (0, 11), (-8, 8), (-11, 0), (-8, -8)):
            draw.line((cx, cy, cx + dx, cy + dy), fill=spec.icon_glow, width=3)
        draw.ellipse((cx - 8, cy - 8, cx + 8, cy + 8), fill=spec.icon_fill)
        draw.ellipse((cx - 10, cy - 10, cx + 10, cy + 10), outline=(255, 255, 255, 70), width=1)
    elif spec.icon_kind == "check":
        cx, cy = 95, 33
        draw.ellipse((cx - 13, cy - 13, cx + 13, cy + 13), fill=spec.icon_glow)
        draw.ellipse((cx - 11, cy - 11, cx + 11, cy + 11), fill=(255, 255, 255, 54), outline=(255, 255, 255, 78), width=1)
        draw.line((cx - 6, cy + 1, cx - 1, cy + 6), fill=spec.icon_fill, width=5)
        draw.line((cx - 1, cy + 6, cx + 8, cy - 5), fill=spec.icon_fill, width=5)
    canvas.alpha_composite(overlay)


def fit_font(text: str, max_width: int, max_height: int, start_size: int, stroke_width: int) -> ImageFont.FreeTypeFont:
    probe = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    draw = ImageDraw.Draw(probe)
    for size in range(start_size, 14, -1):
        font = load_font(size)
        bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
        width = bbox[2] - bbox[0]
        height = bbox[3] - bbox[1]
        if width <= max_width and height <= max_height:
            return font
    return load_font(15)


def draw_centered_text(
    canvas: Image.Image,
    text: str,
    *,
    center: tuple[int, int],
    font: ImageFont.FreeTypeFont,
    fill: Color,
    stroke_fill: Color,
    stroke_width: int,
) -> None:
    draw = ImageDraw.Draw(canvas)
    bbox = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width)
    width = bbox[2] - bbox[0]
    height = bbox[3] - bbox[1]
    x = center[0] - width / 2 - bbox[0]
    y = center[1] - height / 2 - bbox[1]

    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.text(
        (x, y + 2),
        text,
        font=font,
        fill=(0, 0, 0, 92),
        stroke_width=stroke_width,
        stroke_fill=(0, 0, 0, 72),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(1))
    canvas.alpha_composite(shadow)

    draw.text(
        (x, y),
        text,
        font=font,
        fill=fill,
        stroke_width=stroke_width,
        stroke_fill=stroke_fill,
    )


def render(spec: EmojiSpec, out_path: Path) -> None:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    add_badge_base(canvas, spec)
    add_text_panels(canvas, spec)
    add_icon(canvas, spec)

    top_font = fit_font(spec.top_text, max_width=68, max_height=26, start_size=42, stroke_width=3)
    bottom_start = 40 if len(spec.bottom_text) > 1 else 48
    bottom_font = fit_font(spec.bottom_text, max_width=72, max_height=30, start_size=bottom_start, stroke_width=3)

    draw_centered_text(
        canvas,
        spec.top_text,
        center=(64, 45),
        font=top_font,
        fill=spec.text_fill,
        stroke_fill=spec.text_stroke,
        stroke_width=3,
    )
    draw_centered_text(
        canvas,
        spec.bottom_text,
        center=(64, 84),
        font=bottom_font,
        fill=spec.text_fill,
        stroke_fill=spec.text_stroke,
        stroke_width=3,
    )

    canvas.save(out_path, format="PNG")
    print(f"wrote {out_path}")


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    for spec in SPECS:
        render(spec, root / spec.filename)


if __name__ == "__main__":
    main()
