import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { LegPhysics } from './LegPhysics';
import { StockingMesh } from './StockingMesh';
import { AssetManifest } from './types';

interface HandPairSprites {
  root: Container;
  openSprite: Sprite;
  gripSprite: Sprite;
  shieldSprite: Sprite;
}

/**
 * Dual-hand animator supporting:
 * 1. Anatomically accurate cuff-pulling (character's right hand on viewer-left, left hand on viewer-right;
 *    thumbs inner, curled fingers outer, wrists naturally angling upward toward torso).
 * 2. Shy bare-foot shielding ("用手挡住") immediately when the half-rolled instep sock is yanked off
 *    or when the user pokes a barefoot (0% quota) foot!
 */
export class HandAnimator {
  public readonly container = new Container();

  private readonly leftHand: HandPairSprites;
  private readonly rightHand: HandPairSprites;
  private readonly fxGraphics = new Graphics();

  private smoothLeftX = 0;
  private smoothLeftY = 0;
  private smoothRightX = 0;
  private smoothRightY = 0;
  private initializedPos = false;
  private pinchBounce = 0;
  private wasGripping = false;

  constructor(
    manifest: AssetManifest,
    textures: {
      openLeft: Texture;
      openRight: Texture;
      gripLeft: Texture;
      gripRight: Texture;
      shieldLeft: Texture;
      shieldRight: Texture;
    }
  ) {
    this.leftHand = this.createHandPair(
      textures.openLeft,
      textures.gripLeft,
      textures.shieldLeft,
      manifest.hands.openLeft,
      manifest.hands.gripLeft,
      manifest.hands.shieldLeft
    );
    this.rightHand = this.createHandPair(
      textures.openRight,
      textures.gripRight,
      textures.shieldRight,
      manifest.hands.openRight,
      manifest.hands.gripRight,
      manifest.hands.shieldRight
    );

    this.container.addChild(this.leftHand.root);
    this.container.addChild(this.rightHand.root);
    this.container.addChild(this.fxGraphics);
    this.container.visible = false;
  }

  private createHandPair(
    openTex: Texture,
    gripTex: Texture,
    shieldTex: Texture,
    openMeta: AssetManifest['hands']['openLeft'],
    gripMeta: AssetManifest['hands']['gripLeft'],
    shieldMeta: AssetManifest['hands']['shieldLeft']
  ): HandPairSprites {
    const root = new Container();

    const openSprite = new Sprite(openTex);
    openSprite.anchor.set(openMeta.pivotX, openMeta.pivotY);

    const gripSprite = new Sprite(gripTex);
    gripSprite.anchor.set(gripMeta.pivotX, gripMeta.pivotY);
    gripSprite.alpha = 0;

    const shieldSprite = new Sprite(shieldTex);
    shieldSprite.anchor.set(shieldMeta.pivotX, shieldMeta.pivotY);
    shieldSprite.alpha = 0;

    root.addChild(openSprite);
    root.addChild(gripSprite);
    root.addChild(shieldSprite);

    return { root, openSprite, gripSprite, shieldSprite };
  }

  public update(physics: LegPhysics, stockingMesh: StockingMesh, dt: number): void {
    const engage = physics.handEngagement;
    const shield = physics.shieldEngagement;
    const combinedVisible = Math.max(engage, shield);
    const tension = physics.tension;
    const grab = physics.handGrabProgress;
    const t = physics.time;

    if (combinedVisible < 0.008) {
      this.container.visible = false;
      this.initializedPos = false;
      this.wasGripping = false;
      this.fxGraphics.clear();
      return;
    }

    this.container.visible = true;

    const isGripping = grab > 0.42 && shield < 0.35;
    if (isGripping && !this.wasGripping) {
      this.pinchBounce = 1.0;
    }
    this.wasGripping = isGripping;
    this.pinchBounce *= Math.exp(-12 * dt);

    // 1. Cuff-pulling targets (anatomically correct thumbs-inner grip!)
    const ptL = stockingMesh.getCuffPoint(physics, physics.leftHandU);
    const ptR = stockingMesh.getCuffPoint(physics, physics.rightHandU);
    const cuffScale = Math.max(0.32, Math.min(0.48, (ptL.halfWidth * 2.0) / 345.0));

    const approach = 1.0 - smoothstep(0.0, 0.70, engage);
    const approachEase = approach * approach;

    const strainFactor = smoothstep(0.22, 0.90, tension);
    const leftTug = Math.sin(t * 12.0) * strainFactor * 3.8;
    const rightTug = Math.sin(t * 12.0 + Math.PI * 0.85) * strainFactor * 3.8;

    const tremorAmt = Math.pow(smoothstep(0.32, 1.0, tension), 1.45) * 2.6;
    const tremLX = Math.sin(t * 53.0) * tremorAmt;
    const tremLY = Math.cos(t * 61.0) * tremorAmt * 0.85;
    const tremRX = Math.cos(t * 57.0) * tremorAmt;
    const tremRY = Math.sin(t * 64.0) * tremorAmt * 0.85;

    const cuffLX = ptL.x - 4 - approachEase * 24 + tremLX;
    const cuffLY = ptL.y - approachEase * 68 - Math.max(0, leftTug) * 0.55 + tremLY + 4;
    const cuffRX = ptR.x + 4 + approachEase * 24 + tremRX;
    const cuffRY = ptR.y - approachEase * 68 - Math.max(0, rightTug) * 0.55 + tremRY + 4;

    // 2. Foot-shielding targets ("用手挡住" right over the bare instep & toes!)
    const footPt = stockingMesh.getFootShieldPoint();
    const shieldApproach = 1.0 - smoothstep(0.0, 0.75, shield);
    const shieldEase = shieldApproach * shieldApproach;
    const shyFlutterX = Math.sin(t * 36.0) * 1.9 * shield;
    const shyFlutterY = Math.cos(t * 42.0) * 1.5 * shield;

    const shieldScale = Math.max(0.34, Math.min(0.46, (footPt.halfWidth * 2.0) / 215.0));
    // Place both cupped hands flanking & slightly overlapping over the bare foot!
    const shieldLX = footPt.x - footPt.halfWidth * 0.44 - shieldEase * 32 + shyFlutterX;
    const shieldLY = footPt.y + 4 - shieldEase * 88 + shyFlutterY;
    const shieldRX = footPt.x + footPt.halfWidth * 0.44 + shieldEase * 32 - shyFlutterX;
    const shieldRY = footPt.y + 4 - shieldEase * 88 - shyFlutterY;

    // Blend seamlessly between cuff-pulling & foot-shielding modes
    const shieldMix = smoothstep(0.08, 0.65, shield);
    const targetLX = lerp(cuffLX, shieldLX, shieldMix);
    const targetLY = lerp(cuffLY, shieldLY, shieldMix);
    const targetRX = lerp(cuffRX, shieldRX, shieldMix);
    const targetRY = lerp(cuffRY, shieldRY, shieldMix);

    if (!this.initializedPos) {
      this.smoothLeftX = targetLX;
      this.smoothLeftY = targetLY;
      this.smoothRightX = targetRX;
      this.smoothRightY = targetRY;
      this.initializedPos = true;
    } else {
      const follow = 1 - Math.exp(-36 * dt);
      this.smoothLeftX += (targetLX - this.smoothLeftX) * follow;
      this.smoothLeftY += (targetLY - this.smoothLeftY) * follow;
      this.smoothRightX += (targetRX - this.smoothRightX) * follow;
      this.smoothRightY += (targetRY - this.smoothRightY) * follow;
    }

    const baseScale = lerp(cuffScale, shieldScale, shieldMix);
    const masterAlpha = smoothstep(0.0, 0.25, combinedVisible);

    // Pose weights: open vs pinch vs cupped shield
    const gripBlend = smoothstep(0.20, 0.58, grab);
    const cuffWeight = 1.0 - shieldMix;
    const openAlpha = (1.0 - gripBlend) * cuffWeight;
    const gripAlpha = gripBlend * cuffWeight;
    const shieldAlpha = shieldMix;

    // Gentle anatomical rotation: wrists already point up toward torso!
    const pullRot = 0.06 + tension * 0.16 + strainFactor * 0.04;
    const shieldRotL = -0.16 + Math.sin(t * 14.0) * 0.03; // cupped gently inward over foot
    const shieldRotR = 0.16 - Math.sin(t * 14.0) * 0.03;

    const rotL = lerp(ptL.tangentAngle * 0.55 + pullRot + leftTug * 0.018, shieldRotL, shieldMix);
    const rotR = lerp(ptR.tangentAngle * 0.55 - pullRot - rightTug * 0.018, shieldRotR, shieldMix);

    const squeezeX = 1.0 + (tension * 0.06 - this.pinchBounce * 0.05) * cuffWeight;
    const squeezeY = 1.0 + (-tension * 0.04 + this.pinchBounce * 0.05) * cuffWeight;

    // Update viewer-LEFT hand (character's RIGHT hand)
    this.leftHand.root.position.set(this.smoothLeftX, this.smoothLeftY);
    this.leftHand.root.rotation = rotL;
    this.leftHand.root.scale.set(baseScale * squeezeX, baseScale * squeezeY);
    this.leftHand.root.alpha = masterAlpha;
    this.leftHand.openSprite.alpha = openAlpha;
    this.leftHand.gripSprite.alpha = gripAlpha;
    this.leftHand.shieldSprite.alpha = shieldAlpha;

    // Update viewer-RIGHT hand (character's LEFT hand)
    this.rightHand.root.position.set(this.smoothRightX, this.smoothRightY);
    this.rightHand.root.rotation = rotR;
    this.rightHand.root.scale.set(baseScale * squeezeX, baseScale * squeezeY);
    this.rightHand.root.alpha = masterAlpha;
    this.rightHand.openSprite.alpha = openAlpha;
    this.rightHand.gripSprite.alpha = gripAlpha;
    this.rightHand.shieldSprite.alpha = shieldAlpha;

    // Draw cute anime effort / flustered panic accents cleanly OUTSIDE the hands
    this.drawStrainAccents(t, tension, engage, shield, baseScale);
  }

  private drawStrainAccents(
    t: number,
    tension: number,
    engage: number,
    shield: number,
    scale: number
  ): void {
    const g = this.fxGraphics;
    g.clear();

    const pullFx = smoothstep(0.32, 0.72, tension) * smoothstep(0.25, 0.75, engage);
    const shieldFx = smoothstep(0.20, 0.75, shield);
    const fxAlpha = Math.max(pullFx, shieldFx);
    if (fxAlpha < 0.02) return;

    const pulse = 0.90 + 0.10 * Math.sin(t * (shield > 0.3 ? 28.0 : 22.0));

    // Place effort lines well outside the outer edges of both hands (never overlapping skin!)
    const outOffsetX = (shield > 0.3 ? 175 : 145) * scale;
    const outOffsetY = (shield > 0.3 ? 72 : 108) * scale;
    const lx = this.smoothLeftX - outOffsetX;
    const ly = this.smoothLeftY - outOffsetY;
    const rx = this.smoothRightX + outOffsetX;
    const ry = this.smoothRightY - outOffsetY;

    for (let i = 0; i < 3; i++) {
      const aL = -2.75 + i * 0.44;
      const r0 = 8 * pulse;
      const r1 = (17 + (i === 1 ? 5 : 0)) * pulse;
      g.moveTo(lx + Math.cos(aL) * r0, ly + Math.sin(aL) * r0);
      g.lineTo(lx + Math.cos(aL) * r1, ly + Math.sin(aL) * r1);

      const aR = -0.39 - i * 0.44;
      g.moveTo(rx + Math.cos(aR) * r0, ry + Math.sin(aR) * r0);
      g.lineTo(rx + Math.cos(aR) * r1, ry + Math.sin(aR) * r1);
    }
    g.stroke({
      width: 2.2,
      color: shield > 0.3 ? 0xff7eb6 : 0xff9ec7,
      alpha: fxAlpha * 0.85,
      cap: 'round',
    });

    // Cute trembling anime sweat drop floating cleanly outside the right wrist
    const sweatAlpha = Math.max(smoothstep(0.50, 0.85, tension) * pullFx, shieldFx * 0.95);
    if (sweatAlpha > 0.04) {
      const sx = rx + 14;
      const sy = ry - 18 + Math.sin(t * 16.0) * 2.5;
      const s = 7.5;
      g.moveTo(sx, sy - s);
      g.bezierCurveTo(sx + s * 0.72, sy, sx + s * 0.65, sy + s * 0.85, sx, sy + s * 0.85);
      g.bezierCurveTo(sx - s * 0.65, sy + s * 0.85, sx - s * 0.72, sy, sx, sy - s);
      g.fill({ color: 0xb8e6ff, alpha: sweatAlpha * 0.94 });
      g.stroke({ width: 1.4, color: 0x629ed4, alpha: sweatAlpha * 0.88 });

      g.circle(sx - s * 0.2, sy + s * 0.15, s * 0.18);
      g.fill({ color: 0xffffff, alpha: sweatAlpha * 0.96 });
    }
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
