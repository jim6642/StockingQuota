export type LegSide = 'left' | 'right';

export interface ContourSample {
  /** Normalized Y in [0, 1] of the bare-legs image */
  y: number;
  /** Left edge X in image pixels */
  xLeft: number;
  /** Right edge X in image pixels */
  xRight: number;
  /** Center X in image pixels */
  cx: number;
  /** Half width in image pixels */
  halfWidth: number;
}

export interface LegGeometryMeta {
  side: LegSide;
  /** Image Y (pixels) tucked cleanly under pleated skirt hem (100% quota, zero exposed skin) */
  yTop: number;
  /** Image Y (pixels) of slender ankle (~15% quota) */
  yAnkle: number;
  /** Image Y (pixels) of foot instep / half-rolled low-quota zone (~2%..14% quota) */
  yInstep: number;
  /** Image Y (pixels) of bottom of foot / toe tip */
  yToe: number;
  /** Dense array of contour slices from well under skirt hem down to yToe */
  slices: ContourSample[];
}

export interface HandSpriteMeta {
  url: string;
  width: number;
  height: number;
  /** Normalized pinch pivot (where fingertips grip the stocking cuff) in [0,1] */
  pivotX: number;
  pivotY: number;
  /** Natural arm direction angle in radians (from pinch point toward forearm) */
  armAngle: number;
}

export interface AssetManifest {
  imageWidth: number;
  imageHeight: number;
  legsUrl: string;
  skirtUrl?: string;
  skinToneRgb: [number, number, number];
  legs: {
    left: LegGeometryMeta;
    right: LegGeometryMeta;
  };
  hands: {
    openLeft: HandSpriteMeta;
    openRight: HandSpriteMeta;
    gripLeft: HandSpriteMeta;
    gripRight: HandSpriteMeta;
    shieldLeft: HandSpriteMeta;
    shieldRight: HandSpriteMeta;
  };
}

export interface PhysicsConfig {
  /** Base restoring stiffness (higher = firmer elastic pull-back) */
  stiffness: number;
  /** Non-linear cubic stiffening factor (higher = stronger resistance at large pulls) */
  nonLinearResistance: number;
  /** Viscous damping ratio (0.3 = bouncy, 0.6 = crisp, 0.9 = overdamped) */
  damping: number;
  /** User drag coupling ratio relative to base stiffness (~1.6 gives ~3cm cuff per 5cm mouse) */
  dragCoupling: number;
  /** Lateral elastic coupling across cuff width (controls local curving vs flat cuff) */
  cuffElasticity: number;
  /** Max downward pull displacement as fraction of leg span */
  maxPullFraction: number;
  /** Active reverse-pull force contribution from the two hands */
  handCounterStrength: number;
}

export interface StockingVisualConfig {
  /** Base matte velvet fabric color (hex, e.g. '#3d2959') */
  color: string;
  /** Subtle warm matte sheen / edge tint color */
  highlightColor: string;
  /** Denier / thickness (15 = sheer mist, 34 = velvet matte, 70 = plush opaque) */
  denier: number;
  /** Subtle satin-matte scatter [0..1.5] (default ~0.08 = pure velvet matte!) */
  sheen: number;
  /** Cylindrical Fresnel velvet edge darkening strength [0.4..1.8] */
  fresnel: number;
  /** Manga/Galgame pull-fold shadow & ridge strength [0..2] */
  wrinkleStrength: number;
  /** Fine powdery velvet micro-grain visibility [0..2] */
  weaveIntensity: number;
  /** Elastic cuff band thickness (pixels in image space) */
  cuffHeight: number;
  /** Subtle thigh shadow right above cuff [0..1.8] */
  cuffPinch: number;
  /** Cuff style: matte double-knit rib vs gothic scalloped lace */
  laceCuff: boolean;
}

export interface StockingPreset {
  id: string;
  name: string;
  agentHint: string;
  visual: Partial<StockingVisualConfig>;
}

export interface LegTelemetry {
  side: LegSide;
  quotaPct: number;
  cuffY: number;
  restY: number;
  displacementPx: number;
  velocityPx: number;
  tension: number; // [0..1]
  isDragging: boolean;
  handEngagement: number; // [0..1]
  shieldEngagement: number; // [0..1]
  instepRoll: number; // [0..1] how much sock is bunched/half-rolled on instep
  isPulledOff: boolean;
  maxWrinkle: number;
}

export interface StageTelemetry {
  fps: number;
  frameTimeMs: number;
  left: LegTelemetry;
  right: LegTelemetry;
}

export const DEFAULT_PHYSICS_CONFIG: PhysicsConfig = {
  stiffness: 195,
  nonLinearResistance: 2.8,
  damping: 0.44,
  dragCoupling: 1.55,
  cuffElasticity: 0.58,
  maxPullFraction: 0.52,
  handCounterStrength: 0.34,
};

export const DEFAULT_VISUAL_CONFIG: StockingVisualConfig = {
  color: '#3b2857',
  highlightColor: '#e8c4d6',
  denier: 36,
  sheen: 0.08,
  fresnel: 1.28,
  wrinkleStrength: 1.05,
  weaveIntensity: 0.85,
  cuffHeight: 22,
  cuffPinch: 0.85,
  laceCuff: false,
};

export const STOCKING_PRESETS: StockingPreset[] = [
  {
    id: 'antigravity-purple',
    name: 'Antigravity 雾紫天鹅绒',
    agentHint: '哑光透肉 · 风格 #6 默认',
    visual: {
      color: '#3b2857',
      highlightColor: '#e8c4d6',
      denier: 36,
      sheen: 0.08,
      fresnel: 1.28,
      wrinkleStrength: 1.05,
      laceCuff: false,
    },
  },
  {
    id: 'gothic-velvet-lace',
    name: '暗黑天鹅绒 · 蕾丝袜口',
    agentHint: '参考图同款哑光黑丝',
    visual: {
      color: '#21192b',
      highlightColor: '#d9b5c2',
      denier: 42,
      sheen: 0.04,
      fresnel: 1.42,
      wrinkleStrength: 1.12,
      laceCuff: true,
    },
  },
  {
    id: 'codex-white',
    name: 'Codex 柔雾哑光白丝',
    agentHint: 'Codex (哑光奶油白)',
    visual: {
      color: '#ede7f2',
      highlightColor: '#ffffff',
      denier: 54,
      sheen: 0.06,
      fresnel: 1.05,
      wrinkleStrength: 1.05,
      laceCuff: false,
    },
  },
  {
    id: 'dsh-blue',
    name: 'DSH 深海雾蓝天鹅绒',
    agentHint: 'DeepSeek Harness (哑光蓝)',
    visual: {
      color: '#233659',
      highlightColor: '#c9dcf5',
      denier: 38,
      sheen: 0.08,
      fresnel: 1.32,
      wrinkleStrength: 1.05,
      laceCuff: false,
    },
  },
];
