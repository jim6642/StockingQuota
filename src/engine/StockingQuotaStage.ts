import { Application, Assets, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { HandAnimator } from './HandAnimator';
import { LegPhysics } from './LegPhysics';
import { StockingMesh } from './StockingMesh';
import { createStockingShader, StockingShaderHandle } from './StockingShader';
import {
  AssetManifest,
  DEFAULT_PHYSICS_CONFIG,
  DEFAULT_VISUAL_CONFIG,
  LegSide,
  PhysicsConfig,
  StageTelemetry,
  StockingVisualConfig,
} from './types';

interface LegRig {
  side: LegSide;
  physics: LegPhysics;
  shader: StockingShaderHandle;
  mesh: StockingMesh;
  hands: HandAnimator;
}

export type StageHitRegion = 'cuff' | 'skirt' | 'body' | 'none';

export interface StockingQuotaStageOptions {
  container: HTMLElement;
  manifestUrl?: string;
  initialLeftQuota?: number;
  initialRightQuota?: number;
  physics?: Partial<PhysicsConfig>;
  visual?: Partial<StockingVisualConfig>;
  onTelemetry?: (telemetry: StageTelemetry) => void;
  /** Fired when user grabs/interacts with either stocking cuff or foot */
  onInteractionStart?: (side: LegSide) => void;
  /** Fired when user releases a stocking drag */
  onInteractionEnd?: (side: LegSide) => void;
  /** Optional cursor override callback when hovering non-cuff regions (e.g. skirt window drag) */
  getRegionCursor?: (region: StageHitRegion) => string | null;
  /** Anchor character to bottom-center when scaling smoothly inside a fixed transparent desktop window */
  anchorBottom?: boolean;
  /** Initial relative display scale [0.35..1.0] within the canvas (1.0 = fit full canvas) */
  initialDisplayScale?: number;
}

function resolveAssetUrl(rawUrl: string): string {
  // Support both Vite dev server (/assets/...) and packaged Electron file:// (./assets/...)
  if (/^(https?:|file:|data:|blob:)/i.test(rawUrl)) return rawUrl;
  const trimmed = rawUrl.startsWith('/') ? rawUrl.slice(1) : rawUrl;
  return new URL(trimmed, window.location.href).href;
}

/**
 * Standalone, embeddable transparent WebGL stage for StockingQuota.
 * Designed to drop directly into any browser view, Tauri WebView2, or Electron transparent BrowserWindow.
 */
export class StockingQuotaStage {
  public readonly app = new Application();
  public physicsConfig: PhysicsConfig;
  public visualConfig: StockingVisualConfig;

  private readonly hostEl: HTMLElement;
  private readonly manifestUrl: string;
  private readonly onTelemetry?: (telemetry: StageTelemetry) => void;
  private readonly onInteractionStart?: (side: LegSide) => void;
  private readonly onInteractionEnd?: (side: LegSide) => void;
  private readonly getRegionCursor?: (region: StageHitRegion) => string | null;
  private readonly anchorBottom: boolean;
  private targetDisplayScale = 1.0;
  private currentDisplayScale = 1.0;

  private manifest!: AssetManifest;
  private worldContainer = new Container();
  private hoverHighlight = new Graphics();
  private leftRig!: LegRig;
  private rightRig!: LegRig;

  private activeDragLeg: LegRig | null = null;
  private secondaryDragLeg: LegRig | null = null;
  private dualLegSyncMode = false;
  private activePointerId: number | null = null;
  private hoveredLeg: LegSide | null = null;

  private resizeObserver: ResizeObserver | null = null;
  private fpsSamples: number[] = [];
  private telemetryTimer = 0;
  private renderingPaused = false;
  private destroyed = false;

  constructor(options: StockingQuotaStageOptions) {
    this.hostEl = options.container;
    this.manifestUrl = options.manifestUrl ?? './assets/manifest.json';
    this.onTelemetry = options.onTelemetry;
    this.onInteractionStart = options.onInteractionStart;
    this.onInteractionEnd = options.onInteractionEnd;
    this.getRegionCursor = options.getRegionCursor;
    this.anchorBottom = options.anchorBottom ?? false;
    this.targetDisplayScale = Math.max(0.35, Math.min(1.0, options.initialDisplayScale ?? 1.0));
    this.currentDisplayScale = this.targetDisplayScale;
    this.physicsConfig = { ...DEFAULT_PHYSICS_CONFIG, ...options.physics };
    this.visualConfig = { ...DEFAULT_VISUAL_CONFIG, ...options.visual };
    this.initialLeftQuota = options.initialLeftQuota ?? 82;
    this.initialRightQuota = options.initialRightQuota ?? 58;
  }

  private initialLeftQuota: number;
  private initialRightQuota: number;

  public async init(): Promise<void> {
    await this.app.init({
      preference: 'webgl',
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      resizeTo: this.hostEl,
    });

    if (this.destroyed) return;

    this.app.canvas.style.display = 'block';
    this.app.canvas.style.width = '100%';
    this.app.canvas.style.height = '100%';
    this.app.canvas.style.touchAction = 'none';
    this.hostEl.appendChild(this.app.canvas);

    // 1. Load decoupled asset manifest & textures (compatible with both HTTP and Electron file://)
    const res = await fetch(resolveAssetUrl(this.manifestUrl));
    this.manifest = (await res.json()) as AssetManifest;

    const [legsTex, skirtTex, openLeftTex, openRightTex, gripLeftTex, gripRightTex, shieldLeftTex, shieldRightTex] =
      await Promise.all([
        Assets.load<Texture>(resolveAssetUrl(this.manifest.legsUrl)),
        this.manifest.skirtUrl ? Assets.load<Texture>(resolveAssetUrl(this.manifest.skirtUrl)) : Promise.resolve(null),
        Assets.load<Texture>(resolveAssetUrl(this.manifest.hands.openLeft.url)),
        Assets.load<Texture>(resolveAssetUrl(this.manifest.hands.openRight.url)),
        Assets.load<Texture>(resolveAssetUrl(this.manifest.hands.gripLeft.url)),
        Assets.load<Texture>(resolveAssetUrl(this.manifest.hands.gripRight.url)),
        Assets.load<Texture>(resolveAssetUrl(this.manifest.hands.shieldLeft.url)),
        Assets.load<Texture>(resolveAssetUrl(this.manifest.hands.shieldRight.url)),
      ]);

    const handTextures = {
      openLeft: openLeftTex,
      openRight: openRightTex,
      gripLeft: gripLeftTex,
      gripRight: gripRightTex,
      shieldLeft: shieldLeftTex,
      shieldRight: shieldRightTex,
    };

    // 2. Build layered scene graph
    // Layer 1: Bare anime legs illustration
    const legsSprite = new Sprite(legsTex);
    this.worldContainer.addChild(legsSprite);

    // Layer 2: Erase covered bare-leg pixels first (eliminates 100% of anti-aliased edge peach bleed!)
    // then render dynamic WebGL stocking meshes cleanly on top.
    this.leftRig = this.buildLegRig('left', this.initialLeftQuota, legsTex, handTextures);
    this.rightRig = this.buildLegRig('right', this.initialRightQuota, legsTex, handTextures);
    this.worldContainer.addChild(this.leftRig.mesh.eraseMesh);
    this.worldContainer.addChild(this.rightRig.mesh.eraseMesh);
    this.worldContainer.addChild(this.leftRig.mesh.mesh);
    this.worldContainer.addChild(this.rightRig.mesh.mesh);

    // Layer 3: Subtle interactive cuff hover shimmer
    this.worldContainer.addChild(this.hoverHighlight);

    // Layer 4: Pleated skirt hem overlay (so 98-100% stockings slide cleanly underneath!)
    if (skirtTex) {
      const skirtSprite = new Sprite(skirtTex);
      this.worldContainer.addChild(skirtSprite);
    }

    // Layer 5: Dual-hand reverse-pulling animation layers
    this.worldContainer.addChild(this.leftRig.hands.container);
    this.worldContainer.addChild(this.rightRig.hands.container);

    this.app.stage.addChild(this.worldContainer);
    this.fitWorldToCanvas();

    // 3. Pointer interaction listeners (using DOM pointer capture for bulletproof drag outside bounds!)
    this.bindPointerEvents();

    // 4. Responsive layout observer
    this.resizeObserver = new ResizeObserver(() => {
      this.app.resize();
      this.fitWorldToCanvas();
    });
    this.resizeObserver.observe(this.hostEl);

    // 5. Real-time 60fps+ simulation & render loop
    this.app.ticker.add((ticker) => {
      const dt = Math.min(0.05, ticker.deltaMS / 1000);
      this.update(dt, ticker.deltaMS);
    });
  }

  private buildLegRig(
    side: LegSide,
    initialQuota: number,
    legsTex: Texture,
    handTextures: {
      openLeft: Texture;
      openRight: Texture;
      gripLeft: Texture;
      gripRight: Texture;
      shieldLeft: Texture;
      shieldRight: Texture;
    }
  ): LegRig {
    const meta = this.manifest.legs[side];
    const physics = new LegPhysics(meta, initialQuota);
    const shader = createStockingShader(
      legsTex,
      this.manifest.imageWidth,
      this.manifest.imageHeight,
      this.manifest.skinToneRgb,
      this.visualConfig
    );
    const mesh = new StockingMesh(meta, this.manifest.imageHeight, shader);
    const hands = new HandAnimator(this.manifest, handTextures);

    // Initial vertex geometry build
    mesh.update(physics, this.visualConfig);
    return { side, physics, shader, mesh, hands };
  }

  private fitWorldToCanvas(): void {
    if (!this.manifest) return;
    const cw = this.app.renderer.width / this.app.renderer.resolution;
    const ch = this.app.renderer.height / this.app.renderer.resolution;

    // Leave gentle breathing room on left/right so the pulling anime hands never clip the canvas edge!
    const padX = Math.max(24, cw * 0.08);
    const padY = Math.max(8, ch * 0.02);
    const availW = Math.max(40, cw - padX * 2);
    const availH = Math.max(60, ch - padY * 2);

    const maxFitScale = Math.min(availW / this.manifest.imageWidth, availH / this.manifest.imageHeight);
    const scale = maxFitScale * this.currentDisplayScale;
    this.worldContainer.scale.set(scale);

    const x = (cw - this.manifest.imageWidth * scale) * 0.5;
    const y = this.anchorBottom
      ? ch - padY - this.manifest.imageHeight * scale
      : (ch - this.manifest.imageHeight * scale) * 0.5;
    this.worldContainer.position.set(x, y);
  }

  /** Convert client/canvas pointer coords into bare-legs image pixel coords */
  private clientToImage(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const s = this.worldContainer.scale.x || 1;
    return {
      x: (localX - this.worldContainer.position.x) / s,
      y: (localY - this.worldContainer.position.y) / s,
    };
  }

  /** Upper pleated skirt waistband Y cutoff reserved exclusively for desktop window dragging */
  private static readonly SKIRT_DRAG_MAX_Y = 112;

  /** Hit-test whether an image-space pointer is near either leg's stocking cuff (or upper stocking body) */
  private hitTestCuff(imgX: number, imgY: number): { rig: LegRig; grabU: number } | null {
    // Keep top waistband strip cleanly reserved for window moving so cuff drag never fights window drag
    if (imgY <= StockingQuotaStage.SKIRT_DRAG_MAX_Y) return null;

    const rigs = [this.leftRig, this.rightRig];
    let best: { rig: LegRig; grabU: number; dist: number } | null = null;

    for (const rig of rigs) {
      const cuffMidY = rig.physics.sampleCuffY(0.5);
      const contour = rig.mesh.sampleContour(Math.max(rig.mesh.meta.yTop, Math.min(rig.mesh.meta.yToe, imgY)));
      const padX = 24;

      if (imgX >= contour.xLeft - padX && imgX <= contour.xRight + padX) {
        const u = Math.max(0.05, Math.min(0.95, (imgX - contour.xLeft) / Math.max(1, contour.xRight - contour.xLeft)));
        const localCuffY = rig.physics.sampleCuffY(u);
        const dy = imgY - localCuffY;

        // Generous intuitive grab band:
        // At 100% quota (cuff tucked under skirt hem), extend downward generously onto visible upper thigh
        // so users can grab right below the skirt without ever hitting the top window-move strip!
        const downReach = rig.physics.smoothedQuotaPct >= 90 ? 185 : 115;
        const isFootZone = rig.physics.smoothedQuotaPct <= 18 && imgY >= rig.mesh.meta.yAnkle - 20 && imgY <= rig.mesh.meta.yToe + 18;
        if ((dy >= -44 && dy <= downReach) || isFootZone) {
          const dist = Math.abs(dy);
          if (!best || dist < best.dist) {
            best = { rig, grabU: u, dist };
          }
        } else if (Math.abs(imgY - cuffMidY) < 55) {
          const dist = Math.abs(imgY - cuffMidY);
          if (!best || dist < best.dist) {
            best = { rig, grabU: u, dist };
          }
        }
      }
    }

    return best ? { rig: best.rig, grabU: best.grabU } : null;
  }

  private bindPointerEvents(): void {
    const canvas = this.app.canvas;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const pt = this.clientToImage(e.clientX, e.clientY);
      const hit = this.hitTestCuff(pt.x, pt.y);
      if (!hit) return;

      this.activeDragLeg = hit.rig;
      this.activePointerId = e.pointerId;
      if (this.dualLegSyncMode) {
        const other = hit.rig.side === 'left' ? this.rightRig : this.leftRig;
        const mirrorU = Math.max(0.05, Math.min(0.95, 1 - hit.grabU));
        hit.rig.physics.startDrag(pt.x, pt.y, hit.grabU, hit.rig.side === 'left' ? 'left-only' : 'right-only');
        other.physics.startDrag(pt.x, pt.y, mirrorU, other.side === 'left' ? 'left-only' : 'right-only');
        this.secondaryDragLeg = other;
      } else {
        hit.rig.physics.startDrag(pt.x, pt.y, hit.grabU, 'both');
        this.secondaryDragLeg = null;
      }
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      this.onInteractionStart?.(hit.rig.side);
    };

    const onPointerMove = (e: PointerEvent) => {
      const pt = this.clientToImage(e.clientX, e.clientY);

      if (this.activeDragLeg && e.pointerId === this.activePointerId) {
        this.activeDragLeg.physics.updateDrag(pt.x, pt.y);
        this.secondaryDragLeg?.physics.updateDrag(pt.x, pt.y);
        canvas.style.cursor = 'grabbing';
        return;
      }

      const hit = this.hitTestCuff(pt.x, pt.y);
      this.hoveredLeg = hit ? hit.rig.side : null;
      if (hit) {
        canvas.style.cursor = 'grab';
      } else {
        const region = this.hitTestRegion(e.clientX, e.clientY);
        const custom = this.getRegionCursor?.(region);
        canvas.style.cursor = custom ?? 'default';
      }
    };

    const onPointerUpOrCancel = (e: PointerEvent) => {
      if (this.activeDragLeg && e.pointerId === this.activePointerId) {
        const finishedSide = this.activeDragLeg.side;
        this.activeDragLeg.physics.endDrag();
        this.secondaryDragLeg?.physics.endDrag();
        this.activeDragLeg = null;
        this.secondaryDragLeg = null;
        this.activePointerId = null;
        if (canvas.hasPointerCapture(e.pointerId)) {
          canvas.releasePointerCapture(e.pointerId);
        }
        const pt = this.clientToImage(e.clientX, e.clientY);
        const hit = this.hitTestCuff(pt.x, pt.y);
        this.hoveredLeg = hit ? hit.rig.side : null;
        canvas.style.cursor = hit ? 'grab' : 'default';
        this.onInteractionEnd?.(finishedSide);
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUpOrCancel);
    window.addEventListener('pointercancel', onPointerUpOrCancel);

    this.cleanupListeners = () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUpOrCancel);
      window.removeEventListener('pointercancel', onPointerUpOrCancel);
    };
  }

  private cleanupListeners: (() => void) | null = null;

  private update(dt: number, deltaMS: number): void {
    // Silky GPU-native smooth scaling (zero OS window resize or UI jitter!)
    if (Math.abs(this.targetDisplayScale - this.currentDisplayScale) > 0.0004) {
      this.currentDisplayScale += (this.targetDisplayScale - this.currentDisplayScale) * (1 - Math.exp(-20 * dt));
      if (Math.abs(this.targetDisplayScale - this.currentDisplayScale) <= 0.0004) {
        this.currentDisplayScale = this.targetDisplayScale;
      }
      this.fitWorldToCanvas();
    }

    const rigs = [this.leftRig, this.rightRig];
    for (const rig of rigs) {
      rig.physics.step(dt, this.physicsConfig);
      rig.mesh.update(rig.physics, this.visualConfig);
      const sockAlpha = Math.max(0, Math.min(1, 1.0 - Math.max(0, (rig.physics.slipOffProgress - 0.18) / 0.80)));
      rig.shader.updatePhysics({
        tension: rig.physics.tension,
        wrinkleEnergy: rig.physics.wrinkleEnergy,
        grabU: rig.physics.grabU,
        leftHandU: rig.physics.leftHandU,
        rightHandU: rig.physics.rightHandU,
        handEngage: rig.physics.handEngagement,
        snapPhase: rig.physics.snapWavePhase,
        snapAmp: rig.physics.snapWaveAmp,
        legSpan: rig.physics.legSpan,
        instepRoll: rig.physics.instepRoll,
        sockAlpha,
        time: rig.physics.time,
      });
      const handMode = this.dualLegSyncMode ? (rig.side === 'left' ? 'left-only' : 'right-only') : 'both';
      rig.hands.update(rig.physics, rig.mesh, dt, handMode);
    }

    this.renderHoverIndicator();

    // Update FPS & telemetry callback (~15 Hz to keep DOM ultra-light)
    if (deltaMS > 0.1) {
      this.fpsSamples.push(1000 / deltaMS);
      if (this.fpsSamples.length > 24) this.fpsSamples.shift();
    }
    this.telemetryTimer += dt;
    if (this.onTelemetry && this.telemetryTimer >= 0.065) {
      this.telemetryTimer = 0;
      const avgFps =
        this.fpsSamples.length > 0
          ? this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length
          : 60;
      this.onTelemetry({
        fps: Math.round(avgFps),
        frameTimeMs: Number(deltaMS.toFixed(1)),
        left: this.leftRig.physics.getTelemetry(),
        right: this.rightRig.physics.getTelemetry(),
      });
    }
  }

  private renderHoverIndicator(): void {
    const g = this.hoverHighlight;
    g.clear();
    if (!this.hoveredLeg || this.activeDragLeg) return;

    const targetRigs = this.dualLegSyncMode
      ? [this.leftRig, this.rightRig]
      : [this.hoveredLeg === 'left' ? this.leftRig : this.rightRig];

    let drewAny = false;
    for (const rig of targetRigs) {
      if (rig.physics.slipOffProgress > 0.65 || rig.physics.smoothedQuotaPct >= 97) continue;
      const steps = 16;
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const pt = rig.mesh.getCuffPoint(rig.physics, u);
        const wrapY = Math.sin(u * Math.PI) * 3.0;
        if (i === 0) g.moveTo(pt.x, pt.y + wrapY);
        else g.lineTo(pt.x, pt.y + wrapY);
      }
      drewAny = true;
    }
    if (drewAny) {
      g.stroke({ width: 3.0, color: 0xffffff, alpha: 0.42, cap: 'round' });
    }
  }

  // =========================================================================
  // PUBLIC EMBEDDABLE API (Ready for Tauri / Electron / Future Agents!)
  // =========================================================================

  public setQuota(side: LegSide, percentage: number): void {
    const clamped = Math.max(0, Math.min(100, percentage));
    const rig = side === 'left' ? this.leftRig : this.rightRig;
    if (rig) rig.physics.targetQuotaPct = clamped;
  }

  public getQuota(side: LegSide): number {
    const rig = side === 'left' ? this.leftRig : this.rightRig;
    return rig ? rig.physics.targetQuotaPct : 0;
  }

  /**
   * When true (single-window quota synced to both legs, e.g. DSH / Codex Pro),
   * dragging either stocking pulls BOTH stockings together with 1 hand per stocking!
   */
  public setDualLegSyncMode(enabled: boolean): void {
    if (enabled === this.dualLegSyncMode) return;
    if (this.activeDragLeg) {
      this.cancelActiveDrag();
    }
    this.dualLegSyncMode = enabled;
    if (this.leftRig && this.rightRig) {
      this.leftRig.physics.handMode = enabled ? 'left-only' : 'both';
      this.rightRig.physics.handMode = enabled ? 'right-only' : 'both';
    }
  }

  public isDualLegSyncMode(): boolean {
    return this.dualLegSyncMode;
  }

  public isStockingDragging(): boolean {
    return this.activeDragLeg !== null;
  }

  /** Cancel an in-progress stocking drag cleanly (e.g. if Electron window loses focus) */
  public cancelActiveDrag(): void {
    if (!this.activeDragLeg) return;
    const finishedSide = this.activeDragLeg.side;
    this.activeDragLeg.physics.endDrag();
    this.secondaryDragLeg?.physics.endDrag();
    this.activeDragLeg = null;
    this.secondaryDragLeg = null;
    this.activePointerId = null;
    this.app.canvas.style.cursor = 'default';
    this.onInteractionEnd?.(finishedSide);
  }

  /** Smoothly scale character inside the canvas without resizing the OS window or moving HTML overlays */
  public setDisplayScale(scaleFactor: number): void {
    this.targetDisplayScale = Math.max(0.35, Math.min(1.0, scaleFactor));
  }

  /** Pause/resume PixiJS WebGL ticker so idle hidden desktop widget consumes 0% GPU & <0.3% CPU */
  public setRenderingPaused(paused: boolean): void {
    if (this.destroyed || !this.app?.ticker) return;
    if (paused === this.renderingPaused) return;
    this.renderingPaused = paused;
    if (paused) {
      this.app.ticker.stop();
    } else {
      // Snap one clean frame immediately before resuming so color/quota changes never show a stale frame
      if (this.leftRig && this.rightRig) {
        this.update(1 / 120, 8.3);
        try {
          this.app.render();
        } catch {
          // ignore if renderer not ready
        }
      }
      this.app.ticker.start();
    }
  }

  /** Force layout recalculation after display DPI / window resize changes */
  public forceResize(): void {
    if (this.destroyed || !this.manifest) return;
    this.app.resize();
    this.fitWorldToCanvas();
  }

  /**
   * Fast O(1) anatomical hit-test for transparent desktop click-through & drag separation:
   * - 'cuff': stocking cuff or low-quota instep/foot -> drags stocking!
   * - 'skirt': pleated skirt hem at top -> ideal handle to move the desktop window!
   * - 'body': opaque bare thigh/leg/active hands -> captures mouse (no click-through on character).
   * - 'none': transparent empty area around/between legs -> pass clicks through to Windows!
   */
  public hitTestRegion(clientX: number, clientY: number): StageHitRegion {
    if (!this.manifest || !this.leftRig || !this.rightRig) return 'none';
    const pt = this.clientToImage(clientX, clientY);
    if (pt.x < -10 || pt.x > this.manifest.imageWidth + 10 || pt.y < -10 || pt.y > this.manifest.imageHeight + 10) {
      return 'none';
    }

    // 1. Upper pleated skirt strip at very top (raised well above skirt hem so 100% stocking pulls never trigger window drag!)
    if (pt.y >= 0 && pt.y <= StockingQuotaStage.SKIRT_DRAG_MAX_Y && pt.x >= 165 && pt.x <= 605) {
      return 'skirt';
    }

    // 2. Stocking cuff / low-quota foot grab band -> stocking interaction takes priority!
    if (this.hitTestCuff(pt.x, pt.y)) {
      return 'cuff';
    }

    // 2b. Lower skirt hem strip (between SKIRT_DRAG_MAX_Y and hem ~176): still opaque character body (blocks click-through, won't drag window)
    if (pt.y > StockingQuotaStage.SKIRT_DRAG_MAX_Y && pt.y <= 176 && pt.x >= 165 && pt.x <= 605) {
      return 'body';
    }

    // 3. Opaque leg silhouettes + active hands bounding areas
    const rigs = [this.leftRig, this.rightRig];
    for (const rig of rigs) {
      const m = rig.mesh.meta;
      if (pt.y >= m.yTop && pt.y <= m.yToe + 6) {
        const c = rig.mesh.sampleContour(pt.y);
        const pad = 10;
        if (pt.x >= c.xLeft - pad && pt.x <= c.xRight + pad) {
          return 'body';
        }
      }
      // Also keep active hands interactive when pulling or shielding!
      if (rig.physics.handEngagement > 0.12 || rig.physics.shieldEngagement > 0.12) {
        const centerY =
          rig.physics.shieldEngagement > 0.35
            ? rig.mesh.getFootShieldPoint().y
            : rig.physics.sampleCuffY(0.5) - 24;
        const c = rig.mesh.sampleContour(Math.min(m.yToe, Math.max(m.yTop, centerY)));
        if (Math.abs(pt.y - centerY) < 75 && pt.x >= c.xLeft - 52 && pt.x <= c.xRight + 52) {
          return 'body';
        }
      }
    }

    return 'none';
  }

  public setPhysicsConfig(partial: Partial<PhysicsConfig>): void {
    this.physicsConfig = { ...this.physicsConfig, ...partial };
  }

  public setVisualConfig(partial: Partial<StockingVisualConfig>): void {
    this.visualConfig = { ...this.visualConfig, ...partial };
    this.leftRig?.shader.updateVisual(this.visualConfig);
    this.rightRig?.shader.updateVisual(this.visualConfig);
  }

  /** Programmatically perform an interactive pull-and-snap demonstration (great for testing & demos!) */
  public triggerDemoPull(side: LegSide, pullDistancePx = 220, grabU = 0.35, holdMs = 850): void {
    const rig = side === 'left' ? this.leftRig : this.rightRig;
    if (!rig) return;
    const other = this.dualLegSyncMode ? (side === 'left' ? this.rightRig : this.leftRig) : null;
    const pt = rig.mesh.getCuffPoint(rig.physics, grabU);
    rig.physics.startDrag(pt.x, pt.y, grabU, this.dualLegSyncMode ? (side === 'left' ? 'left-only' : 'right-only') : 'both');
    if (other) {
      other.physics.startDrag(pt.x, pt.y, Math.max(0.05, Math.min(0.95, 1 - grabU)), other.side === 'left' ? 'left-only' : 'right-only');
    }

    const startTime = performance.now();
    const rampMs = 420;
    const stepAnim = () => {
      if (this.destroyed || !rig.physics.isDragging) return;
      const elapsed = performance.now() - startTime;
      const p = Math.min(1, elapsed / rampMs);
      const ease = 1 - Math.pow(1 - p, 3);
      const nextX = pt.x + (grabU - 0.5) * 28 * ease;
      const nextY = pt.y + pullDistancePx * ease;
      rig.physics.updateDrag(nextX, nextY);
      other?.physics.updateDrag(nextX, nextY);

      if (elapsed < holdMs) {
        requestAnimationFrame(stepAnim);
      } else {
        rig.physics.endDrag();
        other?.physics.endDrag();
      }
    };
    requestAnimationFrame(stepAnim);
  }

  public destroy(): void {
    this.destroyed = true;
    this.cleanupListeners?.();
    this.resizeObserver?.disconnect();
    this.app.destroy(true, { children: true });
  }
}
