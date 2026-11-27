import { Buffer, BufferUsage, Geometry, Mesh } from 'pixi.js';
import { LegPhysics } from './LegPhysics';
import { StockingShaderHandle } from './StockingShader';
import { ContourSample, LegGeometryMeta, StockingVisualConfig } from './types';

const COLS = 28;
const MARGIN_ROWS = 4; // Soft shadow margin directly above cuff (-14px..0px)
const BODY_ROWS = 64;  // Cuff lip (0px) down to toes
const TOTAL_ROWS = MARGIN_ROWS + BODY_ROWS;

/** Fixed horizontal mesh padding (px) outside bare leg contour so crisp shader semi-circle bumps never clip */
const OUTER_PAD_PX = 12.0;

export interface ContourAtY {
  xLeft: number;
  xRight: number;
  cx: number;
  halfWidth: number;
  slope: number;
}

/**
 * Dynamic anatomical cloth mesh wrapping a single anime leg silhouette.
 *
 * Passes exact leg-relative `uLeg` (0 at bare leg left edge, 1 at bare leg right edge)
 * and exact `halfWidth` per vertex so the fragment shader draws razor-sharp opaque
 * semi-circle fold protrusions right at horizontal folds with ZERO blurry outer halo!
 */
export class StockingMesh {
  public readonly mesh: Mesh<Geometry, StockingShaderHandle['shader']>;
  public readonly eraseMesh: Mesh<Geometry, StockingShaderHandle['eraseShader']>;
  public readonly meta: LegGeometryMeta;

  private readonly imageHeight: number;
  private readonly positions: Float32Array;
  private readonly uvs: Float32Array;
  private readonly strain: Float32Array;
  private readonly posBuffer: Buffer;
  private readonly uvBuffer: Buffer;
  private readonly strainBuffer: Buffer;

  constructor(
    meta: LegGeometryMeta,
    imageHeight: number,
    shaderHandle: StockingShaderHandle
  ) {
    this.meta = meta;
    this.imageHeight = imageHeight;

    const vertCount = COLS * TOTAL_ROWS;
    this.positions = new Float32Array(vertCount * 2);
    this.uvs = new Float32Array(vertCount * 2);
    this.strain = new Float32Array(vertCount * 2);

    const triCount = (COLS - 1) * (TOTAL_ROWS - 1) * 2;
    const indices = new Uint32Array(triCount * 3);
    let idx = 0;
    for (let r = 0; r < TOTAL_ROWS - 1; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const tl = r * COLS + c;
        const tr = tl + 1;
        const bl = (r + 1) * COLS + c;
        const br = bl + 1;
        indices[idx++] = tl;
        indices[idx++] = tr;
        indices[idx++] = bl;
        indices[idx++] = tr;
        indices[idx++] = br;
        indices[idx++] = bl;
      }
    }

    this.posBuffer = new Buffer({
      data: this.positions,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    this.uvBuffer = new Buffer({
      data: this.uvs,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });
    this.strainBuffer = new Buffer({
      data: this.strain,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    });

    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.posBuffer, format: 'float32x2' },
        aUV: { buffer: this.uvBuffer, format: 'float32x2' },
        aStrain: { buffer: this.strainBuffer, format: 'float32x2' },
      },
      indexBuffer: indices,
    });

    this.eraseMesh = new Mesh({
      geometry,
      shader: shaderHandle.eraseShader,
    });
    this.eraseMesh.blendMode = 'erase';

    this.mesh = new Mesh({
      geometry,
      shader: shaderHandle.shader,
    });
  }

  public sampleContour(yPx: number): ContourAtY {
    const slices: ContourSample[] = this.meta.slices;
    const n = slices.length;
    const yNorm = yPx / this.imageHeight;

    if (yNorm <= slices[0].y) {
      const s = slices[0];
      return { xLeft: s.xLeft, xRight: s.xRight, cx: s.cx, halfWidth: s.halfWidth, slope: 0 };
    }
    if (yNorm >= slices[n - 1].y) {
      const s = slices[n - 1];
      return { xLeft: s.xLeft, xRight: s.xRight, cx: s.cx, halfWidth: s.halfWidth, slope: 0 };
    }

    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (slices[mid].y <= yNorm) lo = mid;
      else hi = mid;
    }

    const s0 = slices[lo];
    const s1 = slices[hi];
    const span = Math.max(1e-6, s1.y - s0.y);
    const t = (yNorm - s0.y) / span;

    const xLeft = s0.xLeft + (s1.xLeft - s0.xLeft) * t;
    const xRight = s0.xRight + (s1.xRight - s0.xRight) * t;
    const cx = 0.5 * (xLeft + xRight);
    const halfWidth = 0.5 * (xRight - xLeft);
    const slope = (s1.halfWidth - s0.halfWidth) / Math.max(1, (s1.y - s0.y) * this.imageHeight);

    return { xLeft, xRight, cx, halfWidth, slope };
  }

  public getCuffPoint(physics: LegPhysics, u: number): { x: number; y: number; tangentAngle: number; halfWidth: number } {
    const clampedU = Math.max(0, Math.min(1, u));
    const y = physics.sampleCuffY(clampedU);
    const c = this.sampleContour(y);
    const interiorShift = physics.lateralShift * 0.25 * Math.sin(clampedU * Math.PI);
    const x = c.xLeft + (c.xRight - c.xLeft) * clampedU + interiorShift;

    const eps = 0.05;
    const u0 = Math.max(0, clampedU - eps);
    const u1 = Math.min(1, clampedU + eps);
    const y0 = physics.sampleCuffY(u0);
    const y1 = physics.sampleCuffY(u1);
    const c0 = this.sampleContour(y0);
    const c1 = this.sampleContour(y1);
    const x0 = c0.xLeft + (c0.xRight - c0.xLeft) * u0;
    const x1 = c1.xLeft + (c1.xRight - c1.xLeft) * u1;

    return {
      x,
      y,
      tangentAngle: Math.atan2(y1 - y0, Math.max(1, x1 - x0)),
      halfWidth: c.halfWidth,
    };
  }

  public getFootShieldPoint(): { x: number; y: number; halfWidth: number } {
    const y = this.meta.yInstep + 18;
    const c = this.sampleContour(y);
    return { x: c.cx, y, halfWidth: c.halfWidth };
  }

  public update(physics: LegPhysics, visual: StockingVisualConfig): void {
    const slipOffsetY = physics.slipOffProgress * 76.0;
    const yToe = this.meta.yToe + 4.0 + slipOffsetY;
    const restY = physics.restY;
    const restBodyLen = Math.max(36, this.meta.yToe + 4.0 - restY);

    const cuffYCol = new Float32Array(COLS);
    const cuffDispCol = new Float32Array(COLS);
    for (let c = 0; c < COLS; c++) {
      const uMesh = c / (COLS - 1);
      cuffYCol[c] = physics.sampleCuffY(uMesh) + slipOffsetY;
      cuffDispCol[c] = physics.sampleCuffY(uMesh) - restY;
    }

    const marginPx = 14.0;
    const pinchScale = visual.cuffPinch;
    const instepRoll = physics.instepRoll;

    for (let r = 0; r < TOTAL_ROWS; r++) {
      const isMargin = r < MARGIN_ROWS;
      const bodyFrac = isMargin ? 0 : (r - MARGIN_ROWS) / (BODY_ROWS - 1);
      const tNonLinear = isMargin ? 0 : Math.pow(bodyFrac, 1.32);

      for (let c = 0; c < COLS; c++) {
        const uMesh = c / (COLS - 1);
        const vIdx = (r * COLS + c) * 2;

        const yCuff = cuffYCol[c];
        const disp = cuffDispCol[c];
        let y: number;
        let clothPx: number;
        let localComp: number;

        if (isMargin) {
          const mFrac = r / MARGIN_ROWS;
          clothPx = -marginPx * (1.0 - mFrac);
          y = yCuff + clothPx;
          localComp = 0;
        } else {
          const curveFalloff = Math.pow(1.0 - tNonLinear, 1.9);
          const meanCuffY = restY + physics.meanDisp + slipOffsetY;
          const localCuffOffset = (yCuff - meanCuffY) * curveFalloff;

          const activeBodyLen = Math.max(24, yToe - meanCuffY);
          const bunchRatio = Math.max(0, disp / Math.max(80, restBodyLen));
          const compressedT = tNonLinear - bunchRatio * 0.14 * tNonLinear * Math.pow(1.0 - tNonLinear, 2.4);

          y = meanCuffY + compressedT * activeBodyLen + localCuffOffset;
          y = Math.min(yToe, y);

          clothPx = Math.max(0, y - yCuff);
          const zoneWeight = Math.exp(-clothPx / 92.0);
          localComp = (disp / Math.max(90, physics.legSpan * 0.45)) * zoneWeight + instepRoll * 0.55 * Math.exp(-clothPx / 46.0);
        }

        const contour = this.sampleContour(Math.min(this.meta.yToe, y));
        const legW = Math.max(12, contour.xRight - contour.xLeft);

        // Fixed outer padding outside bare leg contour -> fragment shader computes exact
        // pixel-level semi-circle protrusions with razor-crisp opaque edges and ZERO blurry haze!
        const xLeft = contour.xLeft - OUTER_PAD_PX;
        const xRight = contour.xRight + OUTER_PAD_PX;

        // Lateral drag shifts ONLY interior fabric (outer edges stay pinned -> zero skin leak!)
        const latFalloff = isMargin ? 0.55 : Math.pow(1.0 - tNonLinear, 2.8);
        const shiftX = physics.lateralShift * 0.34 * latFalloff * Math.sin(uMesh * Math.PI);

        // Smooth cylindrical cuff wrap; flattens completely to 0 near 100% under skirt
        const underSkirtFade = Math.max(0, Math.min(1, (yCuff - (this.meta.yTop + 28)) / 32));
        const wrapAmt = (2.4 + 1.2 * pinchScale + instepRoll * 3.2) * underSkirtFade;
        const wrap3dY = Math.sin(uMesh * Math.PI) * wrapAmt * (isMargin ? 1.0 : Math.pow(1.0 - tNonLinear, 3.0));

        const x = xLeft + (xRight - xLeft) * uMesh + shiftX;

        // Exact bare-leg-relative horizontal coordinate:
        // uLeg = 0 at bare leg left edge, 1 at bare leg right edge, <0 outside left, >1 outside right!
        const uLeg = (x - contour.xLeft) / legW;
        // Signed pixel distance outside bare leg silhouette (> 0 outside bare leg, <= 0 inside)
        const outPx = Math.max(contour.xLeft - x, x - contour.xRight);

        this.positions[vIdx] = x;
        this.positions[vIdx + 1] = y + wrap3dY;

        this.uvs[vIdx] = uLeg;
        this.uvs[vIdx + 1] = clothPx;

        // Pack: x = localComp, y = signed pixel distance outside bare leg silhouette!
        this.strain[vIdx] = localComp;
        this.strain[vIdx + 1] = outPx;
      }
    }

    this.posBuffer.update();
    this.uvBuffer.update();
    this.strainBuffer.update();
  }
}
