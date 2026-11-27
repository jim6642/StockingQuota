import json
import math
import os
import shutil
from collections import deque
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

PROJECT_DIR = r"C:\Users\Fan Haorong\.gemini\antigravity\scratch\StockingQuota"
BRAIN_DIR = r"C:\Users\Fan Haorong\.gemini\antigravity\brain\b7a2f387-9930-4bfc-b232-9b53a40ca478"
RAW_LEGS_SRC = os.path.join(BRAIN_DIR, "legs_raw_1795694915784.jpg")
RAW_HANDS_SRC = os.path.join(BRAIN_DIR, "anime_female_hands_sheet_1795700740138.jpg")

RAW_DIR = os.path.join(PROJECT_DIR, "raw_assets")
OUT_DIR = os.path.join(PROJECT_DIR, "public", "assets")
os.makedirs(RAW_DIR, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)


def remove_white_bg_smart(img: Image.Image, remove_interior_white_holes: bool = False) -> Image.Image:
    """
    Flood-fill background removal from borders + optional interior pure-white hole removal
    (for closed finger loops), followed by soft anti-aliased edge matting & white-halo decontamination.
    """
    rgb = np.array(img.convert("RGB"), dtype=np.float32)
    h, w, _ = rgb.shape

    # Identify near-white background candidates: high brightness & low chroma
    max_c = rgb.max(axis=2)
    min_c = rgb.min(axis=2)
    chroma = max_c - min_c
    luma = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]

    is_bg_cand = (luma > 240.0) & (chroma < 14.0)

    # 1. Flood fill from all 4 image edges
    bg_mask = np.zeros((h, w), dtype=bool)
    q = deque()

    for x in range(w):
        if is_bg_cand[0, x] and not bg_mask[0, x]:
            bg_mask[0, x] = True
            q.append((0, x))
        if is_bg_cand[h - 1, x] and not bg_mask[h - 1, x]:
            bg_mask[h - 1, x] = True
            q.append((h - 1, x))
    for y in range(h):
        if is_bg_cand[y, 0] and not bg_mask[y, 0]:
            bg_mask[y, 0] = True
            q.append((y, 0))
        if is_bg_cand[y, w - 1] and not bg_mask[y, w - 1]:
            bg_mask[y, w - 1] = True
            q.append((y, w - 1))

    while q:
        cy, cx = q.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < h and 0 <= nx < w and not bg_mask[ny, nx] and is_bg_cand[ny, nx]:
                bg_mask[ny, nx] = True
                q.append((ny, nx))

    # 2. Optional: remove enclosed pure-white holes (e.g. loop between pinching fingers & tiny gaps)
    if remove_interior_white_holes:
        pure_white = (luma > 242.0) & (chroma < 11.0) & (~bg_mask)
        visited = np.zeros((h, w), dtype=bool)
        for y in range(h):
            for x in range(w):
                if pure_white[y, x] and not visited[y, x]:
                    comp = []
                    cq = deque([(y, x)])
                    visited[y, x] = True
                    while cq:
                        py, px = cq.popleft()
                        comp.append((py, px))
                        for ny, nx in ((py - 1, px), (py + 1, px), (py, px - 1), (py, px + 1)):
                            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and pure_white[ny, nx]:
                                visited[ny, nx] = True
                                cq.append((ny, nx))
                    # Remove both the main thumb-index loop and tiny finger-gap holes (>= 8 px)
                    if len(comp) >= 8:
                        for py, px in comp:
                            bg_mask[py, px] = True

    # 3. Compute soft alpha on the 2-pixel fringe bordering bg_mask to eliminate white haloing
    alpha = np.where(bg_mask, 0.0, 1.0).astype(np.float32)

    # Dilate bg_mask by 2px to locate fringe pixels on the foreground side
    bg_img = Image.fromarray((bg_mask.astype(np.uint8) * 255))
    dilated_1 = np.array(bg_img.filter(ImageFilter.MaxFilter(3))) > 0
    dilated_2 = np.array(bg_img.filter(ImageFilter.MaxFilter(5))) > 0
    fringe = dilated_2 & (~bg_mask)

    # Estimate alpha for fringe pixels blended with white (255, 255, 255):
    # A pixel near pure white on the outer edge gets proportional soft alpha & color un-blending
    dist_from_white = np.sqrt(
        (255.0 - rgb[:, :, 0]) ** 2 +
        (255.0 - rgb[:, :, 1]) ** 2 +
        (255.0 - rgb[:, :, 2]) ** 2
    ) / (255.0 * math.sqrt(3))

    # Fringe pixels closer to bg get softer alpha
    fringe_alpha = np.clip(dist_from_white * 4.2, 0.0, 1.0)
    # Apply stronger softening on immediate 1px boundary, lighter on 2px ring
    ring1 = dilated_1 & (~bg_mask)
    ring2 = fringe & (~ring1)
    alpha = np.where(ring1, np.minimum(alpha, fringe_alpha), alpha)
    alpha = np.where(ring2, np.minimum(alpha, np.clip(fringe_alpha * 1.65, 0.0, 1.0)), alpha)

    # Un-premultiply white background from semi-transparent edge pixels:
    # C_obs = a * C_fg + (1 - a) * 255  =>  C_fg = (C_obs - (1 - a) * 255) / a
    safe_a = np.maximum(alpha, 0.12)
    decontam = np.clip((rgb - (1.0 - alpha[:, :, None]) * 255.0) / safe_a[:, :, None], 0.0, 255.0)
    out_rgb = np.where(fringe[:, :, None], decontam, rgb)

    # Subtle 0.4px smoothing on alpha for silky edges
    alpha_u8 = np.clip(alpha * 255.0, 0, 255).astype(np.uint8)
    rgba = np.dstack([out_rgb.astype(np.uint8), alpha_u8])
    return Image.fromarray(rgba, mode="RGBA")


def smooth_1d(arr: np.ndarray, window: int = 9) -> np.ndarray:
    if len(arr) < window:
        return arr.copy()
    pad = window // 2
    padded = np.pad(arr, (pad, pad), mode="edge")
    kernel = np.hanning(window + 2)[1:-1]
    kernel /= kernel.sum()
    return np.convolve(padded, kernel, mode="valid")


def process_legs():
    shutil.copyfile(RAW_LEGS_SRC, os.path.join(RAW_DIR, "legs_raw.jpg"))
    img = Image.open(RAW_LEGS_SRC)
    # Resize to a crisp, GPU-friendly high-res working size (768x1024)
    target_w = 768
    target_h = int(round(img.height * (target_w / img.width)))
    img = img.resize((target_w, target_h), Image.Resampling.LANCZOS)

    rgba_img = remove_white_bg_smart(img, remove_interior_white_holes=False)
    arr = np.array(rgba_img)
    h, w, _ = arr.shape
    alpha = arr[:, :, 3]
    r = arr[:, :, 0].astype(np.float32)
    g = arr[:, :, 1].astype(np.float32)
    b = arr[:, :, 2].astype(np.float32)

    # Separate the pleated indigo-slate skirt hem at the top so stockings slide cleanly UNDER it!
    # Skirt pixels are in the top 25% of image and bluish/dark compared to warm peachy skin (R > B + 12)
    ys, xs = np.mgrid[0:h, 0:w]
    is_opaque = alpha > 40
    is_skirt_color = (ys < int(h * 0.26)) & is_opaque & ((b >= r - 12.0) | ((r + g + b) / 3.0 < 155.0))

    # Flood-fill skirt from the top row downward so we don't catch leg outlines
    skirt_mask = np.zeros((h, w), dtype=bool)
    sq = deque()
    for x in range(w):
        if is_skirt_color[0, x] or (is_opaque[0, x] and ys[0, x] == 0):
            skirt_mask[0, x] = True
            sq.append((0, x))
    while sq:
        cy, cx = sq.popleft()
        for ny, nx in ((cy - 1, cx), (cy + 1, cx), (cy, cx - 1), (cy, cx + 1)):
            if 0 <= ny < int(h * 0.26) and 0 <= nx < w and not skirt_mask[ny, nx] and is_skirt_color[ny, nx]:
                skirt_mask[ny, nx] = True
                sq.append((ny, nx))

    # Include only dark skirt outline pixels along the skirt hem (never peach skin pixels!)
    skirt_pil = Image.fromarray((skirt_mask.astype(np.uint8) * 255))
    dilated_skirt = np.array(skirt_pil.filter(ImageFilter.MaxFilter(3))) > 0
    luma_all = 0.299 * r + 0.587 * g + 0.114 * b
    skirt_clean = skirt_mask | (dilated_skirt & is_opaque & (luma_all < 165.0))
    skirt_soft = np.array(
        Image.fromarray((skirt_clean.astype(np.uint8) * 255)).filter(ImageFilter.GaussianBlur(0.35)),
        dtype=np.float32,
    ) / 255.0

    skirt_rgba = arr.copy()
    skirt_rgba[:, :, 3] = np.clip(arr[:, :, 3].astype(np.float32) * skirt_soft, 0, 255).astype(np.uint8)
    Image.fromarray(skirt_rgba, mode="RGBA").save(os.path.join(OUT_DIR, "skirt_overlay.png"))

    # Save full bare legs + skirt as base layer
    rgba_img.save(os.path.join(OUT_DIR, "legs_bare.png"))

    # Find lowest skirt Y per column over each thigh to know where bare thighs start
    skirt_bottom_y = np.zeros(w, dtype=np.int32)
    for x in range(w):
        col = np.where(skirt_mask[:, x])[0]
        skirt_bottom_y[x] = int(col.max()) if len(col) > 0 else 0

    # Estimate representative skin tone from mid-thigh region
    skin_sample = arr[int(h * 0.25):int(h * 0.42), :, :]
    skin_mask = (skin_sample[:, :, 3] > 230) & (skin_sample[:, :, 0] > 215) & (skin_sample[:, :, 1] > 180)
    skin_rgb = skin_sample[skin_mask][:, :3].mean(axis=0).tolist() if skin_mask.any() else [248.0, 224.0, 212.0]

    # Extract clean left & right leg contours from below the skirt down to the toes!
    mid_x = w // 2
    # Refine mid_x using the widest gap center in mid-leg
    gap_centers = []
    for y in range(int(h * 0.24), int(h * 0.85)):
        row = alpha[y] > 100
        left_xs = np.where(row[:mid_x])[0]
        right_xs = np.where(row[mid_x:])[0] + mid_x
        if len(left_xs) > 10 and len(right_xs) > 10:
            gap_centers.append(0.5 * (left_xs.max() + right_xs.min()))
    split_x = int(round(np.median(gap_centers))) if gap_centers else mid_x

    def extract_leg_meta(side: str):
        x0 = 0 if side == "left" else split_x
        x1 = split_x if side == "left" else w

        # Find yStart (just under skirt hem) and yToe (lowest opaque pixel)
        # Look at rows where leg skin exists below skirt
        row_bounds = {}
        for y in range(int(h * 0.14), h):
            # Exclude skirt pixels
            valid = (alpha[y, x0:x1] > 90) & (~skirt_mask[y, x0:x1])
            xs_local = np.where(valid)[0]
            if len(xs_local) >= 8:
                xl = float(xs_local.min() + x0)
                xr = float(xs_local.max() + x0)
                row_bounds[y] = (xl, xr)

        ys_valid = sorted(row_bounds.keys())
        # yFullThigh: where full thigh width appears right below lowest skirt pleat
        widths = np.array([row_bounds[y][1] - row_bounds[y][0] for y in ys_valid])
        max_thigh_w = widths[:int(len(widths) * 0.25)].max()
        y_full_thigh = next(y for y in ys_valid if (row_bounds[y][1] - row_bounds[y][0]) > max_thigh_w * 0.88)
        y_toe = ys_valid[-1]

        # Find the HIGHEST skirt hem edge over this thigh so 100% quota tucks completely UNDER the skirt!
        thigh_xl, thigh_xr = row_bounds[y_full_thigh]
        skirt_cols = skirt_bottom_y[int(thigh_xl):int(thigh_xr) + 1]
        valid_skirt_cols = skirt_cols[skirt_cols > 40]
        y_skirt_min = int(valid_skirt_cols.min()) if len(valid_skirt_cols) > 0 else (y_full_thigh - 28)
        # 100% quota sits cleanly 44px ABOVE the highest skirt hem pleat so both the cuff band and
        # shadow margin vanish completely under the skirt -> ZERO exposed skin or half-peeking cuff at 100%!
        y_top_under_skirt = max(72.0, float(y_skirt_min - 44))

        # Detect ankle (minimum leg width between 72% and 89% of image height)
        ankle_candidates = [y for y in ys_valid if int(h * 0.72) <= y <= int(h * 0.89)]
        y_ankle = min(ankle_candidates, key=lambda y: row_bounds[y][1] - row_bounds[y][0])
        y_instep = float(y_ankle) + (float(y_toe) - float(y_ankle)) * 0.46

        # Build dense contour from well under the skirt hem down to y_toe!
        y_min_sample = max(40.0, y_top_under_skirt - 24.0)
        sample_ys = np.linspace(y_min_sample, y_toe, 240)
        raw_xl = np.zeros_like(sample_ys)
        raw_xr = np.zeros_like(sample_ys)

        for i, yf in enumerate(sample_ys):
            yi = int(round(yf))
            if yi in row_bounds:
                xl, xr = row_bounds[yi]
            else:
                nearest = min(ys_valid, key=lambda v: abs(v - yi))
                xl, xr = row_bounds[nearest]
            raw_xl[i] = xl
            raw_xr[i] = xr

        # Extrapolate thigh contour smoothly upward under the skirt hem from y_full_thigh
        top_idx = int(np.searchsorted(sample_ys, y_full_thigh + 6))
        if top_idx > 2 and top_idx + 8 < len(sample_ys):
            slope_l = (raw_xl[top_idx + 8] - raw_xl[top_idx]) / max(1e-5, sample_ys[top_idx + 8] - sample_ys[top_idx])
            slope_r = (raw_xr[top_idx + 8] - raw_xr[top_idx]) / max(1e-5, sample_ys[top_idx + 8] - sample_ys[top_idx])
            for i in range(top_idx):
                dy = sample_ys[i] - sample_ys[top_idx]
                raw_xl[i] = raw_xl[top_idx] + slope_l * dy
                raw_xr[i] = raw_xr[top_idx] + slope_r * dy

        sm_xl = smooth_1d(raw_xl, window=9)
        sm_xr = smooth_1d(raw_xr, window=9)

        slices = []
        for i in range(len(sample_ys)):
            xl = float(sm_xl[i])
            xr = float(sm_xr[i])
            slices.append({
                "y": round(float(sample_ys[i]) / h, 5),
                "xLeft": round(xl, 2),
                "xRight": round(xr, 2),
                "cx": round(0.5 * (xl + xr), 2),
                "halfWidth": round(0.5 * (xr - xl), 2),
            })

        return {
            "side": side,
            "yTop": round(float(y_top_under_skirt), 2),   # 100% quota tucked completely under skirt hem!
            "yAnkle": round(float(y_ankle), 2),           # ~14% quota sits at slender ankle
            "yInstep": round(float(y_instep), 2),         # low quota rolls over instep
            "yToe": round(float(y_toe), 2),
            "slices": slices,
        }

    left_meta = extract_leg_meta("left")
    right_meta = extract_leg_meta("right")
    return w, h, skin_rgb, left_meta, right_meta, rgba_img


def process_hands():
    shutil.copyfile(RAW_HANDS_SRC, os.path.join(RAW_DIR, "hands_v2_raw.jpg"))
    img = Image.open(RAW_HANDS_SRC)
    w, h = img.size
    mx = w // 2
    r1 = int(round(h / 3.0))
    r2 = int(round((2.0 * h) / 3.0))

    # 2 columns x 3 rows anatomically verified sheet:
    # Left column  = Character's RIGHT hand (viewer's LEFT side, thumb inner-right, fingers outer-left)
    # Right column = Character's LEFT hand  (viewer's RIGHT side, thumb inner-left, fingers outer-right)
    cells = {
        "openLeft":    ((0, 0, mx, r1), "left", "open"),
        "openRight":   ((mx, 0, w, r1), "right", "open"),
        "gripLeft":    ((0, r1, mx, r2), "left", "grip"),
        "gripRight":   ((mx, r1, w, r2), "right", "grip"),
        "shieldLeft":  ((0, r2, mx, h), "left", "shield"),
        "shieldRight": ((mx, r2, w, h), "right", "shield"),
    }

    hands_meta = {}
    for name, (box, side, pose) in cells.items():
        crop = img.crop(box)
        rgba = remove_white_bg_smart(crop, remove_interior_white_holes=True)
        arr = np.array(rgba)
        alpha = arr[:, :, 3]

        # Tight crop around non-transparent hand with small padding
        ys, xs = np.where(alpha > 20)
        pad = 10
        y0 = max(0, int(ys.min()) - pad)
        y1 = min(arr.shape[0], int(ys.max()) + pad)
        x0 = max(0, int(xs.min()) - pad)
        x1 = min(arr.shape[1], int(xs.max()) + pad)
        sub = arr[y0:y1, x0:x1].copy()

        # Silky long vertical fade-out along the cut top wrist so arms emerge seamlessly from above!
        sh, sw, _ = sub.shape
        yy, _ = np.mgrid[0:sh, 0:sw]
        y_frac = yy / max(1.0, float(sh))
        fade = np.clip((y_frac - 0.03) / 0.25, 0.0, 1.0)
        fade = fade * fade * (3.0 - 2.0 * fade)
        sub[:, :, 3] = np.clip(sub[:, :, 3].astype(np.float32) * fade, 0, 255).astype(np.uint8)

        # Resize to crisp 280px width
        hand_pil = Image.fromarray(sub, mode="RGBA")
        out_w = 280
        out_h = int(round(sh * (out_w / sw)))
        hand_pil = hand_pil.resize((out_w, out_h), Image.Resampling.LANCZOS)

        filename = f"hand_{name}.png"
        hand_pil.save(os.path.join(OUT_DIR, filename))

        # Locate exact anatomical pivot!
        h_arr = np.array(hand_pil)
        h_alpha = h_arr[:, :, 3] > 120
        oys, oxs = np.where(h_alpha)
        max_y = int(oys.max())

        if pose == "grip":
            # Thumb + index pinch meets on the INNER half near the lower fingertips!
            inner_mask = (oxs > out_w * 0.52) if side == "left" else (oxs < out_w * 0.48)
            inner_ys = oys[inner_mask]
            inner_xs = oxs[inner_mask]
            pinch_y_max = int(inner_ys.max())
            tip_mask = inner_ys >= (pinch_y_max - 12)
            pivot_x = float(np.median(inner_xs[tip_mask])) / out_w
            pivot_y = float(pinch_y_max - 4) / out_h
        elif pose == "open":
            # Anchor near lower inner index/thumb fingertips
            inner_mask = (oxs > out_w * 0.40) if side == "left" else (oxs < out_w * 0.60)
            inner_ys = oys[inner_mask]
            inner_xs = oxs[inner_mask]
            low_mask = inner_ys >= (int(inner_ys.max()) - int(out_h * 0.14))
            pivot_x = float(np.mean(inner_xs[low_mask])) / out_w
            pivot_y = float(int(inner_ys.max()) - int(out_h * 0.05)) / out_h
        else:
            # Shielding cupped hand: center of palm/fingers so it covers the bare foot cleanly!
            pivot_x = 0.54 if side == "left" else 0.46
            pivot_y = 0.62

        hands_meta[name] = {
            "url": f"/assets/{filename}",
            "width": out_w,
            "height": out_h,
            "pivotX": round(pivot_x, 4),
            "pivotY": round(pivot_y, 4),
            "armAngle": round(-1.25 if side == "left" else -1.89, 4),
        }

    return hands_meta


def make_debug_preview(w, h, legs_rgba, left_meta, right_meta, hands_meta):
    # Render a dark-checkerboard debug verification image with contour overlays + hand pinch points
    bg = Image.new("RGBA", (w + 360, h), (26, 28, 38, 255))
    draw = ImageDraw.Draw(bg)
    # Checkerboard
    cell = 24
    for y in range(0, h, cell):
        for x in range(0, w + 360, cell):
            if ((x // cell) + (y // cell)) % 2 == 0:
                draw.rectangle([x, y, x + cell, y + cell], fill=(34, 37, 50, 255))

    bg.alpha_composite(legs_rgba, (0, 0))
    draw = ImageDraw.Draw(bg)

    for meta, color in ((left_meta, (180, 120, 255, 255)), (right_meta, (100, 220, 255, 255))):
        pts_l = [(s["xLeft"], s["y"] * h) for s in meta["slices"]]
        pts_r = [(s["xRight"], s["y"] * h) for s in meta["slices"]]
        draw.line(pts_l, fill=color, width=2)
        draw.line(pts_r, fill=color, width=2)
        for y_mark, col in ((meta["yTop"], (80, 255, 140, 255)), (meta["yAnkle"], (255, 180, 80, 255))):
            draw.line([(meta["slices"][0]["xLeft"] - 25, y_mark), (meta["slices"][0]["xRight"] + 25, y_mark)], fill=col, width=2)

    # Paste 6 processed hands in 2x3 layout on the right column with red crosshair on pinch pivot
    names = ["openLeft", "openRight", "gripLeft", "gripRight", "shieldLeft", "shieldRight"]
    for idx, name in enumerate(names):
        hm = hands_meta[name]
        hp = Image.open(os.path.join(OUT_DIR, os.path.basename(hm["url"])))
        scale = 0.56
        nw, nh = int(hp.width * scale), int(hp.height * scale)
        hp_s = hp.resize((nw, nh), Image.Resampling.LANCZOS)
        col = idx % 2
        row = idx // 2
        px = w + 16 + col * 172
        py = 24 + row * 310
        bg.alpha_composite(hp_s, (px, py))
        cx = px + hm["pivotX"] * nw
        cy = py + hm["pivotY"] * nh
        draw.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], outline=(255, 70, 100, 255), width=2)

    bg.convert("RGB").save(os.path.join(RAW_DIR, "debug_assets_verify.png"))


def main():
    w, h, skin_rgb, left_meta, right_meta, legs_rgba = process_legs()
    hands_meta = process_hands()

    manifest = {
        "imageWidth": w,
        "imageHeight": h,
        "legsUrl": "/assets/legs_bare.png",
        "skirtUrl": "/assets/skirt_overlay.png",
        "skinToneRgb": [round(c, 1) for c in skin_rgb],
        "legs": {
            "left": left_meta,
            "right": right_meta,
        },
        "hands": hands_meta,
    }

    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    make_debug_preview(w, h, legs_rgba, left_meta, right_meta, hands_meta)
    print(f"Processed assets OK! Legs: {w}x{h}, Skin RGB: {manifest['skinToneRgb']}")
    print(f"Left leg: yTop={left_meta['yTop']}, yAnkle={left_meta['yAnkle']}, yToe={left_meta['yToe']}")
    print(f"Right leg: yTop={right_meta['yTop']}, yAnkle={right_meta['yAnkle']}, yToe={right_meta['yToe']}")
    for k, v in hands_meta.items():
        print(f"Hand {k}: {v['width']}x{v['height']} pivot=({v['pivotX']}, {v['pivotY']})")


if __name__ == "__main__":
    main()
