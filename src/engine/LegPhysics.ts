import { LegGeometryMeta, LegTelemetry, PhysicsConfig } from './types';

export const CUFF_NODE_COUNT = 11;
export type HandGripMode = 'both' | 'left-only' | 'right-only';

/**
 * Physically-grounded elastic stocking cuff, instep-roll, barefoot & yank-off solver.
 *
 * Quota spectrum [0..100%]:
 * - 100%: tucked cleanly under the pleated skirt hem (zero exposed bare thigh).
 * - 14%..100%: continuous height from slender ankle up to upper thigh.
 * - 1%..14%: half-rolled / bunched sock sitting over the instep & toes.
 * - 0%: completely barefoot (sock slipped cleanly off).
 *
 * Yank-off interaction:
 * - Pulling the half-rolled sock downward off the toes pops it off (`isPulledOff = true`),
 *   immediately triggering the character's shy foot-shielding hands (`shieldEngagement -> 1`).
 */
export class LegPhysics {
  public readonly meta: LegGeometryMeta;

  /** External target percentage [0..100], never mutated by user drag */
  public targetQuotaPct = 82;
  /** Smoothly interpolated internal quota pct */
  public smoothedQuotaPct = 82;

  /** Vertical displacement of each cuff node relative to restY (positive = pulled down) */
  public readonly nodeDisp = new Float32Array(CUFF_NODE_COUNT);
  public readonly nodeVel = new Float32Array(CUFF_NODE_COUNT);

  /** Horizontal slight lateral pull offset (image px, interior fabric only) */
  public lateralShift = 0;
  public lateralVel = 0;

  /** Interaction state */
  public isDragging = false;
  public grabU = 0.5;
  public dragStartPointerY = 0;
  public dragStartPointerX = 0;
  public dragInitialDisp = 0;
  public currentPointerY = 0;
  public currentPointerX = 0;

  /** Derived animation state */
  public tension = 0; // [0..1]
  public handEngagement = 0; // [0..1] cuff-pulling hands
  public handGrabProgress = 0; // [0..1] open -> pinch
  public wrinkleEnergy = 0; // [0..1.4]
  public snapWavePhase = 0;
  public snapWaveAmp = 0;
  public time = 0;

  /** Low-quota instep roll, barefoot & yank-off shielding state */
  public instepRoll = 0; // [0..1] 1 = half-rolled on instep/toes
  public isPulledOff = false; // true after user yanks sock off the toes!
  public slipOffProgress = 0; // [0..1] 0 = on foot, 1 = completely off toes (barefoot)
  public shieldEngagement = 0; // [0..1] hands shyly covering bare foot!
  private pullOffHoldTimer = 0;
  private barefootPokeShield = false;

  /** Normalized cuff U positions where left & right hands grip */
  public leftHandU = 0.16;
  public rightHandU = 0.84;
  /** Whether both hands grip this leg, or only one hand (when both legs are pulled in sync) */
  public handMode: HandGripMode = 'both';

  private accumulator = 0;
  private readonly fixedDt = 1 / 240;

  constructor(meta: LegGeometryMeta, initialQuota = 82) {
    this.meta = meta;
    this.targetQuotaPct = initialQuota;
    this.smoothedQuotaPct = initialQuota;
    if (initialQuota <= 0.1) {
      this.slipOffProgress = 1;
    }
  }

  /** Vertical travel distance from ankle (14%) up to under-skirt top (100%) */
  public get legSpan(): number {
    return Math.max(40, this.meta.yAnkle - this.meta.yTop);
  }

  /** Foot instep resting max Y (at ~1% quota, half-rolled on instep/toes) */
  public get yInstepLow(): number {
    return Math.min(this.meta.yToe - 34, this.meta.yInstep + 34);
  }

  /** Rest Y position in image pixels for the current quota */
  public get restY(): number {
    const pct = Math.max(0, Math.min(100, this.smoothedQuotaPct));
    if (pct >= 14) {
      // 14% -> yAnkle, 100% -> yTop (tucked cleanly under skirt hem!)
      const t = (pct - 14) / 86;
      return this.meta.yAnkle - t * this.legSpan;
    }
    // 1%..14% -> smoothly rolls down across the instep!
    const footT = Math.max(0, Math.min(1, (14 - pct) / 13));
    return this.meta.yAnkle + footT * (this.yInstepLow - this.meta.yAnkle);
  }

  public get meanDisp(): number {
    let sum = 0;
    for (let i = 0; i < CUFF_NODE_COUNT; i++) sum += this.nodeDisp[i];
    return sum / CUFF_NODE_COUNT;
  }

  public get meanVel(): number {
    let sum = 0;
    for (let i = 0; i < CUFF_NODE_COUNT; i++) sum += this.nodeVel[i];
    return sum / CUFF_NODE_COUNT;
  }

  public sampleDispAtU(u: number): number {
    const clamped = Math.max(0, Math.min(1, u));
    const f = clamped * (CUFF_NODE_COUNT - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(CUFF_NODE_COUNT - 1, i0 + 1);
    const frac = f - i0;
    return this.nodeDisp[i0] * (1 - frac) + this.nodeDisp[i1] * frac;
  }

  public sampleCuffY(u: number): number {
    const y = this.restY + this.sampleDispAtU(u);
    const minY = this.meta.yTop - 10;
    const maxY = this.meta.yToe - 18;
    return Math.max(minY, Math.min(maxY, y));
  }

  public startDrag(pointerX: number, pointerY: number, grabU: number, handMode: HandGripMode = 'both'): void {
    this.isDragging = true;
    this.handMode = handMode;
    this.grabU = Math.max(0.05, Math.min(0.95, grabU));
    this.dragStartPointerX = pointerX;
    this.dragStartPointerY = pointerY;
    this.currentPointerX = pointerX;
    this.currentPointerY = pointerY;
    this.dragInitialDisp = this.sampleDispAtU(this.grabU);

    // If completely barefoot (0% quota) and user pokes/grabs bare foot -> shy shielding!
    if (this.smoothedQuotaPct < 1.2 || this.isPulledOff) {
      this.barefootPokeShield = true;
    }

    if (handMode === 'left-only') {
      this.leftHandU = 0.24;
      this.rightHandU = 0.84;
    } else if (handMode === 'right-only') {
      this.leftHandU = 0.16;
      this.rightHandU = 0.76;
    } else {
      this.leftHandU = this.grabU < 0.25 ? 0.11 : 0.17;
      this.rightHandU = this.grabU > 0.75 ? 0.89 : 0.83;
    }
  }

  public updateDrag(pointerX: number, pointerY: number): void {
    if (!this.isDragging) return;
    this.currentPointerX = pointerX;
    this.currentPointerY = pointerY;
  }

  public endDrag(): void {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.barefootPokeShield = false;

    if (this.isPulledOff) {
      // Keep shy shielding for a playful moment after yanking off before she slips the sock back on
      this.pullOffHoldTimer = Math.max(this.pullOffHoldTimer, 0.95);
      return;
    }

    const releaseStrength = Math.min(1, Math.abs(this.meanDisp) / (this.legSpan * 0.25));
    this.snapWaveAmp = Math.max(this.snapWaveAmp, releaseStrength * 0.85);
    this.snapWavePhase = 0;

    const asym = this.grabU - 0.5;
    for (let i = 0; i < CUFF_NODE_COUNT; i++) {
      const u = i / (CUFF_NODE_COUNT - 1);
      const localBoost = Math.exp(-Math.pow((u - this.grabU) / 0.35, 2));
      this.nodeVel[i] -= this.nodeDisp[i] * (2.6 + localBoost * 1.4) + asym * (u - 0.5) * 45;
    }
  }

  public step(dtSeconds: number, config: PhysicsConfig): void {
    const safeDt = Math.min(0.05, Math.max(0, dtSeconds));
    this.time += safeDt;

    // Smooth non-teleporting elastic glide when real external quota updates or switches Agent/session
    const quotaLerp = 1 - Math.exp(-6.5 * safeDt);
    this.smoothedQuotaPct += (this.targetQuotaPct - this.smoothedQuotaPct) * quotaLerp;

    // Handle yank-off recovery timer once user releases mouse
    if (this.isPulledOff && !this.isDragging) {
      this.pullOffHoldTimer -= safeDt;
      if (this.pullOffHoldTimer <= 0 && this.targetQuotaPct >= 1) {
        this.isPulledOff = false;
        // Slip sock back on with an elastic upward snap!
        for (let i = 0; i < CUFF_NODE_COUNT; i++) {
          this.nodeDisp[i] = 36;
          this.nodeVel[i] = -360;
        }
        this.snapWaveAmp = 0.7;
        this.snapWavePhase = 0;
      }
    }

    this.accumulator += safeDt;
    while (this.accumulator >= this.fixedDt) {
      this.substep(this.fixedDt, config);
      this.accumulator -= this.fixedDt;
    }

    const currentCuffY = this.restY + this.meanDisp;

    // Check yank-off trigger: when sock is in low/instep zone and user yanks decisively downward off the toes!
    if (this.isDragging && !this.isPulledOff && this.smoothedQuotaPct >= 1) {
      const pullDeltaY = this.currentPointerY - this.dragStartPointerY;
      const inFootZone = this.smoothedQuotaPct <= 18 || currentCuffY >= this.meta.yInstep - 6;
      const yankedPastToes =
        (this.smoothedQuotaPct <= 16 && pullDeltaY > 52) ||
        (inFootZone && currentCuffY >= this.meta.yInstep + 20 && pullDeltaY > 75);

      if (yankedPastToes) {
        this.isPulledOff = true;
        this.pullOffHoldTimer = 1.15;
      }
    }

    // Barefoot (0% quota) or yanked off -> slide sock cleanly off toes
    const isQuotaBarefoot = this.smoothedQuotaPct < 1.2;
    const targetSlip = this.isPulledOff
      ? 1.0
      : isQuotaBarefoot
        ? Math.max(0, Math.min(1, (1.2 - this.smoothedQuotaPct) / 1.2))
        : 0.0;
    const slipSpeed = targetSlip > this.slipOffProgress ? 14 : 11;
    this.slipOffProgress += (targetSlip - this.slipOffProgress) * (1 - Math.exp(-slipSpeed * safeDt));
    if (this.slipOffProgress < 0.004 && targetSlip === 0) this.slipOffProgress = 0;
    if (this.slipOffProgress > 0.996 && targetSlip === 1) this.slipOffProgress = 1;

    // Instep half-rolled factor [0..1] when cuff sits on top of the foot/instep
    const rawInstep = Math.max(
      0,
      Math.min(1, (currentCuffY - (this.meta.yAnkle + 4)) / Math.max(20, this.yInstepLow - this.meta.yAnkle - 4))
    );
    this.instepRoll += (rawInstep - this.instepRoll) * (1 - Math.exp(-16 * safeDt));

    // Foot-shielding hands ("用手挡住"!) engage immediately when yanked off or poking bare foot!
    const targetShield = this.isPulledOff || this.barefootPokeShield ? 1.0 : 0.0;
    const shieldSpeed = targetShield > this.shieldEngagement ? 17 : 8.5;
    this.shieldEngagement += (targetShield - this.shieldEngagement) * (1 - Math.exp(-shieldSpeed * safeDt));
    if (this.shieldEngagement < 0.004 && targetShield === 0) this.shieldEngagement = 0;

    // Derived tension & cuff-pulling hand engagement (suppressed while in foot-shielding mode!)
    const maxPullPx = this.legSpan * config.maxPullFraction;
    const rawTension = this.isPulledOff
      ? 0.85
      : Math.max(0, Math.min(1, this.meanDisp / Math.max(1, maxPullPx * 0.48)));
    const tensionRate = rawTension > this.tension ? 18 : 11;
    this.tension += (rawTension - this.tension) * (1 - Math.exp(-tensionRate * safeDt));

    const pullingDown =
      this.isDragging &&
      !this.isPulledOff &&
      !isQuotaBarefoot &&
      (this.currentPointerY - this.dragStartPointerY > 3 || this.meanDisp > 4);

    const targetEngage =
      this.isPulledOff || isQuotaBarefoot
        ? 0
        : pullingDown
          ? Math.min(1, 0.38 + rawTension * 0.82)
          : this.meanDisp > 6
            ? Math.min(0.85, (this.meanDisp / (maxPullPx * 0.5)) * 0.85)
            : 0;

    const engageSpeed = targetEngage > this.handEngagement ? 15 : 8.5;
    this.handEngagement += (targetEngage - this.handEngagement) * (1 - Math.exp(-engageSpeed * safeDt));
    if (this.handEngagement < 0.004 && !this.isDragging) {
      this.handEngagement = 0;
    }

    const targetGrab =
      pullingDown && this.meanDisp > 3
        ? Math.min(1, 0.32 + rawTension * 0.88)
        : Math.max(0, this.handEngagement * 0.7);
    this.handGrabProgress += (targetGrab - this.handGrabProgress) * (1 - Math.exp(-16 * safeDt));

    const targetWrinkle = this.isPulledOff
      ? 0.3
      : Math.min(1.4, Math.max(0, this.meanDisp / (this.legSpan * 0.24)) + Math.min(0.4, Math.abs(this.meanVel) / 1400));
    const wrinkleRate = targetWrinkle > this.wrinkleEnergy ? 16 : 6.5;
    this.wrinkleEnergy += (targetWrinkle - this.wrinkleEnergy) * (1 - Math.exp(-wrinkleRate * safeDt));

    this.snapWavePhase += safeDt * 24;
    this.snapWaveAmp *= Math.exp(-6.2 * safeDt);
  }

  private substep(dt: number, config: PhysicsConfig): void {
    const span = this.legSpan;
    const maxPullPx = span * config.maxPullFraction;
    const minPullPx = -Math.min(20, Math.max(0, this.restY - this.meta.yTop) + 6);
    // Allow pulling all the way down into the instep/toe yank-off zone when starting low!
    const lowAllowance = this.smoothedQuotaPct <= 22 ? this.meta.yToe - 18 - this.restY : this.meta.yInstep + 26 - this.restY;
    const maxDownLimit = Math.max(24, Math.min(maxPullPx, lowAllowance));

    const kBase = config.stiffness;
    const cDamp = config.damping * 2 * Math.sqrt(kBase);
    const kLateral = kBase * (0.45 + config.cuffElasticity * 3.8);

    const activePull = this.isDragging && !this.isPulledOff && this.smoothedQuotaPct >= 1.2;
    const rawMouseDisp = activePull
      ? this.dragInitialDisp + (this.currentPointerY - this.dragStartPointerY)
      : 0;
    const rawMouseLateral = activePull
      ? Math.max(-40, Math.min(40, (this.currentPointerX - this.dragStartPointerX) * 0.2))
      : 0;

    const latForce = activePull
      ? kBase * 0.85 * (rawMouseLateral - this.lateralShift) - kBase * 0.45 * this.lateralShift - cDamp * 1.1 * this.lateralVel
      : -kBase * 1.4 * this.lateralShift - cDamp * 1.05 * this.lateralVel;
    this.lateralVel += latForce * dt;
    this.lateralShift += this.lateralVel * dt;

    const tugOsc =
      this.handEngagement > 0.25
        ? (Math.sin(this.time * 13.5) * 0.5 + Math.sin(this.time * 22.0) * 0.35 + 0.15) *
          Math.pow(this.tension, 1.8) *
          this.handEngagement
        : 0;

    const acc = new Float32Array(CUFF_NODE_COUNT);

    for (let i = 0; i < CUFF_NODE_COUNT; i++) {
      const u = i / (CUFF_NODE_COUNT - 1);
      const d = this.nodeDisp[i];
      const v = this.nodeVel[i];

      const normD = d / Math.max(1, maxPullPx * 0.62);
      const dirStiff = d < 0 ? 2.4 : 1.0;
      const nonLinearTerm = 1.0 + config.nonLinearResistance * normD * normD;
      let force = -kBase * dirStiff * d * nonLinearTerm;

      if (d > 2 && this.handEngagement > 0.02) {
        const wLeft = this.handMode !== 'right-only' ? Math.exp(-Math.pow((u - this.leftHandU) / 0.22, 2)) : 0;
        const wRight = this.handMode !== 'left-only' ? Math.exp(-Math.pow((u - this.rightHandU) / 0.22, 2)) : 0;
        const handMask = Math.min(1.15, wLeft + wRight);
        const counterPull =
          kBase * config.handCounterStrength * this.handEngagement * (0.28 + 0.72 * handMask) * (d * 0.65 + tugOsc * 26);
        force -= counterPull;
      }

      if (activePull) {
        const distU = u - this.grabU;
        const sigma = 0.24 + config.cuffElasticity * 0.34;
        const localWeight = 0.24 + 0.76 * Math.exp(-(distU * distU) / (2 * sigma * sigma));
        const kDrag = kBase * config.dragCoupling * localWeight;

        const clampedTarget =
          rawMouseDisp >= 0
            ? maxDownLimit * 1.45 * Math.tanh(rawMouseDisp / Math.max(1, maxDownLimit * 1.45))
            : Math.max(minPullPx * 1.2, rawMouseDisp * 0.65);

        force += kDrag * (clampedTarget - d);
        force -= cDamp * 1.35 * v;
      } else {
        force -= cDamp * v;
      }

      const leftD = i > 0 ? this.nodeDisp[i - 1] : d;
      const rightD = i < CUFF_NODE_COUNT - 1 ? this.nodeDisp[i + 1] : d;
      const leftV = i > 0 ? this.nodeVel[i - 1] : v;
      const rightV = i < CUFF_NODE_COUNT - 1 ? this.nodeVel[i + 1] : v;

      force += kLateral * (leftD + rightD - 2 * d);
      force += cDamp * 0.45 * (leftV + rightV - 2 * v);

      acc[i] = force;
    }

    for (let i = 0; i < CUFF_NODE_COUNT; i++) {
      this.nodeVel[i] += acc[i] * dt;
      if (this.nodeVel[i] > 3200) this.nodeVel[i] = 3200;
      if (this.nodeVel[i] < -3200) this.nodeVel[i] = -3200;

      this.nodeDisp[i] += this.nodeVel[i] * dt;

      if (this.nodeDisp[i] > maxDownLimit) {
        this.nodeDisp[i] = maxDownLimit;
        if (this.nodeVel[i] > 0) this.nodeVel[i] *= -0.12;
      } else if (this.nodeDisp[i] < minPullPx) {
        this.nodeDisp[i] = minPullPx;
        if (this.nodeVel[i] < 0) this.nodeVel[i] *= -0.15;
      }

      if (!activePull && Math.abs(this.nodeDisp[i]) < 0.08 && Math.abs(this.nodeVel[i]) < 0.6) {
        this.nodeDisp[i] *= 0.92;
        this.nodeVel[i] *= 0.85;
      }
    }
  }

  public getTelemetry(): LegTelemetry {
    const disp = this.meanDisp;
    return {
      side: this.meta.side,
      quotaPct: this.targetQuotaPct,
      cuffY: this.restY + disp,
      restY: this.restY,
      displacementPx: disp,
      velocityPx: this.meanVel,
      tension: this.tension,
      isDragging: this.isDragging,
      handEngagement: this.handEngagement,
      shieldEngagement: this.shieldEngagement,
      instepRoll: this.instepRoll,
      isPulledOff: this.isPulledOff,
      maxWrinkle: this.wrinkleEnergy,
    };
  }
}
