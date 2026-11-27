import { app, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './providers/types';
import type { RealAgentId } from './windowTracker';

export type WidgetMode = 'hover' | 'pinned';
export type HoverAnchorMode = 'host' | 'pill';
export type WidgetSizePreset = 'compact' | 'medium' | 'large';
export type AnchorCorner = 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface HostAnchorConfig {
  corner: AnchorCorner;
  /** Offset in DIP from the host window's reference corner */
  dx: number;
  dy: number;
  /** Invisible hover hotspot radius in DIP */
  radius: number;
  calibrated?: boolean;
}

export interface PersistedWidgetState {
  x: number | null;
  y: number | null;
  mode: WidgetMode;
  hoverAnchorMode: HoverAnchorMode;
  autoFollowAgent: boolean;
  hideTrayIcon: boolean;
  sentinelEnabled: boolean;
  autoExitWhenNoAgents: boolean;
  visible: boolean;
  sizePreset: WidgetSizePreset;
  /** Continuous overall widget scale percentage [65..150] (100 = 336x486) */
  scalePct: number;
  activeAgent: AgentId;
  leftQuota: number;
  rightQuota: number;
  /** Resting height of DSH's unbound free-play right leg */
  dshFreeLegQuota: number;
  presetId: string;
  laceCuff: boolean;
  hostAnchors: Record<RealAgentId, HostAnchorConfig>;
}

/**
 * Fixed transparent host canvas dimensions (DIP).
 * Character scaling happens smoothly at 144fps inside PixiJS WebGL while transparent pixels
 * remain 100% click-through — so the OS window and settings popover NEVER jitter or jump!
 */
export const HOST_WINDOW_WIDTH = 448;
export const HOST_WINDOW_HEIGHT = 620;

export const SIZE_DIMENSIONS: Record<WidgetSizePreset, { width: number; height: number; scalePct: number }> = {
  compact: { width: HOST_WINDOW_WIDTH, height: HOST_WINDOW_HEIGHT, scalePct: 75 },
  medium: { width: HOST_WINDOW_WIDTH, height: HOST_WINDOW_HEIGHT, scalePct: 100 },
  large: { width: HOST_WINDOW_WIDTH, height: HOST_WINDOW_HEIGHT, scalePct: 135 },
};

export const DEFAULT_HOST_ANCHORS: Record<RealAgentId, HostAnchorConfig> = {
  // Codex desktop bottom-left circular quota button (above orange avatar in sidebar)
  codex: { corner: 'bottom-left', dx: 20, dy: -66, radius: 28 },
  // DeepSeek Harness bottom-center circular ContextMeter indicator
  dsh: { corner: 'bottom-center', dx: 12, dy: -22, radius: 36 },
  // Fallback for the Antigravity model selector when accessibility bounds are unavailable.
  antigravity: { corner: 'bottom-left', dx: 155, dy: -38, radius: 44 },
};

export function scaleToDimensions(scalePct: number): { width: number; height: number; clampedPct: number } {
  const clampedPct = Math.max(65, Math.min(150, Math.round(scalePct)));
  return {
    width: HOST_WINDOW_WIDTH,
    height: HOST_WINDOW_HEIGHT,
    clampedPct,
  };
}

export function hasCalibratedAntigravityAnchor(anchor: HostAnchorConfig): boolean {
  const defaults = DEFAULT_HOST_ANCHORS.antigravity;
  return Boolean(anchor.calibrated || anchor.corner !== defaults.corner ||
    anchor.dx !== defaults.dx || anchor.dy !== defaults.dy);
}

export function resolveHostHotspotDip(
  hostRect: Electron.Rectangle,
  anchor: HostAnchorConfig,
  uiaButton?: Electron.Rectangle | null,
  agent?: RealAgentId,
): HostHotspot {
  let baseX = hostRect.x;
  if (anchor.corner === 'bottom-center') {
    baseX = hostRect.x + hostRect.width * 0.5;
  } else if (anchor.corner === 'bottom-right') {
    baseX = hostRect.x + hostRect.width;
  }
  const baseY = hostRect.y + hostRect.height;
  const hotspot = {
    cx: Math.round(baseX + anchor.dx),
    cy: Math.round(baseY + anchor.dy),
    radius: Math.max(18, Math.min(80, anchor.radius)),
  };
  if (!uiaButton) return hotspot;

  // For Codex, ALWAYS prefer live UIA button bounds when detected so sidebar open/close/resize never drifts!
  // For Antigravity, honor explicit user calibration override if set.
  const calibrated = agent === 'antigravity' ? hasCalibratedAntigravityAnchor(anchor) : false;
  const buttonCenterX = uiaButton.x + uiaButton.width / 2;
  const buttonCenterY = uiaButton.y + uiaButton.height / 2;
  return {
    ...hotspot,
    cx: calibrated ? hotspot.cx : Math.round(buttonCenterX),
    cy: calibrated ? hotspot.cy : Math.round(buttonCenterY),
    button: uiaButton,
    calibrated,
  };
}

interface HostHotspot {
  cx: number;
  cy: number;
  radius: number;
  button?: Electron.Rectangle;
  calibrated?: boolean;
}

export function isPointInHostHotspot(point: Electron.Point, spot: HostHotspot): boolean {
  const button = spot.button;
  if (button && !spot.calibrated) {
    // Generous 4px halo around the exact UIA button rectangle for effortless hover feel
    const pad = 4;
    return (
      point.x >= button.x - pad &&
      point.x < button.x + button.width + pad &&
      point.y >= button.y - pad &&
      point.y < button.y + button.height + pad
    );
  }
  return Math.hypot(point.x - spot.cx, point.y - spot.cy) <= spot.radius;
}

export function computeHostAnchorFromPoint(
  hostRect: Electron.Rectangle,
  cursorDip: { x: number; y: number },
  prevRadius = 28
): HostAnchorConfig {
  const relX = (cursorDip.x - hostRect.x) / Math.max(1, hostRect.width);
  let corner: AnchorCorner = 'bottom-left';
  let baseX = hostRect.x;
  if (relX > 0.68) {
    corner = 'bottom-right';
    baseX = hostRect.x + hostRect.width;
  } else if (relX >= 0.32) {
    corner = 'bottom-center';
    baseX = hostRect.x + hostRect.width * 0.5;
  }
  const baseY = hostRect.y + hostRect.height;
  return {
    corner,
    dx: Math.round(cursorDip.x - baseX),
    dy: Math.round(cursorDip.y - baseY),
    radius: prevRadius,
    calibrated: true,
  };
}

export function resolvePopupBoundsForHotspot(
  spot: HostHotspot,
  corner: AnchorCorner,
  agent: RealAgentId,
): Electron.Rectangle | null {
  const { cx, cy } = spot;
  const displays = screen.getAllDisplays();
  const nearest = displays.length > 0 ? screen.getDisplayNearestPoint({ x: cx, y: cy }) : screen.getPrimaryDisplay();
  const wa = nearest.workArea;
  const width = Math.min(HOST_WINDOW_WIDTH, Math.max(300, wa.width - 20));
  const height = Math.min(HOST_WINDOW_HEIGHT, Math.max(420, wa.height - 12));

  if (agent === 'antigravity') {
    const button = spot.button;
    const right = Math.max(cx + (button && !spot.calibrated ? 0 : spot.radius), button ? button.x + button.width : cx);
    const left = Math.min(cx - (button && !spot.calibrated ? 0 : spot.radius), button?.x ?? cx);
    const gap = 10;
    const rightX = Math.max(wa.x, right + gap);
    const leftX = Math.min(wa.x + wa.width - width, left - gap - width);
    const x = rightX + width <= wa.x + wa.width ? rightX : leftX;
    if (x < wa.x) return null;
    const y = Math.max(wa.y, Math.min(wa.y + wa.height - height, cy - height + 110));
    return { x, y, width, height };
  }

  // Position stockings cleanly right beside/above the native quota icon with overlap bridge so cursor moves smoothly onto legs
  let targetX = Math.round(cx - width * 0.5);
  if (corner === 'bottom-left') {
    targetX = Math.round(cx - width * 0.24);
  } else if (corner === 'bottom-right') {
    targetX = Math.round(cx - width * 0.76);
  }
  const targetY = Math.round(cy - height + 46);

  return {
    x: Math.max(wa.x - 40, Math.min(wa.x + wa.width - width + 40, targetX)),
    y: Math.max(wa.y - 30, Math.min(wa.y + wa.height - height + 10, targetY)),
    width,
    height,
  };
}

const DEFAULT_STATE: PersistedWidgetState = {
  x: null,
  y: null,
  mode: 'hover',
  hoverAnchorMode: 'host',
  autoFollowAgent: true,
  hideTrayIcon: true,
  sentinelEnabled: true,
  autoExitWhenNoAgents: false,
  visible: true,
  sizePreset: 'medium',
  scalePct: 100,
  activeAgent: 'codex',
  leftQuota: 82,
  rightQuota: 58,
  dshFreeLegQuota: 62,
  presetId: 'codex-white',
  laceCuff: false,
  hostAnchors: {
    codex: { ...DEFAULT_HOST_ANCHORS.codex },
    dsh: { ...DEFAULT_HOST_ANCHORS.dsh },
    antigravity: { ...DEFAULT_HOST_ANCHORS.antigravity },
  },
};

export class StateStore {
  private readonly filePath: string;
  private state: PersistedWidgetState;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'stocking-quota-state.json');
    this.state = this.load();
  }

  private load(): PersistedWidgetState {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<PersistedWidgetState>;
        const isFirstV3Upgrade = parsed.activeAgent === undefined;
        const parsedAnchors = parsed.hostAnchors ?? ({} as Partial<Record<RealAgentId, HostAnchorConfig>>);
        return {
          ...DEFAULT_STATE,
          ...parsed,
          presetId: isFirstV3Upgrade ? DEFAULT_STATE.presetId : parsed.presetId ?? DEFAULT_STATE.presetId,
          laceCuff: isFirstV3Upgrade ? DEFAULT_STATE.laceCuff : parsed.laceCuff ?? DEFAULT_STATE.laceCuff,
          mode: parsed.mode === 'hover' || parsed.mode === 'pinned' ? parsed.mode : DEFAULT_STATE.mode,
          hoverAnchorMode:
            parsed.hoverAnchorMode === 'host' || parsed.hoverAnchorMode === 'pill'
              ? parsed.hoverAnchorMode
              : DEFAULT_STATE.hoverAnchorMode,
          autoFollowAgent:
            typeof parsed.autoFollowAgent === 'boolean' ? parsed.autoFollowAgent : DEFAULT_STATE.autoFollowAgent,
          hideTrayIcon:
            typeof parsed.hideTrayIcon === 'boolean' ? parsed.hideTrayIcon : DEFAULT_STATE.hideTrayIcon,
          sentinelEnabled:
            typeof parsed.sentinelEnabled === 'boolean' ? parsed.sentinelEnabled : DEFAULT_STATE.sentinelEnabled,
          autoExitWhenNoAgents:
            typeof parsed.autoExitWhenNoAgents === 'boolean'
              ? parsed.autoExitWhenNoAgents
              : DEFAULT_STATE.autoExitWhenNoAgents,
          sizePreset:
            parsed.sizePreset === 'compact' || parsed.sizePreset === 'medium' || parsed.sizePreset === 'large'
              ? parsed.sizePreset
              : DEFAULT_STATE.sizePreset,
          scalePct:
            typeof parsed.scalePct === 'number' && Number.isFinite(parsed.scalePct)
              ? Math.max(65, Math.min(150, Math.round(parsed.scalePct)))
              : SIZE_DIMENSIONS[
                  parsed.sizePreset === 'compact' || parsed.sizePreset === 'medium' || parsed.sizePreset === 'large'
                    ? parsed.sizePreset
                    : 'medium'
                ].scalePct,
          activeAgent:
            parsed.activeAgent === 'codex' ||
            parsed.activeAgent === 'antigravity' ||
            parsed.activeAgent === 'dsh' ||
            parsed.activeAgent === 'simulated'
              ? parsed.activeAgent
              : DEFAULT_STATE.activeAgent,
          leftQuota: clampPct(parsed.leftQuota ?? DEFAULT_STATE.leftQuota),
          rightQuota: clampPct(parsed.rightQuota ?? DEFAULT_STATE.rightQuota),
          dshFreeLegQuota: clampPct(parsed.dshFreeLegQuota ?? DEFAULT_STATE.dshFreeLegQuota),
          hostAnchors: {
            codex: { ...DEFAULT_HOST_ANCHORS.codex, ...(parsedAnchors.codex ?? {}) },
            dsh: { ...DEFAULT_HOST_ANCHORS.dsh, ...(parsedAnchors.dsh ?? {}) },
            antigravity: { ...DEFAULT_HOST_ANCHORS.antigravity, ...(parsedAnchors.antigravity ?? {}) },
          },
        };
      }
    } catch (err) {
      console.warn('[StateStore] Failed to load state, using defaults:', err);
    }
    return {
      ...DEFAULT_STATE,
      hostAnchors: {
        codex: { ...DEFAULT_HOST_ANCHORS.codex },
        dsh: { ...DEFAULT_HOST_ANCHORS.dsh },
        antigravity: { ...DEFAULT_HOST_ANCHORS.antigravity },
      },
    };
  }

  public get(): PersistedWidgetState {
    return {
      ...this.state,
      hostAnchors: {
        codex: { ...this.state.hostAnchors.codex },
        dsh: { ...this.state.hostAnchors.dsh },
        antigravity: { ...this.state.hostAnchors.antigravity },
      },
    };
  }

  public update(patch: Partial<PersistedWidgetState>, immediate = false): PersistedWidgetState {
    this.state = {
      ...this.state,
      ...patch,
      hostAnchors: patch.hostAnchors
        ? {
            codex: { ...this.state.hostAnchors.codex, ...(patch.hostAnchors.codex ?? {}) },
            dsh: { ...this.state.hostAnchors.dsh, ...(patch.hostAnchors.dsh ?? {}) },
            antigravity: { ...this.state.hostAnchors.antigravity, ...(patch.hostAnchors.antigravity ?? {}) },
          }
        : this.state.hostAnchors,
    };
    if (immediate) {
      this.flush();
    } else {
      this.scheduleSave();
    }
    return this.get();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 250);
  }

  public flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[StateStore] Failed to save state:', err);
    }
  }

  public resolveSafeBounds(): { x: number; y: number; width: number; height: number } {
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();

    const computeDimsForWorkArea = (wa: Electron.Rectangle) => ({
      width: Math.min(HOST_WINDOW_WIDTH, Math.max(300, wa.width - 20)),
      height: Math.min(HOST_WINDOW_HEIGHT, Math.max(420, wa.height - 12)),
    });

    if (this.state.x === null || this.state.y === null || !Number.isFinite(this.state.x) || !Number.isFinite(this.state.y)) {
      const wa = primary.workArea;
      const dims = computeDimsForWorkArea(wa);
      return {
        x: Math.round(wa.x + wa.width - dims.width - 16),
        y: Math.round(wa.y + wa.height - dims.height - 10),
        width: dims.width,
        height: dims.height,
      };
    }

    const center = {
      x: Math.round(this.state.x + HOST_WINDOW_WIDTH * 0.5),
      y: Math.round(this.state.y + HOST_WINDOW_HEIGHT * 0.5),
    };
    const nearest = displays.length > 0 ? screen.getDisplayNearestPoint(center) : primary;
    const wa = nearest.workArea;
    const dims = computeDimsForWorkArea(wa);

    const minX = wa.x - 80;
    const maxX = wa.x + wa.width - dims.width + 80;
    const minY = wa.y - 60;
    const maxY = wa.y + wa.height - dims.height + 10;

    return {
      x: Math.max(minX, Math.min(maxX, Math.round(this.state.x))),
      y: Math.max(minY, Math.min(maxY, Math.round(this.state.y))),
      width: dims.width,
      height: dims.height,
    };
  }
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, Math.round(v)));
}
