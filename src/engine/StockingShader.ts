import { Shader, Texture } from 'pixi.js';
import { StockingVisualConfig } from './types';

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return [0.23, 0.16, 0.34];
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

const VERTEX_SHADER = `
precision highp float;

attribute vec2 aPosition;
attribute vec2 aUV;
attribute vec2 aStrain;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;

uniform vec2 uImageSize;

varying vec2 vLegUV;
varying vec2 vClothUV;
varying vec2 vStrain;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  vec3 pos = mvp * vec3(aPosition, 1.0);
  gl_Position = vec4(pos.xy, 0.0, 1.0);

  vLegUV = aPosition / uImageSize;
  vClothUV = aUV;
  vStrain = aStrain;
}
`;

/**
 * Matte Velvet Anime Stocking Shader + Style #6 Pull Folds + Crisp Semi-Circle Side Protrusions:
 * - Zero blurry semi-transparent outer halo!
 * - Crisp opaque semi-circle fabric bulges protrude smoothly right at the outer ends of each
 *   horizontal fold (and synced cleanly with the scalloped lace cuff when enabled!).
 */
const FRAGMENT_SHADER = `
precision highp float;

varying vec2 vLegUV;
varying vec2 vClothUV;
varying vec2 vStrain;

uniform sampler2D uLegsTex;

uniform vec3 uBaseColor;
uniform vec3 uHighlightColor;
uniform vec3 uSkinTone;
uniform float uDenier;
uniform float uSheen;
uniform float uFresnel;
uniform float uWrinkleStrength;
uniform float uWeaveIntensity;
uniform float uCuffHeight;
uniform float uCuffPinch;
uniform float uLaceCuff;

uniform float uTension;
uniform float uWrinkleEnergy;
uniform float uGrabU;
uniform float uLeftHandU;
uniform float uRightHandU;
uniform float uHandEngage;
uniform float uSnapPhase;
uniform float uSnapAmp;
uniform float uLegSpan;
uniform float uInstepRoll;
uniform float uSockAlpha;
uniform float uTime;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Crisp semi-circle protrusion profile (exact sqrt(1 - t^2) rounded lobe!)
float semiCircleBump(float dy, float yCenter, float radiusY, float maxOutPx) {
  float t = (dy - yCenter) / max(1.0, radiusY);
  if (abs(t) >= 1.0) return 0.0;
  return maxOutPx * sqrt(max(0.0, 1.0 - t * t));
}

// Evaluate one sculpted anime/Galgame curved crescent/mountain-ridge fold
vec3 evalCrescentFold(float u, float dy, float uCenter, float dyCenter, float widthU, float archPx, float thickPx, float tilt) {
  float du = (u - uCenter) / max(0.05, widthU);
  float spanEnv = clamp(1.0 - du * du, 0.0, 1.0);
  if (spanEnv <= 0.001) return vec3(0.0);

  float spanTaper = pow(spanEnv, 1.10);
  float dyArc = dyCenter - archPx * (1.0 - du * du) + tilt * (u - uCenter);
  float d = dy - dyArc;
  float localThick = max(1.5, thickPx * spanTaper);

  float sharpTop = smoothstep(-localThick * 0.25, localThick * 0.16, d);
  float softBot = 1.0 - smoothstep(localThick * 0.18, localThick * 1.45, d);
  float valley = sharpTop * softBot * spanTaper;

  float ridgeD = (d + localThick * 0.68) / max(2.2, localThick * 0.78);
  float ridge = exp(-ridgeD * ridgeD) * spanTaper;

  float inkW = max(0.8, 1.85 * spanTaper);
  float ink = exp(-(d / inkW) * (d / inkW)) * pow(spanEnv, 1.30);

  return vec3(valley, ridge, ink);
}

void main() {
  if (uSockAlpha < 0.005) discard;

  float uRaw = vClothUV.x;
  float u = clamp(uRaw, 0.0, 1.0);
  float clothPx = vClothUV.y;
  float compression = vStrain.x;
  // Exact signed pixel distance outside the bare-leg silhouette (> 0 outside bare leg)
  float outPx = vStrain.y;

  vec4 legSample = texture2D(uLegsTex, vLegUV);
  float legMask = legSample.a;

  // =========================================================================
  // 1. SOFT CUFF-HUG SHADOW RIGHT ABOVE THE CUFF (< 0, STRICTLY ON BARE LEG!)
  // =========================================================================
  if (clothPx < 0.0) {
    if (legMask < 0.05) discard;
    float dAbove = -clothPx;
    float aoBand = exp(-dAbove * 0.34) * smoothstep(13.0, 0.8, dAbove);
    float edgeWrap = 0.65 + 0.35 * sin(u * 3.14159);
    float shadowAlpha = aoBand * edgeWrap * 0.28 * uCuffPinch * legMask * uSockAlpha;
    vec3 shadowCol = mix(uSkinTone * vec3(0.76, 0.65, 0.68), uBaseColor * 0.55, 0.35);
    gl_FragColor = vec4(shadowCol * shadowAlpha, shadowAlpha);
    return;
  }

  // =========================================================================
  // 2. CRISP OPAQUE SEMI-CIRCLE SIDE PROTRUSIONS AT HORIZONTAL FOLDS & LACE!
  //    (ZERO blurry outer halo layer!)
  // =========================================================================
  float cuffH = max(10.0, uCuffHeight + uInstepRoll * 12.0 + uLaceCuff * 16.0);
  float pullIntensity = clamp(
    uTension * 0.92 + uWrinkleEnergy * 0.52 + max(0.0, compression) * 0.65 + uInstepRoll * 0.78,
    0.0,
    1.18
  ) * uWrinkleStrength;

  // Compute exact outward semi-circle protrusion (in px) ONLY at the left & right horizontal fold crests!
  // Synced 1:1 with fl1/fl2 (left edge y ≈ 22px, 56px) and fr1/fr2 (right edge y ≈ 24px, 58px)!
  float bumpAmp = min(5.4, pullIntensity * 4.4);
  float aboveAnkle = 1.0 - smoothstep(0.74, 0.82, vLegUV.y);
  float isLeftSide = step(uRaw, 0.5);

  float foldBumpPx = 0.0;
  if (bumpAmp > 0.15 && aboveAnkle > 0.01) {
    float snapShift = sin(uSnapPhase) * uSnapAmp * 3.0;
    if (isLeftSide > 0.5) {
      // Left outer horizontal fold semi-circles (just above fl1 & fl2 creases!)
      float b1 = semiCircleBump(clothPx, 20.0 + snapShift, 11.5, bumpAmp * 1.00);
      float b2 = semiCircleBump(clothPx, 53.0 + snapShift * 0.6, 12.5, bumpAmp * 0.78);
      foldBumpPx = max(b1, b2) * aboveAnkle;
    } else {
      // Right outer horizontal fold semi-circles (staggered naturally with fr1 & fr2!)
      float b1 = semiCircleBump(clothPx, 23.0 + snapShift, 11.5, bumpAmp * 0.96);
      float b2 = semiCircleBump(clothPx, 56.0 + snapShift * 0.6, 12.5, bumpAmp * 0.82);
      foldBumpPx = max(b1, b2) * aboveAnkle;
    }
  }

  // Sync subtle outer lace-edge semi-circle scallops along the lace cuff height when Lace Cuff is active!
  float laceSideBumpPx = 0.0;
  if (uLaceCuff > 0.5 && clothPx >= 0.0 && clothPx <= cuffH + 2.0) {
    float laceZone = smoothstep(0.0, 3.0, clothPx) * (1.0 - smoothstep(cuffH - 3.0, cuffH + 1.5, clothPx));
    float sideWave = 0.5 + 0.5 * sin((clothPx / max(1.0, cuffH)) * 3.14159 * 6.0);
    // Subtle crisp 1.4..2.4px embroidered lace thickness + fold sync on cuff edge
    laceSideBumpPx = (1.1 + 1.1 * sideWave + bumpAmp * 0.28) * laceZone;
  }

  // Subtle rolled cuff semi-circle when half-rolled on instep
  float instepBumpPx = uInstepRoll > 0.08 ? semiCircleBump(clothPx, cuffH * 0.5, cuffH * 0.55, uInstepRoll * 2.8) : 0.0;

  float totalBumpPx = max(max(foldBumpPx, laceSideBumpPx), instepBumpPx);

  // Pixel-crisp opaque mask for the protruding semi-circle (1.2px anti-aliased edge, NEVER a hazy aura!)
  float bumpMask = totalBumpPx > 0.25 ? smoothstep(totalBumpPx + 0.65, totalBumpPx - 0.65, outPx) : 0.0;
  float effectiveMask = max(legMask, bumpMask);
  if (effectiveMask < 0.015) discard;

  // Safe interior bare-skin sample for protruding semi-circle pixels outside legMask
  vec3 skinRgb;
  if (legMask > 0.72) {
    skinRgb = legSample.rgb / legMask;
  } else {
    float inwardDir = uRaw < 0.5 ? 1.0 : -1.0;
    vec4 innerSample = texture2D(uLegsTex, vLegUV + vec2(inwardDir * 0.020, 0.0));
    skinRgb = innerSample.a > 0.25 ? (innerSample.rgb / innerSample.a) : uSkinTone;
  }

  float skinLuma = dot(skinRgb, vec3(0.299, 0.587, 0.114));
  // Suppress inner bare-leg lineart right where an outer semi-circle bump smoothly continues the cloth!
  float insideBumpSmooth = totalBumpPx > 0.5 ? smoothstep(-1.5, 1.5, outPx) : 0.0;
  float lineArtMask = (1.0 - smoothstep(0.45, 0.72, skinLuma)) * smoothstep(0.55, 0.95, legMask) * (1.0 - insideBumpSmooth * 0.85);

  // =========================================================================
  // 3. PURE MATTE VELVET OPTICAL BASE (Anatomical Thigh / Knee / Shin Sheerness!)
  // =========================================================================
  float nx = clamp((u - 0.5) * 2.0, -0.995, 0.995);
  float nz = sqrt(max(0.015, 1.0 - nx * nx));
  float litAngle = clamp(nz * 0.90 + (-nx) * 0.18, 0.0, 1.0);

  float yNorm = vLegUV.y;
  float thighPeak = exp(-pow((yNorm - 0.305) / 0.115, 2.0));
  float kneePeak  = exp(-pow((yNorm - 0.432) / 0.045, 2.0));
  float shinPeak  = exp(-pow((yNorm - 0.600) / 0.135, 2.0));
  float ankleDark = smoothstep(0.70, 0.86, yNorm) * (1.0 - smoothstep(0.88, 0.97, yNorm));
  float toeCap    = smoothstep(0.91, 0.97, yNorm);

  float baseLuma = dot(uBaseColor, vec3(0.299, 0.587, 0.114));
  bool isLightStocking = baseLuma > 0.58;

  float denierFactor = clamp((86.0 - uDenier) / 68.0, 0.12, 1.15);
  float anatSheer = 1.0 + 0.16 * thighPeak + 0.28 * kneePeak + 0.13 * shinPeak - 0.22 * ankleDark;
  float grazing = pow(max(0.08, litAngle), mix(0.85, 1.65, clamp(uFresnel / 1.5, 0.0, 1.2)));
  float baseTrans = clamp(0.68 * denierFactor * pow(grazing, 1.20) * anatSheer, 0.0, 0.84);

  // =========================================================================
  // 4. ELASTIC CUFF BAND (Classic Matte Rib OR Scalloped Gothic Lace!)
  // =========================================================================
  float topLipAlpha = smoothstep(0.0, 1.6, clothPx);
  float inCuff = 0.0;
  float laceSolid = 0.0;
  float underCuffShadow = 0.0;

  if (uLaceCuff > 0.5) {
    float scallopTop = sin(u * 3.14159 * 12.0) * 3.0;
    float scallopBot = sin(u * 3.14159 * 12.0 + 1.5) * 4.0;
    topLipAlpha = smoothstep(0.0, 1.8, clothPx + scallopTop);
    inCuff = (1.0 - smoothstep(cuffH - 4.0, cuffH + 2.0, clothPx + scallopBot)) * topLipAlpha;

    float lx = u * 12.0 * 3.14159;
    float ly = (clothPx / max(1.0, cuffH)) * 4.0 * 3.14159;
    float floral =
      abs(sin(lx) * sin(ly)) * 0.55 +
      (0.5 + 0.5 * cos(lx * 2.0 - ly)) * 0.25 +
      exp(-pow((clothPx - 3.5) / 2.2, 2.0)) * 0.60 +
      exp(-pow((clothPx - cuffH + 3.0) / 2.5, 2.0)) * 0.55;
    laceSolid = smoothstep(0.32, 0.72, floral);

    // Protruding lace side edges stay rich solid embroidered lace (no see-through holes floating in air!)
    float onOuterEdge = smoothstep(-0.5, 0.8, outPx);
    float effLaceSolid = max(laceSolid, onOuterEdge * 0.92);

    float cuffTransMod = mix(1.0, 1.0 - inCuff * (0.76 * effLaceSolid - 0.34 * (1.0 - effLaceSolid)), step(0.05, inCuff));
    baseTrans = clamp(baseTrans * cuffTransMod, 0.0, 0.88);
    laceSolid = effLaceSolid;
    underCuffShadow = smoothstep(cuffH - 1.0, cuffH + 3.0, clothPx + scallopBot) *
                      exp(-max(0.0, clothPx + scallopBot - cuffH) * 0.22) * 0.22;
  } else {
    inCuff = 1.0 - smoothstep(cuffH - 3.0, cuffH + 2.5, clothPx);
    baseTrans *= (1.0 - inCuff * 0.58);
    underCuffShadow = smoothstep(cuffH - 1.0, cuffH + 2.5, clothPx) *
                      exp(-max(0.0, clothPx - cuffH) * 0.24) * 0.20;
  }

  baseTrans *= (1.0 - toeCap * 0.34);

  // =========================================================================
  // 5. STYLE #6 LIVE MANGA / GALGAME PULL FOLDS (Radiating Mountain Peak + Side Crescents!)
  // =========================================================================
  float dy = clothPx;
  float foldZoneMask = smoothstep(1.0, 10.0, dy) * exp(-max(0.0, dy - 78.0) / 48.0);
  float activeFold = pullIntensity * foldZoneMask;

  float totalValley = 0.0;
  float totalRidge = 0.0;
  float totalInk = 0.0;

  if (activeFold > 0.015) {
    float duG = u - uGrabU;
    float dyPos = max(1.0, dy + 2.0);
    float ang = atan(duG * 120.0, dyPos);
    float radEnv = smoothstep(2.0, 16.0, dy) * exp(-max(0.0, dy) / 92.0);

    float rayVal = 0.0;
    float rayRid = 0.0;
    float rayInk = 0.0;

    float da;
    da = (ang - (-0.74)) / 0.17;
    rayVal = max(rayVal, exp(-pow(da - 0.48, 2.0) * 2.1) * radEnv * 0.82);
    rayRid = max(rayRid, exp(-pow(da + 0.46, 2.0) * 2.3) * radEnv * 0.82);
    rayInk = max(rayInk, exp(-(da * da) * 16.0) * radEnv * 0.82);

    da = (ang - (-0.34)) / 0.14;
    rayVal = max(rayVal, exp(-pow(da - 0.48, 2.0) * 2.1) * radEnv * 1.00);
    rayRid = max(rayRid, exp(-pow(da + 0.46, 2.0) * 2.3) * radEnv * 1.00);
    rayInk = max(rayInk, exp(-(da * da) * 16.0) * radEnv * 1.00);

    da = (ang - 0.04) / 0.13;
    rayVal = max(rayVal, exp(-pow(da - 0.48, 2.0) * 2.1) * radEnv * 0.90);
    rayRid = max(rayRid, exp(-pow(da + 0.46, 2.0) * 2.3) * radEnv * 0.90);
    rayInk = max(rayInk, exp(-(da * da) * 16.0) * radEnv * 0.90);

    da = (ang - 0.40) / 0.15;
    rayVal = max(rayVal, exp(-pow(da - 0.48, 2.0) * 2.1) * radEnv * 1.00);
    rayRid = max(rayRid, exp(-pow(da + 0.46, 2.0) * 2.3) * radEnv * 1.00);
    rayInk = max(rayInk, exp(-(da * da) * 16.0) * radEnv * 1.00);

    da = (ang - 0.78) / 0.17;
    rayVal = max(rayVal, exp(-pow(da - 0.48, 2.0) * 2.1) * radEnv * 0.80);
    rayRid = max(rayRid, exp(-pow(da + 0.46, 2.0) * 2.3) * radEnv * 0.80);
    rayInk = max(rayInk, exp(-(da * da) * 16.0) * radEnv * 0.80);

    float snapShift = sin(uSnapPhase) * uSnapAmp * 5.0;
    vec3 mtn1 = evalCrescentFold(u, dy, clamp(uGrabU + 0.01, 0.22, 0.78), 35.0 + snapShift, 0.46, 18.0, 14.0, -4.0);

    // Synced directly with our crisp left/right outer semi-circle fold bumps!
    vec3 fl1 = evalCrescentFold(u, dy, 0.13, 28.0 + snapShift * 0.6, 0.32, -7.0, 11.5, 22.0);
    vec3 fl2 = evalCrescentFold(u, dy, 0.16, 61.0 + snapShift * 0.4, 0.36, -8.0, 10.5, 18.0);
    vec3 fr1 = evalCrescentFold(u, dy, 0.86, 30.0 + snapShift * 0.6, 0.34, -8.0, 12.0, -22.0);
    vec3 fr2 = evalCrescentFold(u, dy, 0.82, 63.0 + snapShift * 0.4, 0.38, -9.0, 11.0, -18.0);

    totalValley = max(max(rayVal * 0.88, mtn1.x * 0.92), max(max(fl1.x * 0.95, fl2.x * 0.76), max(fr1.x * 0.95, fr2.x * 0.78)));
    totalRidge  = max(max(rayRid * 0.92, mtn1.y * 0.95), max(max(fl1.y * 0.98, fl2.y * 0.80), max(fr1.y * 0.98, fr2.y * 0.80)));
    totalInk    = max(max(rayInk * 0.32, mtn1.z * 0.36), max(fl1.z * 0.42, fr1.z * 0.42));

    float scaleF = min(1.18, activeFold);
    totalValley *= scaleF;
    totalRidge  *= scaleF;
    totalInk    *= scaleF;
  }

  // =========================================================================
  // 6. MATTE VELVET OPTICAL COLORING + CRISP SEMI-CIRCLE OUTER OUTLINE
  // =========================================================================
  // Folded protruding semi-circles outside the bare leg are doubled fabric -> slightly deeper velvet
  float outsideDouble = smoothstep(-0.5, 1.5, outPx);
  float transFolded = clamp(
    baseTrans * (1.0 - totalValley * 0.66 - outsideDouble * 0.35) + totalRidge * 0.20 * (0.35 + 0.65 * nz),
    0.04,
    0.88
  );

  vec3 edgeColor = isLightStocking
    ? uBaseColor * vec3(0.75, 0.74, 0.83)
    : uBaseColor * vec3(0.54, 0.52, 0.60);
  vec3 velvetDye = mix(edgeColor, uBaseColor, pow(nz, 0.75));

  vec3 warmSkinTint = isLightStocking ? vec3(1.0, 0.97, 0.97) : vec3(0.97, 0.81, 0.85);
  vec3 warmSkin = skinRgb * warmSkinTint;
  vec3 transmittedSkin = isLightStocking
    ? mix(warmSkin, uBaseColor, 0.35)
    : warmSkin * (0.42 + 0.58 * velvetDye * 1.45 + 0.34);

  vec3 stockRgb = mix(velvetDye, transmittedSkin, transFolded);

  vec3 shadowTint = isLightStocking
    ? uBaseColor * vec3(0.68, 0.65, 0.78)
    : uBaseColor * vec3(0.32, 0.28, 0.42);
  float valDarken = clamp(totalValley * (isLightStocking ? 0.42 : 0.60), 0.0, 0.68);
  stockRgb = mix(stockRgb, shadowTint, valDarken);

  vec3 ridgeCol = isLightStocking ? vec3(1.0, 0.99, 1.0) : mix(uHighlightColor, vec3(0.92, 0.76, 0.84), 0.55);
  stockRgb += ridgeCol * clamp(totalRidge * (isLightStocking ? 0.06 : 0.09), 0.0, 0.14) * (0.35 + 0.65 * nz);

  vec3 inkCol = isLightStocking ? vec3(0.62, 0.58, 0.72) : uBaseColor * vec3(0.36, 0.30, 0.48);
  stockRgb = mix(stockRgb, inkCol, clamp(totalInk * 0.24, 0.0, 0.55));

  if (uSheen > 0.01) {
    float broadMatte = pow(max(0.0, litAngle), 4.5) * (0.45 + 0.55 * (thighPeak * 0.6 + kneePeak * 0.8 + shinPeak * 0.5));
    stockRgb += uHighlightColor * broadMatte * uSheen * (isLightStocking ? 0.08 : 0.16) * (1.0 - inCuff * 0.65);
  }

  if (uLaceCuff > 0.5) {
    stockRgb *= (1.0 - inCuff * laceSolid * 0.28);
  } else {
    float cuffRib = 0.5 + 0.5 * sin(u * 130.0);
    stockRgb *= (1.0 - inCuff * (isLightStocking ? 0.07 : 0.14) + inCuff * (cuffRib - 0.5) * 0.045);
  }
  stockRgb *= (1.0 - underCuffShadow);

  if (uInstepRoll > 0.02) {
    float rollCrest = exp(-pow((clothPx - cuffH * 0.45) / max(4.0, cuffH * 0.35), 2.0)) * uInstepRoll;
    stockRgb += ridgeCol * rollCrest * 0.07;
  }

  float grain = (hash21(floor(vLegUV * vec2(768.0, 1029.0))) - 0.5) * 0.028 * uWeaveIntensity;
  stockRgb *= (1.0 + grain);

  stockRgb = stockRgb / (1.0 + max(vec3(0.0), stockRgb - vec3(0.90)) * 0.85);

  // Crisp 1.6px dark anime outline tracing BOTH bare leg silhouette AND outer rim of each semi-circle bump!
  vec3 outlineCol = isLightStocking ? vec3(0.56, 0.53, 0.64) : edgeColor * 0.48;
  float bumpOuterRim = totalBumpPx > 0.25
    ? smoothstep(totalBumpPx - 2.2, totalBumpPx - 0.4, outPx) * smoothstep(totalBumpPx + 0.8, totalBumpPx - 0.2, outPx)
    : 0.0;
  float combinedOutline = max(lineArtMask * 0.72, bumpOuterRim * 0.82);
  stockRgb = mix(stockRgb, outlineCol, combinedOutline);

  float finalAlpha = topLipAlpha * effectiveMask * uSockAlpha;
  gl_FragColor = vec4(clamp(stockRgb, 0.0, 1.0) * finalAlpha, finalAlpha);
}
`;

const ERASE_FRAGMENT_SHADER = `
precision highp float;

varying vec2 vLegUV;
varying vec2 vClothUV;

uniform float uSockAlpha;
uniform float uLaceCuff;

void main() {
  if (uSockAlpha < 0.005) discard;
  float u = clamp(vClothUV.x, 0.0, 1.0);
  float clothPx = vClothUV.y;
  float scallopTop = uLaceCuff > 0.5 ? sin(u * 3.14159 * 12.0) * 3.0 : 0.0;
  float effPx = clothPx + scallopTop;
  if (effPx <= 0.0) discard;
  float cover = smoothstep(0.0, 1.6, effPx) * uSockAlpha;
  gl_FragColor = vec4(0.0, 0.0, 0.0, cover);
}
`;

export interface StockingShaderHandle {
  shader: Shader;
  eraseShader: Shader;
  updateVisual(visual: StockingVisualConfig): void;
  updatePhysics(params: {
    tension: number;
    wrinkleEnergy: number;
    grabU: number;
    leftHandU: number;
    rightHandU: number;
    handEngage: number;
    snapPhase: number;
    snapAmp: number;
    legSpan: number;
    instepRoll: number;
    sockAlpha: number;
    time: number;
  }): void;
}

export function createStockingShader(
  legsTexture: Texture,
  imageWidth: number,
  imageHeight: number,
  skinToneRgb: [number, number, number],
  visual: StockingVisualConfig
): StockingShaderHandle {
  const baseRgb = hexToRgb01(visual.color);
  const hiRgb = hexToRgb01(visual.highlightColor);

  const shader = Shader.from({
    gl: {
      vertex: VERTEX_SHADER,
      fragment: FRAGMENT_SHADER,
    },
    resources: {
      uLegsTex: legsTexture.source,
      stockingUniforms: {
        uImageSize: { value: new Float32Array([imageWidth, imageHeight]), type: 'vec2<f32>' },
        uBaseColor: { value: new Float32Array(baseRgb), type: 'vec3<f32>' },
        uHighlightColor: { value: new Float32Array(hiRgb), type: 'vec3<f32>' },
        uSkinTone: {
          value: new Float32Array([skinToneRgb[0] / 255, skinToneRgb[1] / 255, skinToneRgb[2] / 255]),
          type: 'vec3<f32>',
        },
        uDenier: { value: visual.denier, type: 'f32' },
        uSheen: { value: visual.sheen, type: 'f32' },
        uFresnel: { value: visual.fresnel, type: 'f32' },
        uWrinkleStrength: { value: visual.wrinkleStrength, type: 'f32' },
        uWeaveIntensity: { value: visual.weaveIntensity, type: 'f32' },
        uCuffHeight: { value: visual.cuffHeight, type: 'f32' },
        uCuffPinch: { value: visual.cuffPinch, type: 'f32' },
        uLaceCuff: { value: visual.laceCuff ? 1 : 0, type: 'f32' },
        uTension: { value: 0, type: 'f32' },
        uWrinkleEnergy: { value: 0, type: 'f32' },
        uGrabU: { value: 0.5, type: 'f32' },
        uLeftHandU: { value: 0.16, type: 'f32' },
        uRightHandU: { value: 0.84, type: 'f32' },
        uHandEngage: { value: 0, type: 'f32' },
        uSnapPhase: { value: 0, type: 'f32' },
        uSnapAmp: { value: 0, type: 'f32' },
        uLegSpan: { value: 600, type: 'f32' },
        uInstepRoll: { value: 0, type: 'f32' },
        uSockAlpha: { value: 1, type: 'f32' },
        uTime: { value: 0, type: 'f32' },
      },
    },
  });

  const eraseShader = Shader.from({
    gl: {
      vertex: VERTEX_SHADER,
      fragment: ERASE_FRAGMENT_SHADER,
    },
    resources: {
      eraseUniforms: {
        uImageSize: { value: new Float32Array([imageWidth, imageHeight]), type: 'vec2<f32>' },
        uSockAlpha: { value: 1, type: 'f32' },
        uLaceCuff: { value: visual.laceCuff ? 1 : 0, type: 'f32' },
      },
    },
  });

  const uniforms = shader.resources.stockingUniforms.uniforms;
  const eraseUniforms = eraseShader.resources.eraseUniforms.uniforms;

  return {
    shader,
    eraseShader,
    updateVisual(next: StockingVisualConfig) {
      const b = hexToRgb01(next.color);
      const h = hexToRgb01(next.highlightColor);
      uniforms.uBaseColor[0] = b[0];
      uniforms.uBaseColor[1] = b[1];
      uniforms.uBaseColor[2] = b[2];
      uniforms.uHighlightColor[0] = h[0];
      uniforms.uHighlightColor[1] = h[1];
      uniforms.uHighlightColor[2] = h[2];
      uniforms.uDenier = next.denier;
      uniforms.uSheen = next.sheen;
      uniforms.uFresnel = next.fresnel;
      uniforms.uWrinkleStrength = next.wrinkleStrength;
      uniforms.uWeaveIntensity = next.weaveIntensity;
      uniforms.uCuffHeight = next.cuffHeight;
      uniforms.uCuffPinch = next.cuffPinch;
      uniforms.uLaceCuff = next.laceCuff ? 1 : 0;
      eraseUniforms.uLaceCuff = next.laceCuff ? 1 : 0;
    },
    updatePhysics(p) {
      uniforms.uTension = p.tension;
      uniforms.uWrinkleEnergy = p.wrinkleEnergy;
      uniforms.uGrabU = p.grabU;
      uniforms.uLeftHandU = p.leftHandU;
      uniforms.uRightHandU = p.rightHandU;
      uniforms.uHandEngage = p.handEngage;
      uniforms.uSnapPhase = p.snapPhase;
      uniforms.uSnapAmp = p.snapAmp;
      uniforms.uLegSpan = p.legSpan;
      uniforms.uInstepRoll = p.instepRoll;
      uniforms.uSockAlpha = p.sockAlpha;
      eraseUniforms.uSockAlpha = p.sockAlpha;
      uniforms.uTime = p.time;
    },
  };
}
