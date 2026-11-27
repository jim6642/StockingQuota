import json
import math
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

PROJECT_DIR = r"C:\Users\Fan Haorong\.gemini\antigravity\scratch\StockingQuota"
ASSETS_DIR = os.path.join(PROJECT_DIR, "public", "assets")
BRAIN_DIR = r"C:\Users\Fan Haorong\.gemini\antigravity\brain\b7a2f387-9930-4bfc-b232-9b53a40ca478"
OUT_PUBLIC = os.path.join(PROJECT_DIR, "public", "fold_samples.png")
OUT_ARTIFACT = os.path.join(BRAIN_DIR, "fold_samples_comparison.png")


def smoothstep(e0, e1, x):
    diff = e1 - e0
    safe_diff = np.where(np.abs(diff) < 1e-6, 1e-6, diff)
    t = np.clip((x - e0) / safe_diff, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def load_base():
    with open(os.path.join(ASSETS_DIR, "manifest.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)
    legs = np.array(Image.open(os.path.join(ASSETS_DIR, "legs_bare.png")).convert("RGBA"), dtype=np.float32) / 255.0
    skirt = np.array(Image.open(os.path.join(ASSETS_DIR, "skirt_overlay.png")).convert("RGBA"), dtype=np.float32) / 255.0
    return manifest, legs, skirt


def eval_crescent_fold(u, dy, u_center, dy_center, width_u, arch_px, thick_px, tilt=0.0):
    """
    Evaluate a clean anime/Galgame curved crescent/mountain-ridge cloth fold:
    - valley: deep tapered crescent shadow pocket (crisp top fold crease, soft lower falloff, pointed ends)
    - ridge:  luminous taut fabric bulge sitting right above the fold crease
    - ink:    tapered comic/anime crease line right along the fold pocket apex
    """
    du = (u - u_center) / max(0.05, width_u)
    span_env = np.clip(1.0 - du * du, 0.0, 1.0)
    span_taper = np.power(span_env, 1.1)

    dy_arc = dy_center - arch_px * (1.0 - du * du) + tilt * (u - u_center)
    d = dy - dy_arc
    local_thick = np.maximum(1.5, thick_px * span_taper)

    sharp_top = smoothstep(-local_thick * 0.25, local_thick * 0.16, d)
    soft_bot = 1.0 - smoothstep(local_thick * 0.18, local_thick * 1.45, d)
    valley = sharp_top * soft_bot * span_taper

    ridge = np.exp(-((d + local_thick * 0.68) / np.maximum(2.2, local_thick * 0.78)) ** 2) * span_taper

    ink_w = np.maximum(0.8, 1.85 * span_taper)
    ink = np.exp(-(d / ink_w) ** 2) * np.power(span_env, 1.3)

    return valley, ridge, ink


def render_pulled_leg_style(legs, skirt, manifest, style_cfg):
    h, w, _ = legs.shape
    meta = manifest["legs"]["left"]
    slices = meta["slices"]

    # Generous zoomed crop around left thigh -> knee so every fold, shadow & side bulge is crystal-clear!
    cx0, cy0, cx1, cy1 = 158, 150, 398, 670
    ch, cw = cy1 - cy0, cx1 - cx0

    base_crop = legs[cy0:cy1, cx0:cx1].copy()
    skirt_crop = skirt[cy0:cy1, cx0:cx1].copy()

    ys = np.arange(cy0, cy1, dtype=np.float32)
    xs = np.arange(cx0, cx1, dtype=np.float32)
    yy, xx = np.meshgrid(ys, xs, indexing="ij")

    sy = np.array([s["y"] * h for s in slices], dtype=np.float32)
    sxl = np.array([s["xLeft"] for s in slices], dtype=np.float32)
    sxr = np.array([s["xRight"] for s in slices], dtype=np.float32)

    xl_raw = np.interp(ys, sy, sxl)[:, None]
    xr_raw = np.interp(ys, sy, sxr)[:, None]
    leg_w = np.maximum(1.0, xr_raw - xl_raw)

    grab_u = 0.44
    cuff_base_y = 315.0

    # Natural protruding left/right side-fold silhouette bumps right below the pulled cuff!
    bulge_scale = style_cfg.get("side_bulge_px", 5.2)
    dy_l = ys[:, None] - (cuff_base_y + 22.0)
    bulge_l = bulge_scale * (
        1.00 * np.exp(-((dy_l - 20.0) / 14.0) ** 2)
        + 0.76 * np.exp(-((dy_l - 54.0) / 17.0) ** 2)
        + 0.40 * np.exp(-((dy_l - 90.0) / 19.0) ** 2)
    )
    dy_r = ys[:, None] - (cuff_base_y + 12.0)
    bulge_r = bulge_scale * (
        0.92 * np.exp(-((dy_r - 18.0) / 14.0) ** 2)
        + 0.82 * np.exp(-((dy_r - 52.0) / 17.0) ** 2)
        + 0.44 * np.exp(-((dy_r - 88.0) / 19.0) ** 2)
    )

    xl_cloth = xl_raw - bulge_l - 1.2 * np.exp(-((dy_l - 3.0) / 8.0) ** 2)
    xr_cloth = xr_raw + bulge_r + 1.2 * np.exp(-((dy_r - 3.0) / 8.0) ** 2)
    cloth_w = np.maximum(1.0, xr_cloth - xl_cloth)

    dist_left = xx - xl_cloth
    dist_right = xr_cloth - xx
    cloth_x_mask = smoothstep(-0.9, 0.9, np.minimum(dist_left, dist_right))

    u = np.clip((xx - xl_cloth) / cloth_w, 0.0, 1.0)
    # Smooth, natural elastic U/V dip at grab_u (never a harsh unnatural V-cut!)
    pull_dip = 26.0 * np.exp(-((u - grab_u) / 0.40) ** 2)
    cuff_y = cuff_base_y + pull_dip - 8.0 * np.power(np.clip(u - 0.58, 0.0, 1.0) / 0.42, 1.4) + np.sin(u * math.pi) * 4.0
    dy = yy - cuff_y

    # Safe interior bare-skin sample (prevents dark bleed inside protruding outer side-bulges!)
    leg_a = base_crop[:, :, 3]
    xx_clamped = np.clip(np.round(xx - cx0).astype(np.int32), 0, cw - 1)
    xl_in = np.clip(np.ceil(xl_raw - cx0 + 4).astype(np.int32), 0, cw - 1)
    xr_in = np.clip(np.floor(xr_raw - cx0 - 4).astype(np.int32), 0, cw - 1)
    xx_safe = np.clip(xx_clamped, xl_in, xr_in)
    row_idx = np.arange(ch)[:, None]
    skin_rgb = base_crop[row_idx, xx_safe, :3]

    cloth_edge_outline = smoothstep(2.2, 0.4, np.minimum(dist_left, dist_right)) * smoothstep(-1.0, 0.4, np.minimum(dist_left, dist_right))

    # =========================================================================
    # LUMINOUS MATTE VELVET STOCKING BASE (same rich readable tone as #2 matte!)
    # =========================================================================
    nx = np.clip((u - 0.5) * 2.0, -0.995, 0.995)
    nz = np.sqrt(np.maximum(0.015, 1.0 - nx * nx))
    lit_angle = np.clip(nz * 0.90 + (-nx) * 0.18, 0.0, 1.0)

    y_norm = yy / float(h)
    knee_peak = np.exp(-((y_norm - 0.432) / 0.045) ** 2)
    thigh_peak = np.exp(-((y_norm - 0.305) / 0.115) ** 2)
    shin_peak = np.exp(-((y_norm - 0.600) / 0.135) ** 2)

    base_col = np.array([0.24, 0.16, 0.35], dtype=np.float32)[None, None, :]
    edge_col = np.array([0.13, 0.09, 0.21], dtype=np.float32)[None, None, :]
    skin_tint = np.array([0.98, 0.82, 0.86], dtype=np.float32)[None, None, :]

    anat_sheer = 1.0 + 0.16 * thigh_peak + 0.28 * knee_peak + 0.14 * shin_peak
    grazing = np.power(np.maximum(0.08, lit_angle), 1.25)
    trans = np.clip(0.65 * np.power(grazing, 1.20) * anat_sheer, 0.0, 0.78)

    cuff_h = 20.0
    top_lip = smoothstep(0.0, 2.0, dy)
    in_cuff = 1.0 - smoothstep(cuff_h - 3.0, cuff_h + 2.5, dy)
    trans = trans * (1.0 - in_cuff * 0.56)

    # =========================================================================
    # MANGA / GALGAME MOUNTAIN-PEAK SHADOW + LEFT/RIGHT PROTRUDING FOLDS
    # =========================================================================
    mode = style_cfg["mode"]
    total_valley = np.zeros((ch, cw), dtype=np.float32)
    total_ridge = np.zeros((ch, cw), dtype=np.float32)
    total_ink = np.zeros((ch, cw), dtype=np.float32)

    # Shared mountain-peak + flanking side-fold building blocks
    # 1. Master mountain-peak shadow arching directly under mouse pull point!
    v_mtn1, r_mtn1, i_mtn1 = eval_crescent_fold(u, dy, grab_u + 0.01, 36.0, 0.46, arch_px=18.0, thick_px=14.0, tilt=-4.0)
    v_mtn2, r_mtn2, i_mtn2 = eval_crescent_fold(u, dy, grab_u + 0.06, 70.0, 0.50, arch_px=20.0, thick_px=12.0, tilt=5.0)

    # 2. Protruding left-edge folds sweeping diagonally inward & down from the left silhouette bumps
    vl1, rl1, il1 = eval_crescent_fold(u, dy, 0.13, 28.0, 0.32, arch_px=-7.0, thick_px=11.5, tilt=22.0)
    vl2, rl2, il2 = eval_crescent_fold(u, dy, 0.16, 62.0, 0.36, arch_px=-8.0, thick_px=10.5, tilt=18.0)
    vl3, rl3, il3 = eval_crescent_fold(u, dy, 0.11, 96.0, 0.26, arch_px=-5.0, thick_px=8.0, tilt=14.0)

    # 3. Protruding right-edge folds sweeping diagonally inward & down from the right silhouette bumps
    vr1, rr1, ir1 = eval_crescent_fold(u, dy, 0.86, 30.0, 0.34, arch_px=-8.0, thick_px=12.0, tilt=-22.0)
    vr2, rr2, ir2 = eval_crescent_fold(u, dy, 0.82, 64.0, 0.38, arch_px=-9.0, thick_px=11.0, tilt=-18.0)
    vr3, rr3, ir3 = eval_crescent_fold(u, dy, 0.88, 98.0, 0.26, arch_px=-5.0, thick_px=8.0, tilt=-14.0)

    # 4. Radiating V-fan / mountain tent rays directly from the mouse grab peak!
    du_g = u - grab_u
    dy_pos = np.maximum(1.0, dy + 2.0)
    ang = np.arctan2(du_g * 120.0, dy_pos)
    rad_env = smoothstep(3.0, 18.0, dy) * np.exp(-np.maximum(0.0, dy) / 95.0)

    ray_valley = np.zeros((ch, cw), dtype=np.float32)
    ray_ridge = np.zeros((ch, cw), dtype=np.float32)
    ray_ink = np.zeros((ch, cw), dtype=np.float32)
    # Central bright mountain spine + shadowed sloping flanks + diagonal pull-rays!
    rays = [(-0.74, 0.17, 0.82), (-0.34, 0.14, 1.0), (0.04, 0.13, 0.90), (0.40, 0.15, 1.0), (0.78, 0.17, 0.80)]
    for a0, aw, strength in rays:
        da = (ang - a0) / aw
        ray_valley = np.maximum(ray_valley, np.exp(-((da - 0.48) ** 2) * 2.1) * rad_env * strength)
        ray_ridge = np.maximum(ray_ridge, np.exp(-((da + 0.46) ** 2) * 2.3) * rad_env * strength)
        ray_ink = np.maximum(ray_ink, np.exp(-(da ** 2) * 16.0) * rad_env * strength)

    # Triangular mountain shadow wedge directly under the pull point (center shadow mountain peak!)
    mtn_wedge = np.exp(-((du_g * 3.2) / (0.36 + np.maximum(0.0, dy) * 0.009)) ** 2) * smoothstep(2.0, 14.0, dy) * np.exp(-np.maximum(0.0, dy) / 68.0)

    if mode == "galgame_soft":
        # Painterly Galgame CG: smooth central mountain shadow + soft interlocking protruding side folds!
        total_valley = np.maximum.reduce([v_mtn1 * 1.05, v_mtn2 * 0.78, vl1 * 0.95, vl2 * 0.80, vl3 * 0.50, vr1 * 0.95, vr2 * 0.82, vr3 * 0.50, mtn_wedge * 0.55])
        total_ridge = np.maximum.reduce([r_mtn1 * 1.05, r_mtn2 * 0.82, rl1 * 0.95, rl2 * 0.80, rr1 * 0.95, rr2 * 0.80])
        total_ink = np.zeros_like(total_valley)

    elif mode == "cel_crescent":
        # Crisp two-tone anime cel-shading crescent shadows!
        total_valley = np.maximum.reduce([v_mtn1 * 1.08, v_mtn2 * 0.84, vl1 * 0.95, vl2 * 0.82, vr1 * 0.95, vr2 * 0.84])
        total_ridge = np.maximum.reduce([r_mtn1 * 1.0, r_mtn2 * 0.8, rl1 * 0.92, rl2 * 0.78, rr1 * 0.92, rr2 * 0.78])
        total_ink = np.maximum.reduce([i_mtn1 * 0.5, il1 * 0.45, ir1 * 0.45])

    elif mode == "manga_ink":
        # Japanese Manga tapered ink fold lines + soft velvet pockets!
        total_valley = np.maximum.reduce([v_mtn1 * 0.92, v_mtn2 * 0.72, vl1 * 0.88, vl2 * 0.75, vr1 * 0.88, vr2 * 0.75])
        total_ridge = np.maximum.reduce([r_mtn1 * 0.95, rl1 * 0.85, rr1 * 0.85, rl2 * 0.7, rr2 * 0.7])
        total_ink = np.maximum.reduce([i_mtn1 * 1.05, i_mtn2 * 0.80, il1 * 0.95, il2 * 0.78, ir1 * 0.95, ir2 * 0.78])

    elif mode == "deep_sculpt":
        # Sculpted deep double-layer velvet shadows + dramatic warm skin-through raised ridges!
        total_valley = np.maximum.reduce([v_mtn1 * 1.15, v_mtn2 * 0.90, vl1 * 1.05, vl2 * 0.88, vl3 * 0.58, vr1 * 1.05, vr2 * 0.90, vr3 * 0.58])
        total_ridge = np.maximum.reduce([r_mtn1 * 1.18, r_mtn2 * 0.95, rl1 * 1.10, rl2 * 0.90, rr1 * 1.10, rr2 * 0.90])
        total_ink = np.maximum.reduce([i_mtn1 * 0.35, il1 * 0.30, ir1 * 0.30])

    elif mode == "radiating_v":
        # Strong cursor-centered radiating mountain-peak V-folds + gathered side pockets!
        total_valley = np.maximum.reduce([ray_valley * 1.05, vl1 * 0.82, vr1 * 0.82, vl2 * 0.65, vr2 * 0.65])
        total_ridge = np.maximum.reduce([ray_ridge * 1.08, rl1 * 0.85, rr1 * 0.85])
        total_ink = np.maximum.reduce([ray_ink * 0.55, il1 * 0.45, ir1 * 0.45])

    elif mode == "hybrid_recommended":
        # Hybrid: cursor-pointing radiating mountain peak + clean sculpted left/right protruding side-bulge crescents!
        total_valley = np.maximum.reduce([ray_valley * 0.88, v_mtn1 * 0.92, vl1 * 0.95, vl2 * 0.76, vr1 * 0.95, vr2 * 0.78])
        total_ridge = np.maximum.reduce([ray_ridge * 0.92, r_mtn1 * 0.95, rl1 * 0.98, rl2 * 0.80, rr1 * 0.98, rr2 * 0.80])
        total_ink = np.maximum.reduce([ray_ink * 0.32, i_mtn1 * 0.36, il1 * 0.42, ir1 * 0.42])

    # Strictly localized to upper pull zone (below ~125px fades completely into calm smooth matte stocking!)
    fold_mask = smoothstep(1.0, 10.0, dy) * np.exp(-np.maximum(0.0, dy - 82.0) / 52.0)
    total_valley *= fold_mask
    total_ridge *= fold_mask
    total_ink *= fold_mask

    under_cuff_sh = smoothstep(cuff_h - 1.0, cuff_h + 3.0, dy) * np.exp(-np.maximum(0.0, dy - cuff_h) * 0.22) * 0.22

    if mode == "cel_crescent":
        val_shaped = smoothstep(0.24, 0.38, total_valley) * 0.92 + total_valley * 0.14
        rid_shaped = smoothstep(0.30, 0.54, total_ridge) * 0.82
    elif mode == "deep_sculpt":
        val_shaped = np.power(np.clip(total_valley, 0.0, 1.0), 0.78) * 1.18
        rid_shaped = np.power(np.clip(total_ridge, 0.0, 1.0), 0.85) * 1.15
    else:
        val_shaped = np.clip(total_valley, 0.0, 1.15) * style_cfg["valley_str"]
        rid_shaped = np.clip(total_ridge, 0.0, 1.15) * style_cfg["ridge_str"]

    # Optical matte velvet physics:
    # - Shadow valley (stacked folded fabric): translucency drops -> rich dark velvet plum!
    # - Raised protruding ridge (stretched crest): translucency rises -> warm rosy-peach skin glows softly through!
    trans_folded = np.clip(
        trans * (1.0 - val_shaped * 0.66) + rid_shaped * style_cfg["ridge_trans_boost"] * (0.35 + 0.65 * nz),
        0.04,
        0.86,
    )

    warm_skin = skin_rgb * skin_tint
    velvet_dye = edge_col * (1.0 - nz[:, :, None] ** 0.75) + base_col * (nz[:, :, None] ** 0.75)
    stock_rgb = velvet_dye * (1.0 - trans_folded[:, :, None]) + (warm_skin * (0.42 + 0.58 * velvet_dye * 1.45 + 0.36)) * trans_folded[:, :, None]

    # Deepen shadow valleys toward rich cool-plum velvet shadow
    shadow_tint = np.array([0.11, 0.075, 0.19], dtype=np.float32)[None, None, :]
    val_darken = np.clip(val_shaped * style_cfg["shadow_dark"], 0.0, 0.68)[:, :, None]
    stock_rgb = stock_rgb * (1.0 - val_darken) + shadow_tint * val_darken

    # Warm soft matte ridge lift (never silver/plastic!)
    ridge_col = np.array([0.92, 0.76, 0.84], dtype=np.float32)[None, None, :]
    stock_rgb = stock_rgb + ridge_col * (np.clip(rid_shaped * style_cfg["ridge_lift"], 0.0, 0.16) * (0.35 + 0.65 * nz))[:, :, None]

    # Tapered manga/anime crease ink accents
    ink_str = style_cfg.get("ink_str", 0.0)
    if ink_str > 0.0:
        ink_col = np.array([0.12, 0.08, 0.21], dtype=np.float32)[None, None, :]
        ink_a = np.clip(total_ink * ink_str, 0.0, 0.82)[:, :, None]
        stock_rgb = stock_rgb * (1.0 - ink_a) + ink_col * ink_a

    # Subtle cuff ribbing & under-cuff shadow
    cuff_rib = 0.5 + 0.5 * np.sin(u * 130.0)
    stock_rgb = stock_rgb * (1.0 - in_cuff[:, :, None] * 0.14 + (in_cuff * (cuff_rib - 0.5) * 0.045)[:, :, None])
    stock_rgb = stock_rgb * (1.0 - under_cuff_sh[:, :, None])

    rng = np.random.default_rng(7)
    grain = rng.normal(0.0, 0.011, (ch, cw)).astype(np.float32)
    stock_rgb = stock_rgb * (1.0 + grain[:, :, None])

    # Clean anime contour outline following the protruding cloth silhouette
    outline_col = edge_col * 0.52
    stock_rgb = stock_rgb * (1.0 - cloth_edge_outline[:, :, None] * 0.72) + outline_col * (cloth_edge_outline[:, :, None] * 0.72)
    stock_rgb = np.clip(stock_rgb, 0.0, 1.0)

    # Composite cleanly onto cropped bare leg (zero 1px peach edge!)
    out_rgb = base_crop[:, :, :3].copy()
    out_a = leg_a.copy()

    above_m = (dy < 0.0) & (dy > -15.0) & (leg_a > 0.02)
    if np.any(above_m):
        d_ab = np.maximum(0.0, -dy)
        ao = np.exp(-d_ab * 0.30) * smoothstep(14.0, 1.0, d_ab) * (0.65 + 0.35 * np.sin(u * math.pi)) * 0.26
        sh_c = out_rgb * np.array([0.82, 0.72, 0.75], dtype=np.float32)
        out_rgb = np.where(above_m[:, :, None], out_rgb * (1.0 - ao[:, :, None]) + sh_c * ao[:, :, None], out_rgb)

    stock_cov = top_lip * cloth_x_mask * smoothstep(-2.0, 0.5, dy)
    final_a = np.maximum(out_a * (1.0 - stock_cov), stock_cov)
    final_rgb = np.where(
        final_a[:, :, None] > 1e-4,
        (out_rgb * (out_a * (1.0 - stock_cov))[:, :, None] + stock_rgb * stock_cov[:, :, None]) / np.maximum(1e-4, final_a[:, :, None]),
        0.0,
    )

    sa = skirt_crop[:, :, 3:4]
    final_rgb = final_rgb * (1.0 - sa) + skirt_crop[:, :, :3] * sa
    final_a = np.maximum(final_a, skirt_crop[:, :, 3])

    rgba = np.dstack([np.clip(final_rgb * 255.0, 0, 255).astype(np.uint8), np.clip(final_a * 255.0, 0, 255).astype(np.uint8)])
    img = Image.fromarray(rgba, mode="RGBA")

    # Small clear pink cursor pull-point indicator at (grab_u, cuff_y)
    draw = ImageDraw.Draw(img)
    gy_abs = cuff_base_y + 26.0 + 4.0
    gx_img = float(np.interp(gy_abs, ys, xl_cloth[:, 0])) + grab_u * float(np.interp(gy_abs, ys, cloth_w[:, 0]))
    gx = gx_img - cx0
    gy = gy_abs - cy0
    draw.ellipse([gx - 5, gy - 5, gx + 5, gy + 5], fill=(244, 114, 182, 200), outline=(255, 255, 255, 235), width=1)
    draw.line([(gx, gy + 6), (gx, gy + 19)], fill=(255, 220, 240, 210), width=2)
    draw.polygon([(gx - 4, gy + 16), (gx + 4, gy + 16), (gx, gy + 22)], fill=(255, 220, 240, 210))

    return img


def main():
    manifest, legs, skirt = load_base()

    styles = [
        {
            "id": "1",
            "mode": "galgame_soft",
            "title": "风格 #1：Galgame 厚涂山峰柔影",
            "desc": "顺鼠标柔和山峰暗部 + 两侧圆润突起褶皱，无硬描边纯厚涂过渡",
            "side_bulge_px": 5.2,
            "valley_str": 1.0,
            "ridge_str": 1.0,
            "ridge_trans_boost": 0.16,
            "shadow_dark": 0.56,
            "ridge_lift": 0.08,
            "ink_str": 0.0,
        },
        {
            "id": "2",
            "mode": "cel_crescent",
            "title": "风格 #2：赛璐璐二分硬边月牙影",
            "desc": "干净利落的动漫二分硬边月牙阴影 + 尖尾收束，桌面小窗极其清晰",
            "side_bulge_px": 4.8,
            "valley_str": 1.0,
            "ridge_str": 0.95,
            "ridge_trans_boost": 0.18,
            "shadow_dark": 0.58,
            "ridge_lift": 0.08,
            "ink_str": 0.18,
        },
        {
            "id": "3",
            "mode": "manga_ink",
            "title": "风格 #3：日漫精绘折线 + 柔雾影",
            "desc": "两头渐细的细腻漫画折痕线稿 + 柔雾丝绒暗部，手绘二次元味最浓",
            "side_bulge_px": 5.2,
            "valley_str": 0.90,
            "ridge_str": 0.92,
            "ridge_trans_boost": 0.15,
            "shadow_dark": 0.48,
            "ridge_lift": 0.075,
            "ink_str": 0.72,
        },
        {
            "id": "4",
            "mode": "deep_sculpt",
            "title": "风格 #4：高立体深褶双层叠暗",
            "desc": "褶谷因双层叠布浓郁发深，山脊绷紧处透出明显暖肤，立体起伏最强",
            "side_bulge_px": 6.2,
            "valley_str": 1.15,
            "ridge_str": 1.15,
            "ridge_trans_boost": 0.24,
            "shadow_dark": 0.66,
            "ridge_lift": 0.10,
            "ink_str": 0.14,
        },
        {
            "id": "5",
            "mode": "radiating_v",
            "title": "风格 #5：放射状鼠标山峰 V 褶",
            "desc": "以鼠标抓点为顶点向下呈扇形放射出山峰状张力折痕 + 两侧收褶",
            "side_bulge_px": 4.8,
            "valley_str": 1.05,
            "ridge_str": 1.0,
            "ridge_trans_boost": 0.18,
            "shadow_dark": 0.58,
            "ridge_lift": 0.09,
            "ink_str": 0.25,
        },
        {
            "id": "6",
            "mode": "hybrid_recommended",
            "title": "风格 #6：放射山峰 + 两侧突起融合版",
            "desc": "结合 #5 的鼠标指向山峰阴影与 #1/#4 的左右自然突起弧褶，动静俱佳",
            "side_bulge_px": 5.6,
            "valley_str": 1.05,
            "ridge_str": 1.05,
            "ridge_trans_boost": 0.20,
            "shadow_dark": 0.60,
            "ridge_lift": 0.09,
            "ink_str": 0.22,
        },
    ]

    card_w, card_h = 480, 680
    pad = 24
    cols, rows = 3, 2
    canvas_w = cols * card_w + (cols + 1) * pad
    canvas_h = rows * card_h + (rows + 1) * pad + 62

    sheet = Image.new("RGBA", (canvas_w, canvas_h), (16, 18, 28, 255))
    draw = ImageDraw.Draw(sheet)

    font_paths = [
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
    ]
    font_title = font_sub = font_hdr = ImageFont.load_default()
    for fp in font_paths:
        if os.path.exists(fp):
            font_hdr = ImageFont.truetype(fp, 22)
            font_title = ImageFont.truetype(fp, 18)
            font_sub = ImageFont.truetype(fp, 13)
            break

    draw.text(
        (pad, 16),
        "漫画 / Galgame 下拽丝袜褶皱光影 6 套候选（粉点 = 鼠标下拽抓点 · 含左右轮廓自然突起）",
        fill=(240, 238, 255, 255),
        font=font_hdr,
    )

    for idx, cfg in enumerate(styles):
        col = idx % cols
        row = idx // cols
        x0 = pad + col * (card_w + pad)
        y0 = 58 + pad + row * (card_h + pad)

        draw.rounded_rectangle(
            [x0, y0, x0 + card_w, y0 + card_h],
            radius=18,
            fill=(28, 31, 44, 255),
            outline=(96, 86, 146, 145),
            width=2,
        )

        crop_img = render_pulled_leg_style(legs, skirt, manifest, cfg)
        avail_h = card_h - 86
        scale = avail_h / float(crop_img.height)
        rw, rh = int(round(crop_img.width * scale)), int(round(crop_img.height * scale))
        resized = crop_img.resize((rw, rh), Image.Resampling.LANCZOS)
        px = x0 + (card_w - rw) // 2
        py = y0 + 12
        sheet.alpha_composite(resized, (px, py))

        draw.rounded_rectangle([x0 + 14, y0 + 14, x0 + 54, y0 + 44], radius=10, fill=(139, 92, 246, 220))
        draw.text((x0 + 25, y0 + 17), f"#{cfg['id']}", fill=(255, 255, 255, 255), font=font_title)

        draw.rectangle([x0 + 2, y0 + card_h - 68, x0 + card_w - 2, y0 + card_h - 2], fill=(20, 22, 34, 240))
        draw.text((x0 + 16, y0 + card_h - 60), cfg["title"], fill=(244, 240, 255, 255), font=font_title)
        draw.text((x0 + 16, y0 + card_h - 32), cfg["desc"], fill=(170, 176, 206, 255), font=font_sub)

    rgb_out = sheet.convert("RGB")
    rgb_out.save(OUT_PUBLIC, quality=95)
    rgb_out.save(OUT_ARTIFACT, quality=95)
    print(f"Saved upgraded 6 fold samples to {OUT_PUBLIC}")


if __name__ == "__main__":
    main()
