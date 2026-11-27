import json
import math
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

PROJECT_DIR = r"C:\Users\Fan Haorong\.gemini\antigravity\scratch\StockingQuota"
ASSETS_DIR = os.path.join(PROJECT_DIR, "public", "assets")
BRAIN_DIR = r"C:\Users\Fan Haorong\.gemini\antigravity\brain\b7a2f387-9930-4bfc-b232-9b53a40ca478"
OUT_PUBLIC = os.path.join(PROJECT_DIR, "public", "matte_samples.png")
OUT_ARTIFACT = os.path.join(BRAIN_DIR, "matte_samples_comparison.png")


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / np.maximum(1e-6, e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def load_base():
    with open(os.path.join(ASSETS_DIR, "manifest.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)
    legs = np.array(Image.open(os.path.join(ASSETS_DIR, "legs_bare.png")).convert("RGBA"), dtype=np.float32) / 255.0
    skirt = np.array(Image.open(os.path.join(ASSETS_DIR, "skirt_overlay.png")).convert("RGBA"), dtype=np.float32) / 255.0
    return manifest, legs, skirt


def build_leg_fields(manifest, h, w):
    """Precompute exact per-pixel (u, nz, y_norm, leg_side_mask) for left & right legs."""
    fields = {}
    ys = np.arange(h, dtype=np.float32)
    xs = np.arange(w, dtype=np.float32)[None, :]  # (1, w)

    for side in ("left", "right"):
        meta = manifest["legs"][side]
        slices = meta["slices"]
        sy = np.array([s["y"] * h for s in slices], dtype=np.float32)
        sxl = np.array([s["xLeft"] for s in slices], dtype=np.float32)
        sxr = np.array([s["xRight"] for s in slices], dtype=np.float32)

        xl = np.interp(ys, sy, sxl)[:, None]  # (h, 1)
        xr = np.interp(ys, sy, sxr)[:, None]
        width = np.maximum(1.0, xr - xl)
        u = (xs - xl) / width  # (h, w)
        in_leg_x = (u >= -0.06) & (u <= 1.06)
        u_c = np.clip(u, 0.0, 1.0)

        nx = np.clip((u_c - 0.5) * 2.0, -0.995, 0.995)
        nz = np.sqrt(np.maximum(0.01, 1.0 - nx * nx))
        fields[side] = {
            "u": u_c,
            "nx": nx,
            "nz": nz,
            "in_x": in_leg_x,
            "yTop": meta["yTop"],
            "yAnkle": meta["yAnkle"],
            "yToe": meta["yToe"],
            "width": width,
        }
    return fields


def render_look(legs, skirt, fields, cfg):
    """Render one matte/velvet stocking look over bare legs (left 82%, right 56%)."""
    h, w, _ = legs.shape
    out_rgb = legs[:, :, :3].copy()
    leg_a = legs[:, :, 3]
    ys_grid = np.arange(h, dtype=np.float32)[:, None]

    # Gentle deterministic fine velvet micro-grain (moiré-free papery/velvet tooth)
    rng = np.random.default_rng(42)
    grain = (rng.normal(0.0, 1.0, (h, w)).astype(np.float32)) * cfg.get("grain", 0.018)

    # Anatomical vertical landmarks (normalized image height on our 768x1029 legs):
    # Upper thigh fullness: y ~ 0.25..0.38
    # Kneecap peak:         y ~ 0.435
    # Knee crease/hollow:   y ~ 0.485
    # Upper calf fullness:  y ~ 0.58
    # Ankle taper:          y ~ 0.78..0.84
    y_norm = ys_grid / float(h)
    knee_peak = np.exp(-((y_norm - 0.432) / 0.045) ** 2)
    thigh_peak = np.exp(-((y_norm - 0.305) / 0.115) ** 2)
    shin_peak = np.exp(-((y_norm - 0.600) / 0.135) ** 2)
    ankle_dark = smoothstep(0.70, 0.86, y_norm) * (1.0 - smoothstep(0.88, 0.97, y_norm))
    toe_cap = smoothstep(0.91, 0.97, y_norm)

    base_col = np.array(cfg["base_color"], dtype=np.float32)[None, None, :]
    skin_tint = np.array(cfg["skin_tint"], dtype=np.float32)[None, None, :]
    edge_col = np.array(cfg["edge_color"], dtype=np.float32)[None, None, :]

    for side, pct in (("left", 82.0), ("right", 56.0)):
        f = fields[side]
        u = f["u"]
        nz = f["nz"]
        nx = f["nx"]

        # Cuff Y with subtle 3D wrap
        cuff_y = f["yAnkle"] - ((pct - 14.0) / 86.0) * (f["yAnkle"] - f["yTop"])
        cuff_y_curve = cuff_y + np.sin(u * math.pi) * 4.5
        cloth_px = ys_grid - cuff_y_curve

        valid = f["in_x"] & (leg_a > 0.01) & (cloth_px > -16.0)

        # 1. Soft cuff-hug shadow right above the cuff
        above_mask = valid & (cloth_px < 0.0)
        if np.any(above_mask):
            d_above = np.maximum(0.0, -cloth_px)
            ao = np.exp(-d_above * 0.30) * smoothstep(14.0, 1.0, d_above) * (0.65 + 0.35 * np.sin(u * math.pi)) * 0.28
            sh_col = out_rgb * np.array([0.82, 0.72, 0.74], dtype=np.float32)
            out_rgb = np.where(above_mask[:, :, None], out_rgb * (1.0 - ao[:, :, None]) + sh_col * ao[:, :, None], out_rgb)

        # 2. Stocking body (>= 0)
        body_mask = valid & (cloth_px >= 0.0)
        top_lip = smoothstep(0.0, 2.2, cloth_px)

        # Skin RGB underneath (preserve painted anime shading & warm blush!)
        skin = legs[:, :, :3]
        skin_luma = 0.299 * skin[:, :, 0] + 0.587 * skin[:, :, 1] + 0.114 * skin[:, :, 2]
        line_art = 1.0 - smoothstep(0.45, 0.72, skin_luma)

        # Directional soft studio key bias slightly from front-left (matches bare leg lighting, NO harsh stripe!)
        lit_angle = np.clip(nz * 0.90 + (-nx) * 0.22, 0.0, 1.0)

        # Anatomical stretch/sheerness boost on convex bone/muscle zones (thigh, kneecap, shin)
        anat_sheer = (
            1.0
            + cfg["thigh_sheer"] * thigh_peak
            + cfg["knee_sheer"] * knee_peak
            + cfg["shin_sheer"] * shin_peak
            - cfg["ankle_darken"] * ankle_dark
        )

        # Beer-Lambert viewing-angle optical path through velvet nylon:
        # Center -> thin path (warm rosy skin shows through!)
        # Sides  -> steep grazing curve (deep velvety matte shadow!)
        grazing = np.power(np.maximum(0.08, lit_angle), cfg["fresnel_pow"])
        # Smooth anatomical translucency (skin transmission T in [0..1])
        # Higher T = more warm skin tone shines through the matte fabric
        trans = cfg["center_trans"] * np.power(grazing, cfg["falloff_exp"]) * anat_sheer
        trans = np.clip(trans, 0.0, cfg["max_trans"])

        # Cuff band (standard double-knit matte OR intricate scalloped lace!)
        cuff_h = cfg["cuff_h"]
        if cfg.get("lace_cuff", False):
            # Scalloped delicate floral lace cuff band (like the gothic reference!)
            scallop_top = np.sin(u * math.pi * 12.0) * 3.5
            scallop_bot = np.sin(u * math.pi * 12.0 + 1.5) * 4.5
            cuff_px_s = cloth_px + scallop_top
            top_lip = smoothstep(0.0, 2.0, cuff_px_s)
            in_cuff = (1.0 - smoothstep(cuff_h - 4.0, cuff_h + 2.0, cloth_px + scallop_bot)) * top_lip
            # Delicate open-work floral lace pattern
            lx = u * 12.0 * math.pi
            ly = (cloth_px / max(1.0, cuff_h)) * 4.0 * math.pi
            floral = (
                np.abs(np.sin(lx) * np.sin(ly)) * 0.55
                + (0.5 + 0.5 * np.cos(lx * 2.0 - ly)) * 0.25
                + np.exp(-((cloth_px - 3.5) / 2.2) ** 2) * 0.6
                + np.exp(-((cloth_px - cuff_h + 3.0) / 2.5) ** 2) * 0.55
            )
            lace_solid = smoothstep(0.32, 0.72, floral)
            # In lace cuff: open mesh shows more bare skin, solid embroidery is rich dark velvet!
            cuff_trans_mod = np.where(in_cuff > 0.05, 1.0 - in_cuff * (0.78 * lace_solid - 0.35 * (1.0 - lace_solid)), 1.0)
            trans = np.clip(trans * cuff_trans_mod, 0.0, 0.88)
            under_cuff_sh = smoothstep(cuff_h - 1.0, cuff_h + 3.0, cloth_px + scallop_bot) * np.exp(-np.maximum(0.0, cloth_px + scallop_bot - cuff_h) * 0.22) * 0.24
        else:
            in_cuff = 1.0 - smoothstep(cuff_h - 3.0, cuff_h + 2.5, cloth_px)
            cuff_rib = 0.5 + 0.5 * np.sin(u * 130.0)
            # Matte double-layer knit band reduces translucency naturally
            trans = trans * (1.0 - in_cuff * 0.62)
            under_cuff_sh = smoothstep(cuff_h - 1.0, cuff_h + 2.5, cloth_px) * np.exp(-np.maximum(0.0, cloth_px - cuff_h) * 0.25) * 0.20

        # Subtle reinforced toe cap at bottom of toes
        trans = trans * (1.0 - toe_cap * 0.35)

        # Optical matte blending (NO plastic white addition!):
        # Warm skin filtered through dark velvet dye (like Photoshop Multiply + warm scatter!)
        warm_skin = skin * skin_tint
        # Velvet body shifts smoothly from rich dark edge_col at silhouette to base_col inside
        velvet_dye = edge_col * (1.0 - nz[:, :, None] ** 0.75) + base_col * (nz[:, :, None] ** 0.75)

        # Combine deep matte velvet dye with warm transmitted skin!
        # Notice: this creates that EXACT smoky warm mauve/brown-peach glow seen in the reference!
        stock_rgb = velvet_dye * (1.0 - trans[:, :, None]) + (warm_skin * (0.42 + 0.58 * velvet_dye * 1.45 + cfg["skin_warmth"])) * trans[:, :, None]

        # Optional ultra-subtle powdery velvet micro-scatter (never a bright white stripe!)
        if cfg["velvet_sheen"] > 0.0:
            # Broad, dusty satin scatter strictly hugging the warm translucent peak (not metallic!)
            broad = np.power(np.maximum(0.0, lit_angle), 4.5) * (0.45 + 0.55 * (thigh_peak * 0.6 + knee_peak * 0.8 + shin_peak * 0.5))
            sheen_tint = np.array(cfg["sheen_tint"], dtype=np.float32)[None, None, :]
            stock_rgb = stock_rgb + sheen_tint * (broad * cfg["velvet_sheen"] * (1.0 - in_cuff * 0.65))[:, :, None]

        # Matte velvet micro-grain + subtle cuff rib & hem shadow
        stock_rgb = stock_rgb * (1.0 + grain[:, :, None])
        if not cfg.get("lace_cuff", False):
            cuff_rib = 0.5 + 0.5 * np.sin(u * 130.0)
            stock_rgb = stock_rgb * (1.0 - in_cuff[:, :, None] * 0.14 + (in_cuff * (cuff_rib - 0.5) * 0.05)[:, :, None])
        else:
            # Make lace embroidery slightly darker & crisper
            stock_rgb = stock_rgb * (1.0 - (in_cuff * lace_solid * 0.28)[:, :, None])

        stock_rgb = stock_rgb * (1.0 - under_cuff_sh[:, :, None])

        # Soft velvety anime contour outline (deep matching dye tone, zero peach fringe!)
        outline_col = edge_col * 0.55
        stock_rgb = stock_rgb * (1.0 - line_art[:, :, None] * 0.68) + outline_col * (line_art[:, :, None] * 0.68)

        stock_rgb = np.clip(stock_rgb, 0.0, 1.0)
        blend_a = (top_lip * body_mask.astype(np.float32))[:, :, None]
        out_rgb = out_rgb * (1.0 - blend_a) + stock_rgb * blend_a

    # Composite crisp pleated skirt hem back on top
    sa = skirt[:, :, 3:4]
    out_rgb = out_rgb * (1.0 - sa) + skirt[:, :, :3] * sa

    rgba = np.dstack([np.clip(out_rgb * 255.0, 0, 255).astype(np.uint8), np.clip(leg_a * 255.0, 0, 255).astype(np.uint8)])
    return Image.fromarray(rgba, mode="RGBA")


def main():
    manifest, legs, skirt = load_base()
    h, w, _ = legs.shape
    fields = build_leg_fields(manifest, h, w)

    looks = [
        {
            "id": "1",
            "title": "方案 1：天鹅绒柔雾黑紫（参考图直译）",
            "desc": "零油光纯哑光 · 暖肤透肉渐入深丝绒暗边",
            "base_color": [0.16, 0.11, 0.22],
            "edge_color": [0.08, 0.06, 0.12],
            "skin_tint": [0.92, 0.74, 0.78],
            "skin_warmth": 0.24,
            "center_trans": 0.56,
            "max_trans": 0.68,
            "fresnel_pow": 1.45,
            "falloff_exp": 1.35,
            "thigh_sheer": 0.16,
            "knee_sheer": 0.24,
            "shin_sheer": 0.10,
            "ankle_darken": 0.26,
            "velvet_sheen": 0.0,
            "sheen_tint": [0.55, 0.42, 0.58],
            "cuff_h": 26.0,
            "grain": 0.016,
            "lace_cuff": False,
        },
        {
            "id": "2",
            "title": "方案 2：日系厚涂粉透紫丝（柔和明快）",
            "desc": "更高透肉度 · 膝盖/大腿自然暖粉透出 · 适合桌面小窗",
            "base_color": [0.23, 0.16, 0.34],
            "edge_color": [0.13, 0.09, 0.21],
            "skin_tint": [0.98, 0.82, 0.86],
            "skin_warmth": 0.36,
            "center_trans": 0.64,
            "max_trans": 0.78,
            "fresnel_pow": 1.25,
            "falloff_exp": 1.25,
            "thigh_sheer": 0.18,
            "knee_sheer": 0.28,
            "shin_sheer": 0.14,
            "ankle_darken": 0.20,
            "velvet_sheen": 0.0,
            "sheen_tint": [0.68, 0.56, 0.78],
            "cuff_h": 24.0,
            "grain": 0.012,
            "lace_cuff": False,
        },
        {
            "id": "3",
            "title": "方案 3：哑光天鹅绒 + 蕾丝花边袜口",
            "desc": "复刻参考图复古蕾丝袜口 + 深雾紫天鹅绒质感",
            "base_color": [0.17, 0.12, 0.24],
            "edge_color": [0.09, 0.06, 0.14],
            "skin_tint": [0.95, 0.77, 0.80],
            "skin_warmth": 0.28,
            "center_trans": 0.58,
            "max_trans": 0.72,
            "fresnel_pow": 1.38,
            "falloff_exp": 1.30,
            "thigh_sheer": 0.16,
            "knee_sheer": 0.26,
            "shin_sheer": 0.12,
            "ankle_darken": 0.24,
            "velvet_sheen": 0.0,
            "sheen_tint": [0.55, 0.45, 0.62],
            "cuff_h": 42.0,
            "grain": 0.015,
            "lace_cuff": True,
        },
        {
            "id": "4",
            "title": "方案 4：20D 轻透雾纱（空气感清透）",
            "desc": "轻盈薄纱感 · 保留原画肤色光影 · 边缘深紫雾勾边",
            "base_color": [0.26, 0.18, 0.38],
            "edge_color": [0.14, 0.09, 0.23],
            "skin_tint": [1.0, 0.87, 0.88],
            "skin_warmth": 0.46,
            "center_trans": 0.74,
            "max_trans": 0.86,
            "fresnel_pow": 1.55,
            "falloff_exp": 1.18,
            "thigh_sheer": 0.14,
            "knee_sheer": 0.22,
            "shin_sheer": 0.12,
            "ankle_darken": 0.18,
            "velvet_sheen": 0.0,
            "sheen_tint": [0.75, 0.65, 0.85],
            "cuff_h": 24.0,
            "grain": 0.010,
            "lace_cuff": False,
        },
        {
            "id": "5",
            "title": "方案 5：50D 浓密深丝绒（厚实高级哑光）",
            "desc": "深邃浓郁的厚哑光丝绒 · 仅在膝盖与大腿隆起处微透肤温",
            "base_color": [0.15, 0.10, 0.23],
            "edge_color": [0.07, 0.05, 0.11],
            "skin_tint": [0.88, 0.70, 0.74],
            "skin_warmth": 0.16,
            "center_trans": 0.40,
            "max_trans": 0.54,
            "fresnel_pow": 1.50,
            "falloff_exp": 1.45,
            "thigh_sheer": 0.22,
            "knee_sheer": 0.34,
            "shin_sheer": 0.12,
            "ankle_darken": 0.32,
            "velvet_sheen": 0.0,
            "sheen_tint": [0.45, 0.36, 0.55],
            "cuff_h": 28.0,
            "grain": 0.022,
            "lace_cuff": False,
        },
        {
            "id": "6",
            "title": "方案 6：哑光丝绒 + 极克制微柔光（动静兼顾）",
            "desc": "92%纯哑光天鹅绒 + 8%极柔和紫雾漫反射（动态褶皱更有层次）",
            "base_color": [0.18, 0.12, 0.27],
            "edge_color": [0.09, 0.06, 0.15],
            "skin_tint": [0.95, 0.78, 0.82],
            "skin_warmth": 0.28,
            "center_trans": 0.56,
            "max_trans": 0.70,
            "fresnel_pow": 1.35,
            "falloff_exp": 1.28,
            "thigh_sheer": 0.16,
            "knee_sheer": 0.26,
            "shin_sheer": 0.12,
            "ankle_darken": 0.24,
            "velvet_sheen": 0.075,
            "sheen_tint": [0.76, 0.62, 0.88],
            "cuff_h": 26.0,
            "grain": 0.015,
            "lace_cuff": False,
        },
    ]

    # Build a crisp 3x2 gallery sheet (1560 x 1460)
    card_w, card_h = 480, 680
    pad = 24
    cols, rows = 3, 2
    canvas_w = cols * card_w + (cols + 1) * pad
    canvas_h = rows * card_h + (rows + 1) * pad + 56

    sheet = Image.new("RGBA", (canvas_w, canvas_h), (18, 20, 30, 255))
    draw = ImageDraw.Draw(sheet)

    # Load a clean CJK font on Windows
    font_paths = [
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
    ]
    font_title = font_sub = font_hdr = ImageFont.load_default()
    for fp in font_paths:
        if os.path.exists(fp):
            font_hdr = ImageFont.truetype(fp, 24)
            font_title = ImageFont.truetype(fp, 18)
            font_sub = ImageFont.truetype(fp, 13)
            break

    draw.text((pad, 16), "StockingQuota 哑光丝袜质感候选方案对比（左腿 82% / 右腿 56%）", fill=(238, 236, 252, 255), font=font_hdr)

    for idx, cfg in enumerate(looks):
        col = idx % cols
        row = idx // cols
        x0 = pad + col * (card_w + pad)
        y0 = 56 + pad + row * (card_h + pad)

        # Card background (dark neutral studio gradient feel)
        draw.rounded_rectangle([x0, y0, x0 + card_w, y0 + card_h], radius=18, fill=(29, 32, 46, 255), outline=(92, 82, 138, 140), width=2)

        rendered = render_look(legs, skirt, fields, cfg)
        # Fit legs nicely inside card above text footer
        avail_h = card_h - 86
        scale = avail_h / float(h)
        rw, rh = int(round(w * scale)), int(round(h * scale))
        resized = rendered.resize((rw, rh), Image.Resampling.LANCZOS)
        px = x0 + (card_w - rw) // 2
        py = y0 + 14
        sheet.alpha_composite(resized, (px, py))

        # Big badge number in top-left of card
        draw.rounded_rectangle([x0 + 14, y0 + 14, x0 + 52, y0 + 44], radius=10, fill=(139, 92, 246, 210))
        draw.text((x0 + 26, y0 + 17), f"#{cfg['id']}", fill=(255, 255, 255, 255), font=font_title)

        # Footer label bar
        draw.rectangle([x0 + 2, y0 + card_h - 68, x0 + card_w - 2, y0 + card_h - 2], fill=(21, 23, 35, 235))
        draw.text((x0 + 16, y0 + card_h - 60), cfg["title"], fill=(242, 238, 255, 255), font=font_title)
        draw.text((x0 + 16, y0 + card_h - 32), cfg["desc"], fill=(168, 174, 204, 255), font=font_sub)

    rgb_out = sheet.convert("RGB")
    rgb_out.save(OUT_PUBLIC, quality=95)
    rgb_out.save(OUT_ARTIFACT, quality=95)
    print(f"Saved 6 matte look samples to {OUT_PUBLIC} and {OUT_ARTIFACT}")


if __name__ == "__main__":
    main()
