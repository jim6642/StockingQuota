import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerMonitor, screen, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DetectedAgentInfo, detectLocalAgents } from './providers/agentDetector';
import { AgentManager } from './providers/agentManager';
import { DshPluginInstallStatus, ensureDshBridgeInstalled, uninstallDshBridge } from './providers/dshPluginInstaller';
import { AGENT_BINDINGS, AgentId, DshMeterViewportRect } from './providers/types';
import { QuotaBridge } from './quotaBridge';
import { disableSentinel, enableSentinel, stopSentinelProcess } from './sentinelManager';
import {
  computeHostAnchorFromPoint,
  hasCalibratedAntigravityAnchor,
  HoverAnchorMode,
  isPointInHostHotspot,
  PersistedWidgetState,
  resolveHostHotspotDip,
  resolvePopupBoundsForHotspot,
  scaleToDimensions,
  SIZE_DIMENSIONS,
  StateStore,
  WidgetMode,
  WidgetSizePreset,
} from './stateStore';
import { RealAgentId, WinForegroundTracker, WindowTrackerSnapshot } from './windowTracker';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: StateStore;
let quotaBridge: QuotaBridge;
let agentManager: AgentManager;
let winTracker: WinForegroundTracker;
let detectedAgents: DetectedAgentInfo[] = [];
let dshPluginStatus: DshPluginInstallStatus = {
  dshDetected: false,
  installed: false,
  justInstalled: false,
  needsDshRestart: false,
  message: '',
};

let lastIgnoreMouse = true;
let stockingDragLocked = false;
let isWindowDragging = false;
let dragStartCursor = { x: 0, y: 0 };
let dragStartBounds = { x: 0, y: 0, width: 448, height: 620 };
let dragInterval: NodeJS.Timeout | null = null;
let cursorGuardInterval: NodeJS.Timeout | null = null;
let cursorWasInsideBounds = false;

// Host-icon invisible hover hotspot state
let hostHoverActive = false;
let lastHostPopupAgent: RealAgentId | null = null;
let calibratingAgent: RealAgentId | null = null;
let antigravityClickUntil = 0;
let antigravityMustLeaveHotspot = false;
let codexClickUntil = 0;
let codexMustLeaveHotspot = false;
let lastDshMeterRect: DshMeterViewportRect | null = null;

function computeDshMeterButtonDip(
  hostRectDip: Electron.Rectangle,
  meter: DshMeterViewportRect | null
): Electron.Rectangle | null {
  if (!meter || meter.viewportW < 100 || meter.viewportH < 100) return null;
  if (meter.width <= 0 || meter.height <= 0) return null;
  // Bottom-aligned scale mapping: completely eliminates titlebar height ambiguity & tracks right/left split-pane toggles!
  const scale = hostRectDip.width / Math.max(1, meter.viewportW);
  const distFromBottom = meter.viewportH - meter.y;
  const x = Math.round(hostRectDip.x + meter.x * scale);
  const y = Math.round(hostRectDip.y + hostRectDip.height - distFromBottom * scale);
  const width = Math.max(24, Math.round(meter.width * scale));
  const height = Math.max(18, Math.round(meter.height * scale));
  if (x < hostRectDip.x - 20 || x > hostRectDip.x + hostRectDip.width + 20) return null;
  if (y < hostRectDip.y - 20 || y > hostRectDip.y + hostRectDip.height + 20) return null;
  return { x, y, width, height };
}

// Optional auto-exit timer when user enables "随 Agent 关闭自动退出"
let sawAnyRunningAgent = false;
let autoExitTimer: NodeJS.Timeout | null = null;

const cliSilent = process.argv.includes('--silent');
const cliSentinelManaged = process.argv.includes('--sentinel-managed');
const cliFromAgentArg = process.argv.find((a) => a.startsWith('--from-agent='))?.split('=')[1] as RealAgentId | undefined;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Keep transparent WebGL rendering crisp and GPU-accelerated on Windows
app.commandLine.appendSwitch('enable-transparent-visuals');

function getAssetPath(...segments: string[]): string {
  return path.join(app.getAppPath(), ...segments);
}

function applyIgnoreMouse(ignore: boolean, forward = true): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const effectiveIgnore = stockingDragLocked || isWindowDragging ? false : ignore;
  if (effectiveIgnore === lastIgnoreMouse) return;
  lastIgnoreMouse = effectiveIgnore;
  if (effectiveIgnore) {
    mainWindow.setIgnoreMouseEvents(true, { forward });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
}

function assertAlwaysOnTop(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function broadcastState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('widget:state-sync', store.get());
  rebuildTrayMenu();
}

function broadcastDetectedAgents(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('widget:detected-agents', detectedAgents);
  rebuildTrayMenu();
}

function refreshDetectedAgents(runningAgents: RealAgentId[]): void {
  const next = detectLocalAgents(runningAgents);
  const sigPrev = JSON.stringify(detectedAgents);
  const sigNext = JSON.stringify(next);
  detectedAgents = next;

  const installedIds = next.filter((a) => a.installed).map((a) => a.id);
  agentManager?.setInstalledAgents(installedIds);

  if (sigPrev !== sigNext) {
    broadcastDetectedAgents();
  }
}

function applyScalePct(rawPct: number, notifyRenderer = false): void {
  const nextDims = scaleToDimensions(rawPct);
  const sizePreset: WidgetSizePreset =
    nextDims.clampedPct <= 88 ? 'compact' : nextDims.clampedPct >= 118 ? 'large' : 'medium';

  store.update({ scalePct: nextDims.clampedPct, sizePreset });
  if (notifyRenderer) {
    broadcastState();
  } else {
    rebuildTrayMenu();
  }
}

function applyWindowSize(sizePreset: WidgetSizePreset): void {
  applyScalePct(SIZE_DIMENSIONS[sizePreset].scalePct, true);
}

function resetWindowToDefaultCorner(): void {
  store.update({ x: null, y: null, visible: true }, true);
  const safe = store.resolveSafeBounds();
  store.update({ x: safe.x, y: safe.y }, true);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(safe, false);
    mainWindow.showInactive();
    assertAlwaysOnTop();
  }
  broadcastState();
}

function summonWidgetAndSettings(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  lastHostPopupAgent = null;
  hostHoverActive = false;
  store.update({ visible: true }, true);
  const safe = store.resolveSafeBounds();
  mainWindow.setBounds(safe, false);
  mainWindow.webContents.send('widget:rendering-pause', false);
  mainWindow.show();
  assertAlwaysOnTop();
  agentManager?.startPolling(60_000, false);
  mainWindow.webContents.send('widget:summon-settings');
  broadcastState();
}

function toggleWindowVisibility(forceVisible?: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const target = typeof forceVisible === 'boolean' ? forceVisible : !mainWindow.isVisible();
  store.update({ visible: target }, true);
  if (target) {
    const safe = store.resolveSafeBounds();
    mainWindow.setBounds(safe, false);
    mainWindow.webContents.send('widget:rendering-pause', false);
    mainWindow.showInactive();
    assertAlwaysOnTop();
    mainWindow.webContents.send('widget:resume-refresh');
    agentManager?.startPolling(60_000, false);
  } else {
    stopWindowDrag();
    stockingDragLocked = false;
    mainWindow.webContents.send('widget:rendering-pause', true);
    mainWindow.hide();
    agentManager?.stopPolling();
  }
  broadcastState();
}

function startWindowDrag(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  stopWindowDrag();
  isWindowDragging = true;
  applyIgnoreMouse(false);

  dragStartCursor = screen.getCursorScreenPoint();
  const b = mainWindow.getBounds();
  const dims = scaleToDimensions(store.get().scalePct);
  dragStartBounds = { x: b.x, y: b.y, width: dims.width, height: dims.height };

  dragInterval = setInterval(() => {
    if (!isWindowDragging || !mainWindow || mainWindow.isDestroyed()) {
      stopWindowDrag();
      return;
    }
    const cur = screen.getCursorScreenPoint();
    const dx = cur.x - dragStartCursor.x;
    const dy = cur.y - dragStartCursor.y;
    const nextX = Math.round(dragStartBounds.x + dx);
    const nextY = Math.round(dragStartBounds.y + dy);

    mainWindow.setBounds(
      {
        x: nextX,
        y: nextY,
        width: dragStartBounds.width,
        height: dragStartBounds.height,
      },
      false
    );
  }, 14);
}

function stopWindowDrag(): void {
  if (!isWindowDragging) return;
  isWindowDragging = false;
  if (dragInterval) {
    clearInterval(dragInterval);
    dragInterval = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    const b = mainWindow.getBounds();
    store.update({ x: b.x, y: b.y });
    const safe = store.resolveSafeBounds();
    if (safe.x !== b.x || safe.y !== b.y || safe.width !== b.width || safe.height !== b.height) {
      mainWindow.setBounds(safe, false);
      store.update({ x: safe.x, y: safe.y });
    }
    store.flush();
  }
}

function switchActiveAgent(agent: AgentId, preserveCustomVisual = false): void {
  const binding = AGENT_BINDINGS[agent];
  const patch: Partial<PersistedWidgetState> = { activeAgent: agent };
  if (!preserveCustomVisual) {
    patch.presetId = binding.defaultPresetId;
    patch.laceCuff = false;
  }
  store.update(patch, true);
  agentManager.setActiveAgent(agent);
  broadcastState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('widget:agent-metric', agentManager.getMetric(agent));
  }
}

function cancelHostCalibration(): void {
  if (!calibratingAgent) return;
  calibratingAgent = null;
  try {
    globalShortcut.unregister('Space');
    globalShortcut.unregister('Escape');
  } catch {
    // ignore
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('widget:calibration-state', { active: false, agent: null });
  }
}

function startHostCalibration(agent: RealAgentId): void {
  cancelHostCalibration();
  calibratingAgent = agent;

  const label = AGENT_BINDINGS[agent].displayName;
  const control = agent === 'antigravity' ? '切换模型按钮' : '额度图标';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('widget:calibration-state', {
      active: true,
      agent,
      hint: `切到 ${label}，把鼠标停在${control}上按【空格】锁定（Esc 取消）`,
    });
  }

  try {
    globalShortcut.register('Escape', () => cancelHostCalibration());
    globalShortcut.register('Space', () => {
      if (!calibratingAgent) return;
      const target = calibratingAgent;
      const snap = winTracker.getSnapshot();
      const hostRect = snap.activeHostAgent === target ? snap.hostRectDip : null;

      if (!hostRect) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('widget:calibration-state', {
            active: true,
            agent: target,
            hint: `请先点一下 ${label} 窗口让它在最前，再把鼠标停在${control}上按【空格】`,
          });
        }
        return;
      }

      const pt = screen.getCursorScreenPoint();
      const prev = store.get().hostAnchors[target];
      const nextAnchor = computeHostAnchorFromPoint(hostRect, pt, prev.radius);
      const nextAnchors = { ...store.get().hostAnchors, [target]: nextAnchor };
      store.update({ hostAnchors: nextAnchors, mode: 'hover', hoverAnchorMode: 'host' }, true);

      cancelHostCalibration();
      broadcastState();

      // Immediately pop up beside the newly calibrated icon as instant visual confirmation!
      const uiaBtn =
        target === 'antigravity'
          ? snap.antigravityModelButtonDip
          : target === 'codex'
            ? snap.codexQuotaButtonDip
            : target === 'dsh'
              ? snap.dshMeterButtonDip ?? computeDshMeterButtonDip(hostRect, lastDshMeterRect)
              : null;
      const spot = resolveHostHotspotDip(hostRect, nextAnchor, uiaBtn, target);
      showHostPopup(target, resolvePopupBoundsForHotspot(spot, nextAnchor.corner, target));
    });
  } catch (err) {
    console.warn('[Calibration] Failed to register shortcuts:', err);
    cancelHostCalibration();
  }
}

function showHostPopup(agent: RealAgentId, bounds: Electron.Rectangle | null): void {
  if (!bounds || !mainWindow || mainWindow.isDestroyed()) return;
  hostHoverActive = true;
  lastHostPopupAgent = agent;
  mainWindow.webContents.send('widget:rendering-pause', false);
  mainWindow.setBounds(bounds, false);
  if (!mainWindow.isVisible()) mainWindow.showInactive();
  assertAlwaysOnTop();
  mainWindow.webContents.send('widget:host-hover-trigger', { active: true, agent });
}

function hideHostPopupImmediate(expectedAgent?: RealAgentId | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (expectedAgent && lastHostPopupAgent !== expectedAgent) return;
  const prevAgent = lastHostPopupAgent;
  hostHoverActive = false;
  lastHostPopupAgent = null;
  cursorWasInsideBounds = false;
  applyIgnoreMouse(true);
  mainWindow.hide();
  mainWindow.webContents.send('widget:host-hover-trigger', {
    active: false,
    agent: expectedAgent ?? prevAgent ?? null,
    immediate: true,
  });
  mainWindow.webContents.send('widget:rendering-pause', true);
}

function handleModelMouseDown(point: Electron.Point): void {
  if (!mainWindow || mainWindow.isDestroyed() || isWindowDragging || stockingDragLocked || calibratingAgent) return;
  const state = store.get();
  if (state.mode !== 'hover' || state.hoverAnchorMode !== 'host') return;
  const snap = winTracker.getSnapshot();
  if (snap.activeHostAgent !== 'antigravity' || !snap.hostRectDip) return;
  const spot = resolveHostHotspotDip(
    snap.hostRectDip,
    state.hostAnchors.antigravity,
    snap.antigravityModelButtonDip,
    'antigravity'
  );
  if (!isPointInHostHotspot(point, spot) && !isPointInHostHotspot(point, { ...spot, calibrated: false })) return;

  antigravityClickUntil = Date.now() + 850;
  antigravityMustLeaveHotspot = true;
  hideHostPopupImmediate('antigravity');
}

function handleCodexMouseDown(point: Electron.Point): void {
  if (!mainWindow || mainWindow.isDestroyed() || isWindowDragging || stockingDragLocked || calibratingAgent) return;
  const state = store.get();
  if (state.mode !== 'hover' || state.hoverAnchorMode !== 'host') return;
  const snap = winTracker.getSnapshot();
  if (snap.activeHostAgent !== 'codex' || !snap.hostRectDip) return;
  const spot = resolveHostHotspotDip(snap.hostRectDip, state.hostAnchors.codex, snap.codexQuotaButtonDip, 'codex');
  if (!isPointInHostHotspot(point, spot)) return;

  codexClickUntil = Date.now() + 850;
  codexMustLeaveHotspot = true;
  hideHostPopupImmediate('codex');
}

/**
 * Main-process 30ms cursor boundary guard + Host-Icon Invisible Hover Hotspot engine.
 */
function startCursorBoundaryGuard(): void {
  if (cursorGuardInterval) clearInterval(cursorGuardInterval);
  cursorGuardInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (isWindowDragging || stockingDragLocked) return;

    const state = store.get();
    const pt = screen.getCursorScreenPoint();

    // 1. Host-icon invisible hotspot trigger (Mode A + anchorMode === 'host')
    if (state.mode === 'hover' && state.hoverAnchorMode === 'host' && !calibratingAgent) {
      const snap = winTracker.getSnapshot();
      const hostAgent = snap.activeHostAgent;
      const hostRect = snap.hostRectDip;

      if (hostAgent && hostRect && snap.fgAgent !== '') {
        if (snap.antigravityModelMenuOpen) hideHostPopupImmediate('antigravity');
        if (snap.codexMenuOpen) hideHostPopupImmediate('codex');

        const anchor = state.hostAnchors[hostAgent];
        const uiaButton =
          hostAgent === 'antigravity'
            ? snap.antigravityModelButtonDip
            : hostAgent === 'codex'
              ? snap.codexQuotaButtonDip
              : hostAgent === 'dsh'
                ? snap.dshMeterButtonDip ?? computeDshMeterButtonDip(hostRect, lastDshMeterRect)
                : null;
        const spot = resolveHostHotspotDip(hostRect, anchor, uiaButton, hostAgent);

        // If UIA is active on Codex and the sidebar/button is hidden offscreen, don't phantom-trigger on empty space!
        const codexButtonHiddenBySidebar =
          hostAgent === 'codex' && snap.codexUiaReady && !snap.codexQuotaButtonDip && !anchor.calibrated;
        const hasHotspot =
          hostAgent === 'antigravity'
            ? Boolean(spot.button || hasCalibratedAntigravityAnchor(anchor))
            : !codexButtonHiddenBySidebar;

        const insideHotspot = hasHotspot && isPointInHostHotspot(pt, spot);

        const agySuppressed =
          hostAgent === 'antigravity' &&
          (snap.antigravityModelMenuOpen || antigravityMustLeaveHotspot || Date.now() < antigravityClickUntil);
        const cxSuppressed =
          hostAgent === 'codex' &&
          (snap.codexMenuOpen || codexMustLeaveHotspot || Date.now() < codexClickUntil);

        if (!insideHotspot || hostAgent !== 'antigravity') antigravityMustLeaveHotspot = false;
        if (!insideHotspot || hostAgent !== 'codex') codexMustLeaveHotspot = false;

        if (insideHotspot && !agySuppressed && !cxSuppressed) {
          if (!hostHoverActive || lastHostPopupAgent !== hostAgent) {
            if (state.autoFollowAgent && state.activeAgent !== hostAgent && state.activeAgent !== 'simulated') {
              switchActiveAgent(hostAgent);
            }
            const popBounds = resolvePopupBoundsForHotspot(spot, anchor.corner, hostAgent);
            showHostPopup(hostAgent, popBounds);
          }
        } else if (hostHoverActive) {
          hostHoverActive = false;
          mainWindow.webContents.send('widget:host-hover-trigger', { active: false, agent: hostAgent });
        }
      } else if (hostHoverActive || lastHostPopupAgent) {
        // Immediately hide host popup when switching away to an unrelated window so it never lingers or flashes!
        hideHostPopupImmediate();
      }
    }

    // 2. Classic Windows setIgnoreMouseEvents({ forward: true }) stale mouseleave guard
    if (!mainWindow.isVisible()) return;
    const b = mainWindow.getBounds();
    const inside = pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;

    if (!inside) {
      if (!lastIgnoreMouse) {
        applyIgnoreMouse(true, true);
      }
      if (cursorWasInsideBounds) {
        cursorWasInsideBounds = false;
        mainWindow.webContents.send('widget:cursor-outside');
      }
    } else {
      cursorWasInsideBounds = true;
    }
  }, 30);
}

function handleTrackerSnapshot(snap: WindowTrackerSnapshot): void {
  refreshDetectedAgents(snap.runningAgents);

  const state = store.get();

  // FIX white-to-purple flash: when switching foreground windows away from the currently visible
  // host-anchored popup (e.g. Codex -> Antigravity / Chrome), hide the old popup IMMEDIATELY
  // BEFORE switching activeAgent/preset so the fading stockings NEVER flash into the next Agent's color!
  if (
    state.mode === 'hover' &&
    state.hoverAnchorMode === 'host' &&
    !calibratingAgent &&
    !isWindowDragging &&
    !stockingDragLocked &&
    snap.fgAgent !== 'self' &&
    lastHostPopupAgent !== null &&
    snap.fgAgent !== lastHostPopupAgent
  ) {
    hideHostPopupImmediate();
  }

  // Auto-follow foreground Agent window (never hijack explicit 'simulated' testing mode)
  if (
    state.autoFollowAgent &&
    state.activeAgent !== 'simulated' &&
    (snap.fgAgent === 'codex' || snap.fgAgent === 'antigravity' || snap.fgAgent === 'dsh') &&
    snap.fgAgent !== state.activeAgent
  ) {
    switchActiveAgent(snap.fgAgent);
  }

  // Auto-exit Electron when all tracked Agent apps have closed (sentinel stays at ~3MB ready to wake!)
  if (snap.runningAgents.length > 0) {
    sawAnyRunningAgent = true;
    if (autoExitTimer) {
      clearTimeout(autoExitTimer);
      autoExitTimer = null;
    }
  } else if ((state.autoExitWhenNoAgents || cliSentinelManaged) && sawAnyRunningAgent && !autoExitTimer) {
    autoExitTimer = setTimeout(() => {
      autoExitTimer = null;
      const cur = store.get();
      if ((cur.autoExitWhenNoAgents || cliSentinelManaged) && winTracker.getSnapshot().runningAgents.length === 0) {
        store.flush();
        app.quit();
      }
    }, 30_000);
  }
}

function buildContextMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  const s: PersistedWidgetState = store.get();
  const installedList = detectedAgents.filter((a) => a.installed);
  const agentItems: Electron.MenuItemConstructorOptions[] = [];

  for (const info of installedList) {
    const labelMap: Record<RealAgentId, string> = {
      codex: 'OpenAI Codex（白丝 · 5H / 周额度）',
      antigravity: 'Google Antigravity（紫丝 · Gemini 额度）',
      dsh: 'DeepSeek Harness（蓝丝 · 上下文 / 自由互动）',
    };
    agentItems.push({
      label: `${labelMap[info.id]}${info.running ? ' · 运行中' : ''}`,
      type: 'radio',
      checked: s.activeAgent === info.id,
      click: () => switchActiveAgent(info.id),
    });
  }

  if (agentItems.length > 0) agentItems.push({ type: 'separator' });
  agentItems.push({
    label: '模拟调试模式（手动滑块）',
    type: 'radio',
    checked: s.activeAgent === 'simulated',
    click: () => switchActiveAgent('simulated'),
  });

  return [
    {
      label: '打开设置面板（快捷键 Ctrl+Alt+S）',
      click: () => summonWidgetAndSettings(),
    },
    {
      label: s.visible ? '隐藏桌面悬浮窗' : '显示桌面悬浮窗',
      click: () => toggleWindowVisibility(!s.visible),
    },
    { type: 'separator' },
    {
      label: '数据源 Agent 切换（自动检测本机）',
      submenu: agentItems,
    },
    {
      label: '立即刷新当前 Agent 额度',
      enabled: s.activeAgent === 'codex' || s.activeAgent === 'antigravity',
      click: () => {
        void agentManager.refresh(s.activeAgent, true);
      },
    },
    { type: 'separator' },
    {
      label: '模式 A：悬停弹出（贴靠原生图标 · 无药丸）',
      type: 'radio',
      checked: s.mode === 'hover' && s.hoverAnchorMode === 'host',
      click: () => {
        store.update({ mode: 'hover', hoverAnchorMode: 'host' }, true);
        broadcastState();
      },
    },
    {
      label: '模式 A：悬停弹出（独立迷你徽章）',
      type: 'radio',
      checked: s.mode === 'hover' && s.hoverAnchorMode === 'pill',
      click: () => {
        store.update({ mode: 'hover', hoverAnchorMode: 'pill' }, true);
        broadcastState();
      },
    },
    {
      label: '模式 B：桌面常驻（置顶透明挂件）',
      type: 'radio',
      checked: s.mode === 'pinned',
      click: () => {
        store.update({ mode: 'pinned' }, true);
        broadcastState();
      },
    },
    { type: 'separator' },
    {
      label: '隐藏电脑系统托盘图标（隐身模式）',
      type: 'checkbox',
      checked: s.hideTrayIcon,
      click: (item) => {
        store.update({ hideTrayIcon: item.checked }, true);
        syncTrayVisibility();
        broadcastState();
      },
    },
    {
      label: '单额度双腿同步显示（一手拉一袜）',
      type: 'checkbox',
      checked: s.syncSingleQuotaBothLegs,
      click: (item) => {
        store.update({ syncSingleQuotaBothLegs: item.checked }, true);
        broadcastState();
      },
    },
    {
      label: '自动跟随前台 Agent 切换丝袜',
      type: 'checkbox',
      checked: s.autoFollowAgent,
      click: (item) => {
        store.update({ autoFollowAgent: item.checked }, true);
        broadcastState();
      },
    },
    {
      label: '所有 Agent 关闭后自动退出',
      type: 'checkbox',
      checked: s.autoExitWhenNoAgents,
      click: (item) => {
        store.update({ autoExitWhenNoAgents: item.checked }, true);
        broadcastState();
      },
    },
    { type: 'separator' },
    {
      label: '角色显示大小',
      submenu: [
        { label: '迷你挂件 (75%)', type: 'radio', checked: s.sizePreset === 'compact', click: () => applyWindowSize('compact') },
        { label: '标准尺寸 (100%)', type: 'radio', checked: s.sizePreset === 'medium', click: () => applyWindowSize('medium') },
        { label: '大屏展示 (135%)', type: 'radio', checked: s.sizePreset === 'large', click: () => applyWindowSize('large') },
      ],
    },
    {
      label: '重置窗口到主屏右下角',
      click: () => resetWindowToDefaultCorner(),
    },
    {
      label: '退出 StockingQuota',
      click: () => {
        stopSentinelProcess();
        store.flush();
        app.quit();
      },
    },
  ];
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const s = store.get();
  const metric = agentManager ? agentManager.getMetric(s.activeAgent) : null;
  let summary = `左 ${s.leftQuota}% / 右 ${s.rightQuota}%`;
  if (s.activeAgent !== 'simulated' && metric) {
    if (metric.status === 'unavailable') {
      summary = `${AGENT_BINDINGS[s.activeAgent].displayName} 暂不可用`;
    } else if (s.activeAgent === 'dsh') {
      const w0 = metric.windows[0];
      summary = `DSH 上下文剩余 ${Math.round(w0?.remainingPercent ?? 0)}%`;
    } else {
      const realWins = metric.windows.filter((w) => !w.isFreePlay && typeof w.remainingPercent === 'number');
      if (realWins.length === 1) {
        const w0 = realWins[0];
        summary = `${AGENT_BINDINGS[s.activeAgent].displayName} ${w0.label} ${Math.round(w0.remainingPercent ?? 0)}%`;
      } else {
        const w0 = realWins[0]?.remainingPercent;
        const w1 = realWins[1]?.remainingPercent;
        summary = `${AGENT_BINDINGS[s.activeAgent].displayName} ${w0 !== undefined ? `${Math.round(w0)}%` : '--'} / ${w1 !== undefined ? `${Math.round(w1)}%` : '--'}`;
      }
    }
  }
  tray.setToolTip(`StockingQuota · ${summary}`);
  tray.setContextMenu(Menu.buildFromTemplate(buildContextMenuTemplate()));
}

function loadNativeIcon(): Electron.NativeImage {
  const unpackedIco = getAssetPath('build', 'icon.ico').replace('app.asar', 'app.asar.unpacked');
  if (fs.existsSync(unpackedIco)) {
    const ico = nativeImage.createFromPath(unpackedIco);
    if (!ico.isEmpty()) return ico;
  }
  const pngPath = getAssetPath('build', 'tray.png');
  if (fs.existsSync(pngPath)) {
    const buf = fs.readFileSync(pngPath);
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) return img;
  }
  return nativeImage.createEmpty();
}

function syncTrayVisibility(): void {
  const shouldHide = store.get().hideTrayIcon;
  if (shouldHide) {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  } else if (!tray) {
    const icon = loadNativeIcon();
    tray = new Tray(icon);
    tray.on('click', () => toggleWindowVisibility());
    rebuildTrayMenu();
  }
}

function createMainWindow(): void {
  const safeBounds = store.resolveSafeBounds();
  store.update({ x: safeBounds.x, y: safeBounds.y });

  mainWindow = new BrowserWindow({
    x: safeBounds.x,
    y: safeBounds.y,
    width: safeBounds.width,
    height: safeBounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    icon: getAssetPath('build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  lastIgnoreMouse = false;
  applyIgnoreMouse(true, true);
  assertAlwaysOnTop();

  const devUrl = process.env.ELECTRON_DEV_URL;
  if (devUrl) {
    mainWindow.loadURL(`${devUrl.replace(/\/$/, '')}/widget.html`);
  } else {
    mainWindow.loadFile(getAssetPath('dist', 'widget.html'));
  }

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const s = store.get();
    if (cliSilent && s.mode === 'hover' && s.hoverAnchorMode === 'host') {
      // Launched silently by an Agent: keep ready & transparent with zero flash until hover!
      mainWindow.showInactive();
      assertAlwaysOnTop();
    } else {
      store.update({ visible: true });
      mainWindow.showInactive();
      assertAlwaysOnTop();
    }
    rebuildTrayMenu();
  });

  mainWindow.on('blur', () => {
    stopWindowDrag();
    stockingDragLocked = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('widget:focus-change', false);
      assertAlwaysOnTop();
    }
  });

  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('widget:focus-change', true);
      assertAlwaysOnTop();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('widget:get-initial-state', () => {
    return {
      state: store.get(),
      quota: quotaBridge.getSnapshot(),
      metrics: agentManager.getAllMetrics(),
      detectedAgents,
      tracker: winTracker.getSnapshot(),
      dshPluginStatus,
    };
  });

  ipcMain.on('widget:set-ignore-mouse', (_e, ignore: boolean, forward = true) => {
    if (!ignore && !mainWindow?.isVisible()) return;
    applyIgnoreMouse(ignore, forward);
  });

  ipcMain.on('widget:set-drag-lock', (_e, locked: boolean) => {
    stockingDragLocked = locked;
    if (locked) applyIgnoreMouse(false);
  });

  ipcMain.on('widget:window-drag-start', () => startWindowDrag());
  ipcMain.on('widget:window-drag-end', () => stopWindowDrag());

  ipcMain.on('widget:set-mode', (_e, mode: WidgetMode) => {
    if (mode !== 'hover' && mode !== 'pinned') return;
    hostHoverActive = false;
    store.update({ mode }, true);
    broadcastState();
  });

  ipcMain.on('widget:set-hover-anchor-mode', (_e, anchorMode: HoverAnchorMode) => {
    if (anchorMode !== 'host' && anchorMode !== 'pill') return;
    hostHoverActive = false;
    store.update({ hoverAnchorMode: anchorMode }, true);
    broadcastState();
  });

  ipcMain.on('widget:set-auto-follow', (_e, enabled: boolean) => {
    store.update({ autoFollowAgent: Boolean(enabled) }, true);
    broadcastState();
  });

  ipcMain.on('widget:set-hide-tray', (_e, hidden: boolean) => {
    store.update({ hideTrayIcon: Boolean(hidden) }, true);
    syncTrayVisibility();
    broadcastState();
  });

  ipcMain.on('widget:set-sentinel-enabled', (_e, enabled: boolean) => {
    const on = Boolean(enabled);
    store.update({ sentinelEnabled: on }, true);
    if (on) {
      enableSentinel(app.getAppPath(), true);
    } else {
      disableSentinel();
    }
    broadcastState();
  });

  ipcMain.on('widget:set-auto-exit', (_e, enabled: boolean) => {
    store.update({ autoExitWhenNoAgents: Boolean(enabled) }, true);
    broadcastState();
  });

  ipcMain.on('widget:install-dsh-plugin', () => {
    dshPluginStatus = ensureDshBridgeInstalled(app.getAppPath(), true);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('widget:dsh-plugin-status', dshPluginStatus);
    }
  });

  ipcMain.on('widget:uninstall-dsh-plugin', () => {
    dshPluginStatus = uninstallDshBridge();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('widget:dsh-plugin-status', dshPluginStatus);
    }
  });

  ipcMain.on('widget:start-calibration', (_e, agent: RealAgentId) => {
    if (agent === 'codex' || agent === 'antigravity' || agent === 'dsh') {
      startHostCalibration(agent);
    }
  });

  ipcMain.on('widget:cancel-calibration', () => cancelHostCalibration());

  ipcMain.on('widget:rescan-agents', () => {
    refreshDetectedAgents(winTracker.getSnapshot().runningAgents);
  });

  ipcMain.on('widget:set-agent', (_e, agent: AgentId) => {
    if (agent === 'codex' || agent === 'antigravity' || agent === 'dsh' || agent === 'simulated') {
      switchActiveAgent(agent);
    }
  });

  ipcMain.on('widget:refresh-agent', (_e, agent?: AgentId) => {
    const target = agent ?? store.get().activeAgent;
    void agentManager.refresh(target, true);
  });

  ipcMain.on('widget:set-quota', (_e, left: number, right: number) => {
    quotaBridge.setQuota(left, right, 'simulated');
  });

  ipcMain.on('widget:set-dsh-free-leg', (_e, pct: number) => {
    if (typeof pct === 'number' && Number.isFinite(pct)) {
      store.update({ dshFreeLegQuota: Math.max(0, Math.min(100, Math.round(pct))) });
      broadcastState();
    }
  });

  ipcMain.on('widget:set-sync-single-legs', (_e, enabled: boolean) => {
    store.update({ syncSingleQuotaBothLegs: Boolean(enabled) }, true);
    broadcastState();
  });

  ipcMain.on('widget:set-visual', (_e, presetId: string, laceCuff?: boolean) => {
    const patch: Partial<PersistedWidgetState> = { presetId };
    if (typeof laceCuff === 'boolean') patch.laceCuff = laceCuff;
    store.update(patch, true);
    broadcastState();
  });

  ipcMain.on('widget:set-size', (_e, size: WidgetSizePreset) => {
    if (size === 'compact' || size === 'medium' || size === 'large') {
      applyWindowSize(size);
    }
  });

  ipcMain.on('widget:set-scale', (_e, scalePct: number) => {
    if (typeof scalePct === 'number' && Number.isFinite(scalePct)) {
      applyScalePct(scalePct);
    }
  });

  ipcMain.on('widget:hide', () => toggleWindowVisibility(false));

  ipcMain.on('widget:quit', () => {
    stopSentinelProcess();
    store.flush();
    app.quit();
  });

  ipcMain.on('widget:open-context-menu', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const menu = Menu.buildFromTemplate(buildContextMenuTemplate());
    menu.popup({ window: mainWindow });
  });
}

function registerSystemWatchers(): void {
  const handleDisplayChange = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const safe = store.resolveSafeBounds();
    store.update({ x: safe.x, y: safe.y });
    mainWindow.setBounds(safe, false);
    assertAlwaysOnTop();
    mainWindow.webContents.send('widget:resume-refresh');
  };

  screen.on('display-metrics-changed', handleDisplayChange);
  screen.on('display-removed', handleDisplayChange);
  screen.on('display-added', handleDisplayChange);

  const handleWake = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const safe = store.resolveSafeBounds();
      mainWindow.setBounds(safe, false);
      if (store.get().visible) {
        mainWindow.showInactive();
        assertAlwaysOnTop();
        agentManager?.startPolling(60_000, false);
      }
      mainWindow.webContents.send('widget:resume-refresh');
    }, 350);
  };

  powerMonitor.on('suspend', () => {
    agentManager?.stopPolling();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('widget:rendering-pause', true);
    }
  });
  powerMonitor.on('resume', handleWake);
  powerMonitor.on('unlock-screen', handleWake);
}

app.on('second-instance', (_event, argv) => {
  const silentReinvoke = argv.includes('--silent');
  const fromAgent = argv.find((a) => a.startsWith('--from-agent='))?.split('=')[1] as RealAgentId | undefined;
  if (fromAgent && (fromAgent === 'codex' || fromAgent === 'antigravity' || fromAgent === 'dsh')) {
    if (store.get().autoFollowAgent) {
      switchActiveAgent(fromAgent);
    }
  }
  if (!silentReinvoke) {
    // Manual double-click on StockingQuota.exe always summons visible UI + settings!
    summonWidgetAndSettings();
  }
});

app.whenReady().then(() => {
  store = new StateStore();
  winTracker = new WinForegroundTracker(app.getAppPath());

  // Initial local Agent detection so uninstalled Agents are automatically hidden
  detectedAgents = detectLocalAgents([]);
  // Zero-friction first-run: if user has DSH installed, auto-install/update zero-BOM bridge plugin silently!
  dshPluginStatus = ensureDshBridgeInstalled(app.getAppPath(), false);

  const init = store.get();
  if (init.sentinelEnabled) {
    enableSentinel(app.getAppPath(), true);
  }

  // If launched with --from-agent=... or persisted agent is not installed on this PC, auto-select an installed Agent
  let initialAgent = init.activeAgent;
  if (cliFromAgentArg && (cliFromAgentArg === 'codex' || cliFromAgentArg === 'antigravity' || cliFromAgentArg === 'dsh')) {
    initialAgent = cliFromAgentArg;
    store.update({
      activeAgent: initialAgent,
      presetId: AGENT_BINDINGS[initialAgent].defaultPresetId,
      laceCuff: false,
      ...(cliSilent ? { mode: 'hover', hoverAnchorMode: 'host' } : {}),
    });
  } else if (initialAgent !== 'simulated') {
    const installed = detectedAgents.filter((a) => a.installed);
    if (installed.length > 0 && !installed.some((a) => a.id === initialAgent)) {
      initialAgent = installed[0].id;
      store.update({
        activeAgent: initialAgent,
        presetId: AGENT_BINDINGS[initialAgent].defaultPresetId,
        laceCuff: false,
      });
    } else if (installed.length === 0) {
      initialAgent = 'simulated';
      store.update({ activeAgent: 'simulated' });
    }
  }

  agentManager = new AgentManager(app.getAppPath(), initialAgent);
  agentManager.setInstalledAgents(detectedAgents.filter((a) => a.installed).map((a) => a.id));
  agentManager.subscribe((_agent, metric) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('widget:agent-metric', metric);
    }
    rebuildTrayMenu();
  });

  quotaBridge = new QuotaBridge(init.leftQuota, init.rightQuota);
  quotaBridge.subscribe((snap) => {
    store.update({ leftQuota: snap.leftQuota, rightQuota: snap.rightQuota });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('widget:quota-update', snap);
    }
    rebuildTrayMenu();
  });
  quotaBridge.startLocalBridge(17821, {
    onDshContextPush: (payload) => {
      if (payload.meterRect && typeof payload.meterRect.viewportW === 'number' && payload.meterRect.viewportW >= 100) {
        lastDshMeterRect = payload.meterRect;
      }
      return agentManager.ingestDshContext(payload);
    },
    onExternalMetricPush: (metric) => agentManager.ingestExternalMetric(metric),
    getAllMetrics: () => agentManager.getAllMetrics(),
  });

  registerIpcHandlers();
  createMainWindow();
  syncTrayVisibility();
  winTracker.subscribe(handleTrackerSnapshot);
  winTracker.onModelMouseDown(handleModelMouseDown);
  winTracker.onCodexMouseDown(handleCodexMouseDown);
  winTracker.start();
  startCursorBoundaryGuard();
  registerSystemWatchers();
  agentManager.startPolling(60_000);

  // Global summon shortcut works even when tray icon is completely hidden!
  globalShortcut.register('CommandOrControl+Alt+S', () => {
    summonWidgetAndSettings();
  });

  // First-run friendly "Install Succeeded!" confirmation dialog (never shown on silent sentinel launches)
  if (!init.firstRunCompleted && !cliSilent) {
    store.update({ firstRunCompleted: true }, true);
    const foundNames = detectedAgents
      .filter((a) => a.installed)
      .map((a) => AGENT_BINDINGS[a.id].displayName);
    const lines: string[] = [
      foundNames.length > 0
        ? `• 已自动检测到本机 Agent：${foundNames.join(' / ')}`
        : '• 暂未检测到本地 Agent（可先使用内置模拟模式体验）',
    ];
    if (dshPluginStatus.dshDetected) {
      lines.push(
        dshPluginStatus.installed
          ? '• 已自动配置 DeepSeek Harness 蓝丝桥接插件（重启一次 DSH 即可实时同步）'
          : `• DSH 插件状态：${dshPluginStatus.message}`
      );
    }
    if (store.get().sentinelEnabled) {
      lines.push('• 已启用 4.6MB 极轻哨兵：以后打开 Codex / Antigravity / DSH 将自动静默激活');
    }
    lines.push('• 默认隐身无托盘图标，把鼠标悬停到各软件的额度/切模型按钮即可弹出丝袜');
    lines.push('• 任何时候按快捷键 Ctrl + Alt + S 即可呼出设置面板或退出程序');

    setTimeout(() => {
      void dialog.showMessageBox({
        type: 'info',
        title: 'StockingQuota 安装成功',
        message: 'StockingQuota 已安装成功并开始运行！',
        detail: lines.join('\n'),
        buttons: ['开始使用'],
      });
    }, 600);
  }
});

app.on('before-quit', () => {
  cancelHostCalibration();
  globalShortcut.unregisterAll();
  stopWindowDrag();
  if (cursorGuardInterval) clearInterval(cursorGuardInterval);
  if (autoExitTimer) clearTimeout(autoExitTimer);
  winTracker?.stop();
  agentManager?.stopPolling();
  quotaBridge?.stop();
  store?.flush();
});

app.on('window-all-closed', () => {
  // Keep running quietly until explicit quit or auto-exit
});
