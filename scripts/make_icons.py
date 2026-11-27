import os
from PIL import Image, ImageDraw

PROJECT_DIR = r"C:\Users\Fan Haorong\.gemini\antigravity\scratch\StockingQuota"
BUILD_DIR = os.path.join(PROJECT_DIR, "build")
os.makedirs(BUILD_DIR, exist_ok=True)


def make_icon(size: int) -> Image.Image:
    # Draw crisp high-res icon at 4x then Lanczos downsample for silky anti-aliasing
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = int(s * 0.08)
    # Soft dark-violet circular badge with luminous lavender ring
    draw.ellipse([pad, pad, s - pad, s - pad], fill=(26, 20, 42, 245))
    ring_w = max(4, int(s * 0.075))
    draw.arc([pad + ring_w, pad + ring_w, s - pad - ring_w, s - pad - ring_w], start=-90, end=205, fill=(178, 138, 255, 255), width=ring_w)
    draw.arc([pad + ring_w, pad + ring_w, s - pad - ring_w, s - pad - ring_w], start=215, end=260, fill=(244, 138, 196, 235), width=ring_w)

    # Cute minimalist anime stocking silhouette emblem inside the circle
    cx = s * 0.50
    cy = s * 0.50
    # Upper leg & cuff
    leg_pts = [
        (cx - s * 0.12, cy - s * 0.24),
        (cx + s * 0.06, cy - s * 0.24),
        (cx + s * 0.03, cy + s * 0.06),
        (cx + s * 0.19, cy + s * 0.16),
        (cx + s * 0.15, cy + s * 0.26),
        (cx - s * 0.06, cy + s * 0.20),
        (cx - s * 0.11, cy + s * 0.06),
    ]
    draw.polygon(leg_pts, fill=(138, 96, 198, 255))
    # Plush darker cuff band at top of stocking
    cuff_pts = [
        (cx - s * 0.13, cy - s * 0.25),
        (cx + s * 0.07, cy - s * 0.25),
        (cx + s * 0.06, cy - s * 0.16),
        (cx - s * 0.12, cy - s * 0.16),
    ]
    draw.polygon(cuff_pts, fill=(76, 46, 118, 255))
    # Subtle warm rose sheen highlight inside stocking
    draw.ellipse([cx - s * 0.06, cy - s * 0.11, cx + s * 0.01, cy + s * 0.09], fill=(224, 186, 224, 155))

    return img.resize((size, size), Image.Resampling.LANCZOS)


def main():
    icon_256 = make_icon(256)
    icon_256.save(os.path.join(BUILD_DIR, "icon.png"))
    icon_256.save(
        os.path.join(BUILD_DIR, "icon.ico"),
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    tray_32 = make_icon(32)
    tray_32.save(os.path.join(BUILD_DIR, "tray.png"))
    print("Generated build/icon.ico, build/icon.png, build/tray.png OK!")


if __name__ == "__main__":
    main()
