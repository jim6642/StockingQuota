import { contextBridge, ipcRenderer } from 'electron';
import type { DetectedAgentInfo } from './providers/agentDetector';
import type { DshPluginInstallStatus } from './providers/dshPluginInstaller';
import type { AgentId, AgentMetric } from './providers/types';
import type { QuotaSnapshot } from './quotaBridge';
import type { HoverAnchorMode, PersistedWidgetState, WidgetMode, WidgetSizePreset } from './stateStore';
import type { RealAgentId, WindowTrackerSnapshot } from './windowTracker';

export interface HostHoverPayload {
  active: boolean;
  agent: RealAgentId | null;
  immediate?: boolean;
}

export interface CalibrationStatePayload {
  active: boolean;
  agent: RealAgentId | null;
  hint?: string;
}

export interface DesktopBridgeAPI {
  getInitialState: () => Promise<{
    state: PersistedWidgetState;
    quota: QuotaSnapshot;
    metrics: Record<AgentId, AgentMetric>;
    detectedAgents: DetectedAgentInfo[];
    tracker: WindowTrackerSnapshot;
    dshPluginStatus: DshPluginInstallStatus;
  }>;
  setIgnoreMouseEvents: (ignore: boolean, forward?: boolean) => void;
  setInteractiveDragLock: (locked: boolean) => void;
  startWindowDrag: () => void;
  endWindowDrag: () => void;
  setMode: (mode: WidgetMode) => void;
  setHoverAnchorMode: (anchorMode: HoverAnchorMode) => void;
  setAutoFollowAgent: (enabled: boolean) => void;
  setHideTrayIcon: (hidden: boolean) => void;
  setSentinelEnabled: (enabled: boolean) => void;
  setAutoExitWhenNoAgents: (enabled: boolean) => void;
  installDshPlugin: () => void;
  uninstallDshPlugin: () => void;
  startHostCalibration: (agent: RealAgentId) => void;
  cancelHostCalibration: () => void;
  rescanAgents: () => void;
  setActiveAgent: (agent: AgentId) => void;
  refreshAgent: (agent?: AgentId) => void;
  setSimulatedQuota: (left: number, right: number) => void;
  setDshFreeLegQuota: (pct: number) => void;
  setSyncSingleQuotaBothLegs: (enabled: boolean) => void;
  setVisualPreset: (presetId: string, laceCuff?: boolean) => void;
  setSizePreset: (size: WidgetSizePreset) => void;
  setScalePct: (scalePct: number) => void;
  hideWindow: () => void;
  quitApp: () => void;
  openContextMenu: () => void;
  onStateSync: (cb: (state: PersistedWidgetState) => void) => () => void;
  onQuotaUpdate: (cb: (quota: QuotaSnapshot) => void) => () => void;
  onAgentMetric: (cb: (metric: AgentMetric) => void) => () => void;
  onDetectedAgentsSync: (cb: (agents: DetectedAgentInfo[]) => void) => () => void;
  onHostHoverTrigger: (cb: (payload: HostHoverPayload) => void) => () => void;
  onCalibrationState: (cb: (payload: CalibrationStatePayload) => void) => () => void;
  onSummonSettings: (cb: () => void) => () => void;
  onDshPluginStatus: (cb: (status: DshPluginInstallStatus) => void) => () => void;
  onRenderingPause: (cb: (paused: boolean) => void) => () => void;
  onCursorOutside: (cb: () => void) => () => void;
  onWindowFocusChange: (cb: (focused: boolean) => void) => () => void;
  onResumeRefresh: (cb: () => void) => () => void;
}

const api: DesktopBridgeAPI = {
  getInitialState: () => ipcRenderer.invoke('widget:get-initial-state'),
  setIgnoreMouseEvents: (ignore: boolean, forward = true) => {
    ipcRenderer.send('widget:set-ignore-mouse', ignore, forward);
  },
  setInteractiveDragLock: (locked: boolean) => {
    ipcRenderer.send('widget:set-drag-lock', locked);
  },
  startWindowDrag: () => {
    ipcRenderer.send('widget:window-drag-start');
  },
  endWindowDrag: () => {
    ipcRenderer.send('widget:window-drag-end');
  },
  setMode: (mode: WidgetMode) => {
    ipcRenderer.send('widget:set-mode', mode);
  },
  setHoverAnchorMode: (anchorMode: HoverAnchorMode) => {
    ipcRenderer.send('widget:set-hover-anchor-mode', anchorMode);
  },
  setAutoFollowAgent: (enabled: boolean) => {
    ipcRenderer.send('widget:set-auto-follow', enabled);
  },
  setHideTrayIcon: (hidden: boolean) => {
    ipcRenderer.send('widget:set-hide-tray', hidden);
  },
  setSentinelEnabled: (enabled: boolean) => {
    ipcRenderer.send('widget:set-sentinel-enabled', enabled);
  },
  setAutoExitWhenNoAgents: (enabled: boolean) => {
    ipcRenderer.send('widget:set-auto-exit', enabled);
  },
  installDshPlugin: () => {
    ipcRenderer.send('widget:install-dsh-plugin');
  },
  uninstallDshPlugin: () => {
    ipcRenderer.send('widget:uninstall-dsh-plugin');
  },
  startHostCalibration: (agent: RealAgentId) => {
    ipcRenderer.send('widget:start-calibration', agent);
  },
  cancelHostCalibration: () => {
    ipcRenderer.send('widget:cancel-calibration');
  },
  rescanAgents: () => {
    ipcRenderer.send('widget:rescan-agents');
  },
  setActiveAgent: (agent: AgentId) => {
    ipcRenderer.send('widget:set-agent', agent);
  },
  refreshAgent: (agent?: AgentId) => {
    ipcRenderer.send('widget:refresh-agent', agent);
  },
  setSimulatedQuota: (left: number, right: number) => {
    ipcRenderer.send('widget:set-quota', left, right);
  },
  setDshFreeLegQuota: (pct: number) => {
    ipcRenderer.send('widget:set-dsh-free-leg', pct);
  },
  setSyncSingleQuotaBothLegs: (enabled: boolean) => {
    ipcRenderer.send('widget:set-sync-single-legs', enabled);
  },
  setVisualPreset: (presetId: string, laceCuff?: boolean) => {
    ipcRenderer.send('widget:set-visual', presetId, laceCuff);
  },
  setSizePreset: (size: WidgetSizePreset) => {
    ipcRenderer.send('widget:set-size', size);
  },
  setScalePct: (scalePct: number) => {
    ipcRenderer.send('widget:set-scale', scalePct);
  },
  hideWindow: () => {
    ipcRenderer.send('widget:hide');
  },
  quitApp: () => {
    ipcRenderer.send('widget:quit');
  },
  openContextMenu: () => {
    ipcRenderer.send('widget:open-context-menu');
  },
  onStateSync: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, state: PersistedWidgetState) => cb(state);
    ipcRenderer.on('widget:state-sync', handler);
    return () => ipcRenderer.removeListener('widget:state-sync', handler);
  },
  onQuotaUpdate: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, quota: QuotaSnapshot) => cb(quota);
    ipcRenderer.on('widget:quota-update', handler);
    return () => ipcRenderer.removeListener('widget:quota-update', handler);
  },
  onAgentMetric: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, metric: AgentMetric) => cb(metric);
    ipcRenderer.on('widget:agent-metric', handler);
    return () => ipcRenderer.removeListener('widget:agent-metric', handler);
  },
  onDetectedAgentsSync: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, agents: DetectedAgentInfo[]) => cb(agents);
    ipcRenderer.on('widget:detected-agents', handler);
    return () => ipcRenderer.removeListener('widget:detected-agents', handler);
  },
  onHostHoverTrigger: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: HostHoverPayload) => cb(payload);
    ipcRenderer.on('widget:host-hover-trigger', handler);
    return () => ipcRenderer.removeListener('widget:host-hover-trigger', handler);
  },
  onCalibrationState: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: CalibrationStatePayload) => cb(payload);
    ipcRenderer.on('widget:calibration-state', handler);
    return () => ipcRenderer.removeListener('widget:calibration-state', handler);
  },
  onSummonSettings: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('widget:summon-settings', handler);
    return () => ipcRenderer.removeListener('widget:summon-settings', handler);
  },
  onDshPluginStatus: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, status: DshPluginInstallStatus) => cb(status);
    ipcRenderer.on('widget:dsh-plugin-status', handler);
    return () => ipcRenderer.removeListener('widget:dsh-plugin-status', handler);
  },
  onRenderingPause: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, paused: boolean) => cb(paused);
    ipcRenderer.on('widget:rendering-pause', handler);
    return () => ipcRenderer.removeListener('widget:rendering-pause', handler);
  },
  onCursorOutside: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('widget:cursor-outside', handler);
    return () => ipcRenderer.removeListener('widget:cursor-outside', handler);
  },
  onWindowFocusChange: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, focused: boolean) => cb(focused);
    ipcRenderer.on('widget:focus-change', handler);
    return () => ipcRenderer.removeListener('widget:focus-change', handler);
  },
  onResumeRefresh: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('widget:resume-refresh', handler);
    return () => ipcRenderer.removeListener('widget:resume-refresh', handler);
  },
};

contextBridge.exposeInMainWorld('stockingDesktop', api);
