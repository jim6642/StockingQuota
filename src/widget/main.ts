import './widget.css';
import { StockingQuotaStage, StageHitRegion } from '../engine/StockingQuotaStage';
import { DEFAULT_VISUAL_CONFIG, STOCKING_PRESETS } from '../engine/types';

type WidgetMode = 'hover' | 'pinned';
type HoverAnchorMode = 'host' | 'pill';
type WidgetSizePreset = 'compact' | 'medium' | 'large';
type AgentId = 'codex' | 'antigravity' | 'dsh' | 'simulated';
type RealAgentId = Exclude<AgentId, 'simulated'>;
type MetricStatus = 'ok' | 'stale' | 'unavailable';
const UNAVAILABLE_LEG_HEIGHT = 55;

interface DetectedAgentInfo {
  id: RealAgentId;
  installed: boolean;
  running: boolean;
  reason: string;
}

interface AgentMetricWindow {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  usedTokens?: number;
  capacityTokens?: number;
  resetAt?: string;
  resetDescription?: string;
  group?: string;
  isFreePlay?: boolean;
}

interface AgentMetric {
  agent: AgentId;
  status: MetricStatus;
  updatedAt?: string;
  source?: string;
  planOrModel?: string;
  message?: string;
  windows: AgentMetricWindow[];
}

interface DshPluginInstallStatus {
  dshDetected: boolean;
  installed: boolean;
  justInstalled: boolean;
  needsDshRestart: boolean;
  version?: string;
  message: string;
}

interface PersistedWidgetState {
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
  scalePct: number;
  activeAgent: AgentId;
  leftQuota: number;
  rightQuota: number;
  dshFreeLegQuota: number;
  presetId: string;
  laceCuff: boolean;
}

interface QuotaSnapshot {
  leftQuota: number;
  rightQuota: number;
  source: 'simulated' | 'external';
  leftLabel: string;
  rightLabel: string;
  updatedAt: number;
}

interface DesktopBridgeAPI {
  getInitialState: () => Promise<{
    state: PersistedWidgetState;
    quota: QuotaSnapshot;
    metrics: Record<AgentId, AgentMetric>;
    detectedAgents: DetectedAgentInfo[];
    dshPluginStatus?: DshPluginInstallStatus;
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
  onHostHoverTrigger: (cb: (payload: { active: boolean; agent: RealAgentId | null; immediate?: boolean }) => void) => () => void;
  onCalibrationState: (cb: (payload: { active: boolean; agent: RealAgentId | null; hint?: string }) => void) => () => void;
  onSummonSettings: (cb: () => void) => () => void;
  onDshPluginStatus: (cb: (status: DshPluginInstallStatus) => void) => () => void;
  onRenderingPause: (cb: (paused: boolean) => void) => () => void;
  onCursorOutside: (cb: () => void) => () => void;
  onWindowFocusChange: (cb: (focused: boolean) => void) => () => void;
  onResumeRefresh: (cb: () => void) => () => void;
}

declare global {
  interface Window {
    stockingDesktop?: DesktopBridgeAPI;
    __widgetStage?: StockingQuotaStage;
  }
}

const AGENT_META: Record<
  AgentId,
  { short: string; sub: string; accent: string; presetId: string; ringLeft: string; ringRight: string }
> = {
  codex: {
    short: 'Codex',
    sub: '白丝',
    accent: '#f1ecf8',
    presetId: 'codex-white',
    ringLeft: '#f5f2ff',
    ringRight: '#cbd5e1',
  },
  antigravity: {
    short: 'AGY',
    sub: '紫丝',
    accent: '#c4b5fd',
    presetId: 'antigravity-purple',
    ringLeft: '#c4b5fd',
    ringRight: '#f0abfc',
  },
  dsh: {
    short: 'DSH',
    sub: '蓝丝',
    accent: '#7dd3fc',
    presetId: 'dsh-blue',
    ringLeft: '#7dd3fc',
    ringRight: '#93c5fd',
  },
  simulated: {
    short: '模拟',
    sub: '滑块',
    accent: '#f472b6',
    presetId: 'antigravity-purple',
    ringLeft: '#c4b5fd',
    ringRight: '#f9a8d4',
  },
};

function formatTimeShort(iso?: string): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTokensCompact(tokens?: number): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return '--';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

function defaultPreviewMetrics(): Record<AgentId, AgentMetric> {
  const now = new Date().toISOString();
  return {
    codex: {
      agent: 'codex',
      status: 'ok',
      updatedAt: now,
      source: 'preview',
      planOrModel: 'ChatGPT Plus',
      windows: [
        { id: 'session_5h', label: '5H 会话', usedPercent: 0, remainingPercent: 100 },
        { id: 'weekly', label: '周额度', usedPercent: 28, remainingPercent: 72 },
      ],
    },
    antigravity: {
      agent: 'antigravity',
      status: 'unavailable',
      updatedAt: now,
      source: 'preview',
      message: '未检测到 agy >= 1.1.11 或在线 LSP 通道',
      windows: [],
    },
    dsh: {
      agent: 'dsh',
      status: 'ok',
      updatedAt: now,
      source: 'preview',
      planOrModel: 'DeepSeek-V4.1-Flash',
      windows: [
        {
          id: 'context_remaining',
          label: '上下文剩余',
          usedPercent: 2,
          remainingPercent: 98,
          usedTokens: 2560,
          capacityTokens: 128000,
        },
        { id: 'free_play', label: '自由互动腿', isFreePlay: true },
      ],
    },
    simulated: {
      agent: 'simulated',
      status: 'ok',
      updatedAt: now,
      source: 'simulated',
      windows: [],
    },
  };
}

function defaultPreviewDetected(): DetectedAgentInfo[] {
  return [
    { id: 'codex', installed: true, running: true, reason: '运行中' },
    { id: 'dsh', installed: true, running: true, reason: '运行中' },
    { id: 'antigravity', installed: false, running: false, reason: '未检测到安装' },
  ];
}

class DesktopWidgetApp {
  private readonly desktop = window.stockingDesktop;
  private stage!: StockingQuotaStage;

  private mode: WidgetMode = 'pinned';
  private hoverAnchorMode: HoverAnchorMode = 'host';
  private autoFollowAgent = true;
  private hideTrayIcon = true;
  private sentinelEnabled = true;
  private autoExitWhenNoAgents = false;
  private dshPluginStatus: DshPluginInstallStatus | null = null;

  private hoverExpanded = false;
  private hostHotspotActive = false;
  private collapseTimer: number | null = null;
  private pauseRenderTimer: number | null = null;
  private simOpen = false;
  private showAllAgents = false;
  private isWindowDragging = false;
  private lastIgnoreMouse: boolean | null = null;

  private activeAgent: AgentId = 'codex';
  private detectedAgents: DetectedAgentInfo[] = defaultPreviewDetected();
  private metrics: Record<AgentId, AgentMetric> = defaultPreviewMetrics();
  private currentPresetId = 'codex-white';
  private currentLaceCuff = false;
  private currentScalePct = 100;

  private simLeftQuota = 82;
  private simRightQuota = 58;
  private dshFreeLegQuota = 62;

  private displayedLeftQuota = UNAVAILABLE_LEG_HEIGHT;
  private displayedRightQuota = UNAVAILABLE_LEG_HEIGHT;
  private pointerInsideInteractive = false;
  private hostPopupAgent: RealAgentId | null = null;

  private stageWrapEl!: HTMLElement;
  private skirtHintEl!: HTMLElement;
  private calibBannerEl!: HTMLElement;
  private calibHintEl!: HTMLElement;
  private triggerPillEl!: HTMLElement;
  private triggerNumsEl!: HTMLElement;
  private triggerRingLeftEl!: SVGCircleElement;
  private triggerRingRightEl!: SVGCircleElement;
  private pinnedBarEl!: HTMLElement;
  private pinnedStatusDotEl!: HTMLElement;
  private pinnedReadoutEl!: HTMLElement;
  private btnQuickRefreshEl!: HTMLButtonElement;
  private btnModeToggleEl!: HTMLButtonElement;

  private simPopoverEl!: HTMLElement;
  private detectedSummaryEl!: HTMLElement;
  private btnShowAllAgentsEl!: HTMLButtonElement;
  private agentTabsEl!: HTMLElement;
  private metricDotEl!: HTMLElement;
  private metricStatusLabelEl!: HTMLElement;
  private metricModelTagEl!: HTMLElement;
  private metricUpdatedEl!: HTMLElement;
  private metricRefreshBtn!: HTMLButtonElement;
  private metricWindowsEl!: HTMLElement;
  private metricMsgEl!: HTMLElement;

  private btnAnchorHostEl!: HTMLButtonElement;
  private btnAnchorPillEl!: HTMLButtonElement;
  private btnCalibrateEl!: HTMLButtonElement;
  private chkAutoFollowEl!: HTMLInputElement;
  private chkHideTrayEl!: HTMLInputElement;
  private chkSentinelEl!: HTMLInputElement;
  private chkAutoExitEl!: HTMLInputElement;
  private dshPluginRowEl!: HTMLElement;
  private dshPluginTextEl!: HTMLElement;
  private btnDshPluginActionEl!: HTMLButtonElement;

  private simSlidersWrapEl!: HTMLElement;
  private dshFreeWrapEl!: HTMLElement;
  private simLeftSlider!: HTMLInputElement;
  private simRightSlider!: HTMLInputElement;
  private dshFreeSlider!: HTMLInputElement;
  private simScaleSlider!: HTMLInputElement;
  private simLeftVal!: HTMLElement;
  private simRightVal!: HTMLElement;
  private dshFreeVal!: HTMLElement;
  private simScaleVal!: HTMLElement;
  private simLaceChk!: HTMLInputElement;

  public async mount(root: HTMLElement): Promise<void> {
    root.innerHTML = `
      <div class="stocking-stage-wrap" id="stage-wrap">
        <div class="skirt-drag-hint" id="skirt-hint">按住裙摆拖动位置 · 拖拽袜口互动</div>
        <div class="canvas-host" id="canvas-host"></div>
      </div>

      <div class="calib-banner hidden" id="calib-banner">
        <span id="calib-hint">请把鼠标停在额度图标上按空格锁定</span>
        <button class="calib-cancel-btn" id="calib-cancel">取消</button>
      </div>

      <div class="sim-popover" id="sim-popover">
        <div class="sim-header">
          <span>StockingQuota 设置 (V1.0)</span>
          <button class="sim-close" id="sim-close" title="关闭">✕</button>
        </div>
        <div class="sim-header-sub">
          <span id="detected-summary">自动检测本机 Agent…</span>
          <button class="link-btn" id="btn-show-all">显示全部</button>
        </div>

        <div class="agent-tabs" id="agent-tabs"></div>

        <div class="metric-card" id="metric-card">
          <div class="metric-status-row">
            <span class="metric-status-left">
              <span class="status-dot" id="metric-dot"></span>
              <span class="metric-status-label" id="metric-status-label">初始化中</span>
              <span class="metric-model-tag hidden" id="metric-model-tag"></span>
            </span>
            <span class="metric-status-right">
              <span class="metric-updated" id="metric-updated">--:--</span>
              <button class="metric-refresh-btn" id="metric-refresh" title="立即刷新当前额度">↻</button>
            </span>
          </div>
          <div class="metric-windows" id="metric-windows"></div>
          <div class="metric-msg hidden" id="metric-msg"></div>
        </div>

        <div class="anchor-box">
          <div class="seg-row">
            <button class="seg-btn" id="btn-anchor-host" title="平时彻底隐藏，悬停在原软件额度图标上弹出">贴靠原软件图标</button>
            <button class="seg-btn" id="btn-anchor-pill" title="显示一个独立迷你小药丸">独立悬浮药丸</button>
          </div>
          <button class="calib-btn" id="btn-calibrate">🎯 标定当前软件的额度图标位置</button>
        </div>

        <div id="sim-sliders-wrap" class="hidden" style="display:flex;flex-direction:column;gap:6px;">
          <div class="sim-slider-row">
            <div class="sim-slider-label"><span>左腿（模拟短周期）</span><strong id="sim-left-val">82%</strong></div>
            <input type="range" id="sim-left" min="0" max="100" step="1" value="82" />
          </div>
          <div class="sim-slider-row">
            <div class="sim-slider-label"><span>右腿（模拟周额度）</span><strong id="sim-right-val">58%</strong></div>
            <input type="range" id="sim-right" min="0" max="100" step="1" value="58" />
          </div>
        </div>

        <div id="dsh-free-wrap" class="hidden">
          <div class="sim-slider-row">
            <div class="sim-slider-label"><span>右腿（自由互动高度）</span><strong id="dsh-free-val">62%</strong></div>
            <input type="range" id="dsh-free" min="0" max="100" step="1" value="62" />
          </div>
        </div>

        <div class="sim-slider-row">
          <div class="sim-slider-label"><span>整体大小缩放</span><strong id="sim-scale-val">100%</strong></div>
          <input type="range" id="sim-scale" min="65" max="150" step="1" value="100" />
        </div>

        <div class="sim-presets" id="sim-presets"></div>

        <div class="sim-toggle-group">
          <div class="sim-lace-row hidden" id="dsh-plugin-row" style="cursor:default;font-size:10px;color:#bae6fd;">
            <span id="dsh-plugin-text">DSH 插件已自动就绪</span>
            <button class="link-btn" id="btn-dsh-plugin-action">修复</button>
          </div>
          <label class="sim-lace-row">
            <span>随 Agent 自动唤醒（3MB 极轻哨兵）</span>
            <input type="checkbox" id="chk-sentinel" style="accent-color:#a78bfa;cursor:pointer;" />
          </label>
          <label class="sim-lace-row">
            <span>自动跟随前台软件切换丝袜</span>
            <input type="checkbox" id="chk-auto-follow" style="accent-color:#a78bfa;cursor:pointer;" />
          </label>
          <label class="sim-lace-row">
            <span>隐藏系统托盘图标（隐身模式）</span>
            <input type="checkbox" id="chk-hide-tray" style="accent-color:#a78bfa;cursor:pointer;" />
          </label>
          <label class="sim-lace-row">
            <span>所有 Agent 关闭后自动退出</span>
            <input type="checkbox" id="chk-auto-exit" style="accent-color:#a78bfa;cursor:pointer;" />
          </label>
          <label class="sim-lace-row">
            <span>复古蕾丝花边袜口</span>
            <input type="checkbox" id="sim-lace" style="accent-color:#a78bfa;cursor:pointer;" />
          </label>
        </div>

        <div class="sim-footer-row">
          <span>快捷键 Ctrl+Alt+S 随时呼出</span>
          <button class="quit-btn" id="btn-quit">退出程序</button>
        </div>
      </div>

      <div class="dock-bar-wrap">
        <div class="quota-trigger-pill hidden" id="trigger-pill" title="悬停展开 · 点击常驻 · 拖动移动位置">
          <svg class="ring-svg" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9.5" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2.4" />
            <circle id="ring-left" cx="12" cy="12" r="9.5" fill="none" stroke="#f5f2ff" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="59.69" stroke-dashoffset="10" />
            <circle id="ring-right" cx="12" cy="12" r="5.6" fill="none" stroke="#cbd5e1" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="35.18" stroke-dashoffset="14" />
          </svg>
          <span class="pill-nums" id="trigger-nums">Codex -- · --</span>
          <span class="pill-pin-tag" id="trigger-tag">用量</span>
        </div>

        <div class="pinned-toolbar hidden" id="pinned-toolbar">
          <button class="tool-chip move-chip" id="btn-move" title="按住拖动桌面位置">✥</button>
          <span class="tool-quota-readout">
            <span class="status-dot" id="pinned-dot"></span>
            <span id="pinned-readout">Codex -- · --</span>
          </span>
          <button class="tool-chip" id="btn-quick-refresh" title="刷新当前 Agent 数据">↻</button>
          <button class="tool-chip" id="btn-sim" title="Agent 数据源、热区与隐身设置">🎛</button>
          <button class="tool-chip" id="btn-to-hover" title="切换悬停弹出 / 桌面常驻">📌 悬停</button>
          <button class="tool-chip" id="btn-hide" title="隐藏（按 Ctrl+Alt+S 重新呼出）">✕</button>
        </div>
      </div>
    `;

    this.stageWrapEl = root.querySelector('#stage-wrap')!;
    this.skirtHintEl = root.querySelector('#skirt-hint')!;
    this.calibBannerEl = root.querySelector('#calib-banner')!;
    this.calibHintEl = root.querySelector('#calib-hint')!;
    this.triggerPillEl = root.querySelector('#trigger-pill')!;
    this.triggerNumsEl = root.querySelector('#trigger-nums')!;
    this.triggerRingLeftEl = root.querySelector('#ring-left')!;
    this.triggerRingRightEl = root.querySelector('#ring-right')!;
    this.pinnedBarEl = root.querySelector('#pinned-toolbar')!;
    this.pinnedStatusDotEl = root.querySelector('#pinned-dot')!;
    this.pinnedReadoutEl = root.querySelector('#pinned-readout')!;
    this.btnQuickRefreshEl = root.querySelector('#btn-quick-refresh')!;
    this.btnModeToggleEl = root.querySelector('#btn-to-hover')!;

    this.simPopoverEl = root.querySelector('#sim-popover')!;
    this.detectedSummaryEl = root.querySelector('#detected-summary')!;
    this.btnShowAllAgentsEl = root.querySelector('#btn-show-all')!;
    this.agentTabsEl = root.querySelector('#agent-tabs')!;
    this.metricDotEl = root.querySelector('#metric-dot')!;
    this.metricStatusLabelEl = root.querySelector('#metric-status-label')!;
    this.metricModelTagEl = root.querySelector('#metric-model-tag')!;
    this.metricUpdatedEl = root.querySelector('#metric-updated')!;
    this.metricRefreshBtn = root.querySelector('#metric-refresh')!;
    this.metricWindowsEl = root.querySelector('#metric-windows')!;
    this.metricMsgEl = root.querySelector('#metric-msg')!;

    this.btnAnchorHostEl = root.querySelector('#btn-anchor-host')!;
    this.btnAnchorPillEl = root.querySelector('#btn-anchor-pill')!;
    this.btnCalibrateEl = root.querySelector('#btn-calibrate')!;
    this.chkAutoFollowEl = root.querySelector('#chk-auto-follow')!;
    this.chkHideTrayEl = root.querySelector('#chk-hide-tray')!;
    this.chkSentinelEl = root.querySelector('#chk-sentinel')!;
    this.chkAutoExitEl = root.querySelector('#chk-auto-exit')!;
    this.dshPluginRowEl = root.querySelector('#dsh-plugin-row')!;
    this.dshPluginTextEl = root.querySelector('#dsh-plugin-text')!;
    this.btnDshPluginActionEl = root.querySelector('#btn-dsh-plugin-action')!;

    this.simSlidersWrapEl = root.querySelector('#sim-sliders-wrap')!;
    this.dshFreeWrapEl = root.querySelector('#dsh-free-wrap')!;
    this.simLeftSlider = root.querySelector('#sim-left')!;
    this.simRightSlider = root.querySelector('#sim-right')!;
    this.dshFreeSlider = root.querySelector('#dsh-free')!;
    this.simScaleSlider = root.querySelector('#sim-scale')!;
    this.simLeftVal = root.querySelector('#sim-left-val')!;
    this.simRightVal = root.querySelector('#sim-right-val')!;
    this.dshFreeVal = root.querySelector('#dsh-free-val')!;
    this.simScaleVal = root.querySelector('#sim-scale-val')!;
    this.simLaceChk = root.querySelector('#sim-lace')!;

    if (this.desktop) {
      const init = await this.desktop.getInitialState();
      this.mode = init.state.mode;
      this.hoverAnchorMode = init.state.hoverAnchorMode ?? 'host';
      this.autoFollowAgent = init.state.autoFollowAgent ?? true;
      this.hideTrayIcon = init.state.hideTrayIcon ?? true;
      this.sentinelEnabled = init.state.sentinelEnabled ?? true;
      this.autoExitWhenNoAgents = init.state.autoExitWhenNoAgents ?? false;
      this.dshPluginStatus = init.dshPluginStatus ?? null;
      this.activeAgent = init.state.activeAgent ?? 'codex';
      this.simLeftQuota = init.quota.leftQuota;
      this.simRightQuota = init.quota.rightQuota;
      this.dshFreeLegQuota = init.state.dshFreeLegQuota ?? 62;
      this.currentPresetId = init.state.presetId;
      this.currentLaceCuff = init.state.laceCuff;
      this.currentScalePct = init.state.scalePct ?? 100;
      if (init.metrics) this.metrics = { ...this.metrics, ...init.metrics };
      if (Array.isArray(init.detectedAgents)) this.detectedAgents = init.detectedAgents;
    }

    const initialLegHeights = this.computeTargetLegHeights();
    this.displayedLeftQuota = initialLegHeights.left;
    this.displayedRightQuota = initialLegHeights.right;

    const canvasHost = root.querySelector('#canvas-host') as HTMLElement;
    this.stage = new StockingQuotaStage({
      container: canvasHost,
      initialLeftQuota: this.displayedLeftQuota,
      initialRightQuota: this.displayedRightQuota,
      anchorBottom: true,
      initialDisplayScale: this.currentScalePct / 150,
      onInteractionStart: () => {
        this.clearCollapseTimer();
        this.desktop?.setInteractiveDragLock(true);
      },
      onInteractionEnd: () => {
        this.desktop?.setInteractiveDragLock(false);
        if (this.mode === 'hover' && !this.pointerInsideInteractive && !this.hostHotspotActive) {
          this.scheduleHoverCollapse();
        }
      },
      getRegionCursor: (region: StageHitRegion) => {
        if (region === 'skirt') return 'move';
        return null;
      },
    });

    await this.stage.init();
    window.__widgetStage = this.stage;

    this.applyPresetVisual(this.currentPresetId, this.currentLaceCuff);
    this.updateScaleUI(this.currentScalePct);
    this.buildSimPresets();
    this.buildDynamicAgentTabs();
    this.syncSlidersUI();
    this.syncSettingsTogglesUI();
    this.renderActiveAgentUI();
    this.bindUIEvents();
    this.bindHitTestingAndDrag();
    this.bindDesktopIpc();
    this.renderModeState();
  }

  /**
   * Dynamically renders ONLY Agents detected on this user's machine (plus Simulated),
   * with an optional "显示全部" toggle if they want to inspect uninstalled ones.
   */
  private buildDynamicAgentTabs(): void {
    const installedCount = this.detectedAgents.filter((a) => a.installed).length;
    const runningCount = this.detectedAgents.filter((a) => a.running).length;
    this.detectedSummaryEl.textContent =
      installedCount > 0
        ? `已检测到 ${installedCount} 个 Agent${runningCount > 0 ? `（${runningCount} 个运行中）` : ''}`
        : '未检测到本地 Agent（已启用模拟模式）';

    const hasHiddenUninstalled = this.detectedAgents.some((a) => !a.installed);
    this.btnShowAllAgentsEl.classList.toggle('hidden', !hasHiddenUninstalled);
    this.btnShowAllAgentsEl.textContent = this.showAllAgents ? '仅看已安装' : '显示全部';

    const visibleIds: AgentId[] = [];
    for (const info of this.detectedAgents) {
      if (this.showAllAgents || info.installed || info.id === this.activeAgent) {
        visibleIds.push(info.id);
      }
    }
    visibleIds.push('simulated');

    this.agentTabsEl.innerHTML = '';
    for (const id of visibleIds) {
      const meta = AGENT_META[id];
      const info = this.detectedAgents.find((a) => a.id === id);
      const btn = document.createElement('button');
      btn.className = `agent-tab${id === this.activeAgent ? ' active' : ''}`;
      btn.dataset.agent = id;
      btn.style.setProperty('--agent-accent', meta.accent);
      btn.title = info ? `${meta.short}（${info.reason}）` : '离线模拟调试滑块';

      const mainSpan = document.createElement('span');
      mainSpan.textContent = meta.short;
      const subSpan = document.createElement('span');
      subSpan.className = 'tab-sub';
      subSpan.textContent = meta.sub;
      btn.appendChild(mainSpan);
      btn.appendChild(subSpan);

      if (info?.running) {
        const pip = document.createElement('span');
        pip.className = 'live-pip';
        btn.appendChild(pip);
      }

      btn.addEventListener('click', () => {
        this.setActiveAgentLocal(id, true);
      });
      this.agentTabsEl.appendChild(btn);
    }
  }

  private syncSettingsTogglesUI(): void {
    this.btnAnchorHostEl.classList.toggle('active', this.hoverAnchorMode === 'host');
    this.btnAnchorPillEl.classList.toggle('active', this.hoverAnchorMode === 'pill');
    this.chkAutoFollowEl.checked = this.autoFollowAgent;
    this.chkHideTrayEl.checked = this.hideTrayIcon;
    this.chkSentinelEl.checked = this.sentinelEnabled;
    this.chkAutoExitEl.checked = this.autoExitWhenNoAgents;

    if (this.dshPluginStatus?.dshDetected) {
      this.dshPluginRowEl.classList.remove('hidden');
      this.dshPluginTextEl.textContent = this.dshPluginStatus.message;
      this.btnDshPluginActionEl.textContent = this.dshPluginStatus.installed ? '卸载' : '安装';
    } else {
      this.dshPluginRowEl.classList.add('hidden');
    }

    const isReal = this.activeAgent !== 'simulated';
    this.btnCalibrateEl.classList.toggle('hidden', !isReal);
    if (isReal) {
      const control = this.activeAgent === 'antigravity' ? '切换模型按钮' : '额度图标';
      this.btnCalibrateEl.textContent = `🎯 标定 ${AGENT_META[this.activeAgent].short} 的${control}位置`;
    }
  }

  private computeTargetLegHeights(): { left: number; right: number } {
    if (this.activeAgent === 'simulated') {
      return { left: this.simLeftQuota, right: this.simRightQuota };
    }

    const metric = this.metrics[this.activeAgent];
    if (!metric || metric.status === 'unavailable') {
      if (this.activeAgent === 'antigravity') {
        return { left: UNAVAILABLE_LEG_HEIGHT, right: UNAVAILABLE_LEG_HEIGHT };
      }
      if (this.activeAgent === 'dsh') {
        return { left: this.displayedLeftQuota, right: this.dshFreeLegQuota };
      }
      return { left: this.displayedLeftQuota, right: this.displayedRightQuota };
    }

    if (this.activeAgent === 'dsh') {
      const ctxWin = metric.windows[0];
      const left =
        typeof ctxWin?.remainingPercent === 'number' && Number.isFinite(ctxWin.remainingPercent)
          ? Math.max(0, Math.min(100, ctxWin.remainingPercent))
          : this.displayedLeftQuota;
      return { left, right: this.dshFreeLegQuota };
    }

    const w0 = this.activeAgent === 'antigravity' ? metric.windows.find(w => w.id === '5h') : metric.windows[0];
    const w1 = this.activeAgent === 'antigravity' ? metric.windows.find(w => w.id === 'weekly') : metric.windows[1];
    const left =
      typeof w0?.remainingPercent === 'number' && Number.isFinite(w0.remainingPercent)
        ? Math.max(0, Math.min(100, w0.remainingPercent))
        : this.displayedLeftQuota;
    const right =
      typeof w1?.remainingPercent === 'number' && Number.isFinite(w1.remainingPercent)
        ? Math.max(0, Math.min(100, w1.remainingPercent))
        : this.displayedRightQuota;
    return { left, right };
  }

  private renderActiveAgentUI(): void {
    const meta = AGENT_META[this.activeAgent];
    const metric = this.metrics[this.activeAgent];

    document.querySelectorAll<HTMLButtonElement>('.agent-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.agent === this.activeAgent);
    });

    this.simSlidersWrapEl.classList.toggle('hidden', this.activeAgent !== 'simulated');
    this.dshFreeWrapEl.classList.toggle('hidden', this.activeAgent !== 'dsh');
    const canManualRefresh = this.activeAgent === 'codex' || this.activeAgent === 'antigravity';
    this.metricRefreshBtn.classList.toggle('hidden', !canManualRefresh);
    this.btnQuickRefreshEl.classList.toggle('hidden', !canManualRefresh);
    this.syncSettingsTogglesUI();

    const targets = this.computeTargetLegHeights();
    this.displayedLeftQuota = targets.left;
    this.displayedRightQuota = targets.right;
    this.stage?.setQuota('left', this.displayedLeftQuota);
    this.stage?.setQuota('right', this.displayedRightQuota);

    const status: MetricStatus = this.activeAgent === 'simulated' ? 'ok' : metric?.status ?? 'unavailable';
    const statusText =
      this.activeAgent === 'simulated'
        ? '手动模拟'
        : status === 'ok'
          ? '实时同步'
          : status === 'stale'
            ? '缓存数据'
            : '暂不可用';

    this.metricDotEl.className = `status-dot ${status}`;
    this.pinnedStatusDotEl.className = `status-dot ${status}`;
    this.metricStatusLabelEl.textContent = statusText;
    this.metricUpdatedEl.textContent =
      this.activeAgent === 'simulated' ? '本地' : formatTimeShort(metric?.updatedAt);

    const groupTag = metric?.windows.find((w) => w.group)?.group;
    const tagText = groupTag || metric?.planOrModel || '';
    if (this.activeAgent !== 'simulated' && tagText) {
      this.metricModelTagEl.textContent = tagText;
      this.metricModelTagEl.title = tagText;
      this.metricModelTagEl.classList.remove('hidden');
    } else {
      this.metricModelTagEl.classList.add('hidden');
    }

    this.metricWindowsEl.innerHTML = '';
    if (this.activeAgent === 'simulated') {
      this.appendWindowRow('左腿（模拟短周期）', `${Math.round(this.simLeftQuota)}%`);
      this.appendWindowRow('右腿（模拟周额度）', `${Math.round(this.simRightQuota)}%`);
    } else if (metric && metric.windows.length > 0 && status !== 'unavailable') {
      for (const w of metric.windows) {
        if (w.isFreePlay) {
          this.appendWindowRow(w.label, `自由互动 (${Math.round(this.dshFreeLegQuota)}%)`);
        } else if (typeof w.remainingPercent === 'number') {
          const pctStr = `剩 ${Math.round(w.remainingPercent)}%`;
          let sub = '';
          if (typeof w.usedTokens === 'number' && typeof w.capacityTokens === 'number') {
            sub = `已用 ${Math.round(w.usedPercent ?? 100 - w.remainingPercent)}% · ${formatTokensCompact(w.usedTokens)}/${formatTokensCompact(w.capacityTokens)}`;
          } else if (w.resetDescription) {
            sub = w.resetDescription;
          }
          this.appendWindowRow(w.label, pctStr, sub);
        }
      }
    }

    const msg = this.activeAgent === 'simulated' ? '' : metric?.message ?? '';
    if (msg && (status !== 'ok' || this.metricWindowsEl.childElementCount === 0)) {
      this.metricMsgEl.textContent = msg;
      this.metricMsgEl.classList.remove('hidden');
    } else {
      this.metricMsgEl.classList.add('hidden');
    }

    this.triggerRingLeftEl.setAttribute('stroke', meta.ringLeft);
    this.triggerRingRightEl.setAttribute('stroke', meta.ringRight);
    const cOuter = 59.69;
    const cInner = 35.18;

    let readoutText = '';
    let outerRingPct = this.displayedLeftQuota;
    let innerRingPct = this.displayedRightQuota;

    if (this.activeAgent === 'simulated') {
      readoutText = `模拟 ${Math.round(this.simLeftQuota)}% · ${Math.round(this.simRightQuota)}%`;
    } else if (status === 'unavailable') {
      readoutText = `${meta.short} · 暂不可用`;
      outerRingPct = 0;
      innerRingPct = 0;
    } else if (this.activeAgent === 'dsh') {
      const rem = metric.windows[0]?.remainingPercent;
      readoutText = `DSH ${rem !== undefined ? `${Math.round(rem)}%` : '--'} · 互动`;
      outerRingPct = rem ?? 0;
      innerRingPct = this.dshFreeLegQuota;
    } else {
      const l = metric.windows[0]?.remainingPercent;
      const r = metric.windows[1]?.remainingPercent;
      const lStr = l !== undefined ? `${Math.round(l)}%` : '--';
      const rStr = r !== undefined ? `${Math.round(r)}%` : '--';
      readoutText = `${meta.short} ${lStr} · ${rStr}`;
      outerRingPct = l ?? 0;
      innerRingPct = r ?? 0;
    }

    this.triggerNumsEl.textContent = readoutText;
    this.pinnedReadoutEl.textContent = readoutText;
    this.triggerRingLeftEl.style.strokeDashoffset = String(cOuter * (1 - Math.max(0, Math.min(100, outerRingPct)) / 100));
    this.triggerRingRightEl.style.strokeDashoffset = String(cInner * (1 - Math.max(0, Math.min(100, innerRingPct)) / 100));
  }

  private appendWindowRow(label: string, val: string, sub?: string): void {
    const row = document.createElement('div');
    row.className = 'metric-win-item';
    const left = document.createElement('span');
    left.textContent = label;
    const right = document.createElement('span');
    right.className = 'metric-win-val';
    right.textContent = val;
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'metric-win-sub';
      subEl.textContent = ` (${sub})`;
      right.appendChild(subEl);
    }
    row.appendChild(left);
    row.appendChild(right);
    this.metricWindowsEl.appendChild(row);
  }

  private syncSlidersUI(): void {
    this.simLeftSlider.value = String(Math.round(this.simLeftQuota));
    this.simRightSlider.value = String(Math.round(this.simRightQuota));
    this.simLeftVal.textContent = `${Math.round(this.simLeftQuota)}%`;
    this.simRightVal.textContent = `${Math.round(this.simRightQuota)}%`;
    this.dshFreeSlider.value = String(Math.round(this.dshFreeLegQuota));
    this.dshFreeVal.textContent = `${Math.round(this.dshFreeLegQuota)}%`;
  }

  private buildSimPresets(): void {
    const grid = document.getElementById('sim-presets')!;
    grid.innerHTML = '';
    for (const p of STOCKING_PRESETS) {
      const btn = document.createElement('button');
      btn.className = `sim-preset-btn${p.id === this.currentPresetId ? ' active' : ''}`;
      btn.dataset.presetId = p.id;
      btn.textContent = p.name.split(' ')[0];
      btn.addEventListener('click', () => {
        const lace = p.visual.laceCuff ?? false;
        this.applyPresetVisual(p.id, lace);
        this.desktop?.setVisualPreset(p.id, lace);
      });
      grid.appendChild(btn);
    }
  }

  private applyPresetVisual(presetId: string, laceCuff: boolean): void {
    this.currentPresetId = presetId;
    this.currentLaceCuff = laceCuff;
    const found = STOCKING_PRESETS.find((p) => p.id === presetId);
    const merged = { ...DEFAULT_VISUAL_CONFIG, ...(found?.visual ?? {}), laceCuff };
    this.stage.setVisualConfig(merged);

    this.simLaceChk.checked = laceCuff;
    document.querySelectorAll<HTMLButtonElement>('.sim-preset-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.presetId === presetId);
    });
  }

  private setActiveAgentLocal(agent: AgentId, syncToMain: boolean): void {
    this.activeAgent = agent;
    if (syncToMain) {
      this.applyPresetVisual(AGENT_META[agent].presetId, false);
      this.desktop?.setActiveAgent(agent);
    }
    this.renderActiveAgentUI();
  }

  private setModeLocal(nextMode: WidgetMode, syncToMain: boolean): void {
    this.mode = nextMode;
    this.clearCollapseTimer();
    if (nextMode === 'pinned') {
      this.hoverExpanded = true;
    } else {
      this.hoverExpanded = false;
      this.hostHotspotActive = false;
      this.setSimOpen(false);
    }
    this.renderModeState();
    if (syncToMain) {
      this.desktop?.setMode(nextMode);
    }
  }

  private renderModeState(): void {
    const isHover = this.mode === 'hover';
    const isHostAnchor = isHover && this.hoverAnchorMode === 'host';
    const showStage = !isHover || this.hoverExpanded || this.simOpen;
    if (showStage) this.stageWrapEl.classList.remove('instant-collapse');

    // In Host-Icon Anchor mode, hide the floating pill completely!
    // Show compact action toolbar only when expanded (or in pinned mode) so user can pin/open settings easily.
    this.triggerPillEl.classList.toggle('hidden', !isHover || isHostAnchor);
    this.pinnedBarEl.classList.toggle('hidden', isHover && (!isHostAnchor || !showStage));
    this.stageWrapEl.classList.toggle('collapsed', !showStage);

    this.btnModeToggleEl.textContent = isHover ? '📌 常驻' : '📌 悬停';
    this.btnModeToggleEl.title = isHover ? '固定为桌面常驻挂件' : '切换为悬停弹出模式';

    const tagEl = document.getElementById('trigger-tag');
    if (tagEl) {
      tagEl.textContent = this.hoverExpanded ? '点此固定' : '用量';
    }

    if (!showStage && isHostAnchor) {
      this.setMousePassThrough(true);
    }

    // Pause PixiJS WebGL ticker whenever stockings are hidden/collapsed -> 0% idle GPU & <0.3% CPU!
    if (this.pauseRenderTimer !== null) {
      clearTimeout(this.pauseRenderTimer);
      this.pauseRenderTimer = null;
    }
    if (showStage) {
      this.stage?.setRenderingPaused(false);
    } else if (this.stageWrapEl.classList.contains('instant-collapse')) {
      this.stage?.setRenderingPaused(true);
    } else {
      this.pauseRenderTimer = window.setTimeout(() => {
        this.pauseRenderTimer = null;
        if (this.stageWrapEl.classList.contains('collapsed')) {
          this.stage?.setRenderingPaused(true);
        }
      }, 280);
    }
  }

  private expandHoverStage(): void {
    this.clearCollapseTimer();
    if (this.mode !== 'hover') return;
    if (!this.hoverExpanded) {
      this.hoverExpanded = true;
      this.renderModeState();
    }
  }

  private updateScaleUI(scalePct: number): void {
    this.currentScalePct = Math.max(65, Math.min(150, Math.round(scalePct)));
    this.simScaleSlider.value = String(this.currentScalePct);
    this.simScaleVal.textContent = `${this.currentScalePct}%`;
    this.stage?.setDisplayScale(this.currentScalePct / 150);
  }

  private scheduleHoverCollapse(): void {
    if (this.mode !== 'hover' || !this.hoverExpanded) return;
    if (this.stage.isStockingDragging() || this.isWindowDragging || this.simOpen || this.hostHotspotActive) return;
    if (this.hostPopupAgent === 'antigravity' && this.collapseTimer !== null) return;
    this.clearCollapseTimer();
    this.collapseTimer = window.setTimeout(() => {
      this.collapseTimer = null;
      if (
        this.mode === 'hover' &&
        !this.stage.isStockingDragging() &&
        !this.isWindowDragging &&
        !this.simOpen &&
        !this.pointerInsideInteractive &&
        !this.hostHotspotActive
      ) {
        this.hoverExpanded = false;
        this.renderModeState();
        this.setMousePassThrough(true);
      }
    }, 550);
  }

  private clearCollapseTimer(): void {
    if (this.collapseTimer !== null) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
  }

  private setSimOpen(open: boolean): void {
    this.simOpen = open;
    this.simPopoverEl.classList.toggle('open', open);
    this.pinnedBarEl.classList.toggle('active', open);
    this.renderModeState();
  }

  private setMousePassThrough(ignore: boolean): void {
    if (!this.desktop) return;
    const effective = this.isWindowDragging || this.stage.isStockingDragging() ? false : ignore;
    if (effective === this.lastIgnoreMouse) return;
    this.lastIgnoreMouse = effective;
    this.desktop.setIgnoreMouseEvents(effective, true);
  }

  private bindUIEvents(): void {
    let pillDown = false;
    let pillMoved = false;
    let pillStartX = 0;
    let pillStartY = 0;

    this.triggerPillEl.addEventListener('pointerenter', () => {
      this.setMousePassThrough(false);
      this.expandHoverStage();
    });

    this.triggerPillEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pillDown = true;
      pillMoved = false;
      pillStartX = e.screenX;
      pillStartY = e.screenY;
      this.setMousePassThrough(false);
    });

    window.addEventListener('pointermove', (e) => {
      if (!pillDown) return;
      if (!pillMoved && Math.hypot(e.screenX - pillStartX, e.screenY - pillStartY) > 5) {
        pillMoved = true;
        this.beginWindowDrag();
      }
    });

    window.addEventListener('pointerup', () => {
      if (!pillDown) return;
      pillDown = false;
      if (pillMoved) {
        this.finishWindowDrag();
      } else {
        this.setModeLocal('pinned', true);
      }
    });

    const btnMove = document.getElementById('btn-move')!;
    btnMove.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.beginWindowDrag();
    });

    const triggerManualRefresh = () => {
      this.desktop?.refreshAgent(this.activeAgent);
    };
    this.btnQuickRefreshEl.addEventListener('click', triggerManualRefresh);
    this.metricRefreshBtn.addEventListener('click', triggerManualRefresh);

    this.btnModeToggleEl.addEventListener('click', () => {
      this.setModeLocal(this.mode === 'hover' ? 'pinned' : 'hover', true);
    });

    document.getElementById('btn-sim')!.addEventListener('click', () => {
      this.setSimOpen(!this.simOpen);
    });

    document.getElementById('sim-close')!.addEventListener('click', () => {
      this.setSimOpen(false);
    });

    document.getElementById('btn-hide')!.addEventListener('click', () => {
      this.setSimOpen(false);
      this.desktop?.hideWindow();
    });

    document.getElementById('btn-quit')!.addEventListener('click', () => {
      this.desktop?.quitApp();
    });

    this.btnShowAllAgentsEl.addEventListener('click', () => {
      this.showAllAgents = !this.showAllAgents;
      this.buildDynamicAgentTabs();
    });

    this.btnAnchorHostEl.addEventListener('click', () => {
      this.hoverAnchorMode = 'host';
      this.syncSettingsTogglesUI();
      this.desktop?.setHoverAnchorMode('host');
      this.setModeLocal('hover', true);
    });

    this.btnAnchorPillEl.addEventListener('click', () => {
      this.hoverAnchorMode = 'pill';
      this.syncSettingsTogglesUI();
      this.desktop?.setHoverAnchorMode('pill');
      this.setModeLocal('hover', true);
    });

    this.btnCalibrateEl.addEventListener('click', () => {
      if (this.activeAgent === 'simulated') return;
      this.setSimOpen(false);
      this.desktop?.startHostCalibration(this.activeAgent);
    });

    document.getElementById('calib-cancel')!.addEventListener('click', () => {
      this.desktop?.cancelHostCalibration();
    });

    this.chkAutoFollowEl.addEventListener('change', () => {
      this.autoFollowAgent = this.chkAutoFollowEl.checked;
      this.desktop?.setAutoFollowAgent(this.autoFollowAgent);
    });

    this.chkHideTrayEl.addEventListener('change', () => {
      this.hideTrayIcon = this.chkHideTrayEl.checked;
      this.desktop?.setHideTrayIcon(this.hideTrayIcon);
    });

    this.chkSentinelEl.addEventListener('change', () => {
      this.sentinelEnabled = this.chkSentinelEl.checked;
      this.desktop?.setSentinelEnabled(this.sentinelEnabled);
    });

    this.chkAutoExitEl.addEventListener('change', () => {
      this.autoExitWhenNoAgents = this.chkAutoExitEl.checked;
      this.desktop?.setAutoExitWhenNoAgents(this.autoExitWhenNoAgents);
    });

    this.btnDshPluginActionEl.addEventListener('click', () => {
      if (this.dshPluginStatus?.installed) {
        this.desktop?.uninstallDshPlugin();
      } else {
        this.desktop?.installDshPlugin();
      }
    });

    const pushSim = () => {
      this.simLeftQuota = parseInt(this.simLeftSlider.value, 10);
      this.simRightQuota = parseInt(this.simRightSlider.value, 10);
      this.syncSlidersUI();
      this.renderActiveAgentUI();
      this.desktop?.setSimulatedQuota(this.simLeftQuota, this.simRightQuota);
    };
    this.simLeftSlider.addEventListener('input', pushSim);
    this.simRightSlider.addEventListener('input', pushSim);

    this.dshFreeSlider.addEventListener('input', () => {
      this.dshFreeLegQuota = parseInt(this.dshFreeSlider.value, 10);
      this.syncSlidersUI();
      this.renderActiveAgentUI();
      this.desktop?.setDshFreeLegQuota(this.dshFreeLegQuota);
    });

    this.simScaleSlider.addEventListener('input', () => {
      const pct = parseInt(this.simScaleSlider.value, 10);
      this.updateScaleUI(pct);
      this.desktop?.setScalePct(pct);
    });

    this.simLaceChk.addEventListener('change', () => {
      this.applyPresetVisual(this.currentPresetId, this.simLaceChk.checked);
      this.desktop?.setVisualPreset(this.currentPresetId, this.simLaceChk.checked);
    });

    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!this.lastIgnoreMouse) {
        this.desktop?.openContextMenu();
      }
    });
  }

  private beginWindowDrag(): void {
    if (this.isWindowDragging) return;
    this.isWindowDragging = true;
    this.setMousePassThrough(false);
    this.desktop?.startWindowDrag();
  }

  private finishWindowDrag(): void {
    if (!this.isWindowDragging) return;
    this.isWindowDragging = false;
    this.desktop?.endWindowDrag();
  }

  private isPointerOverInteractiveUI(clientX: number, clientY: number): boolean {
    const check = (el: HTMLElement) => {
      if (el.classList.contains('hidden') || (el === this.simPopoverEl && !this.simOpen)) return false;
      const r = el.getBoundingClientRect();
      return clientX >= r.left - 4 && clientX <= r.right + 4 && clientY >= r.top - 4 && clientY <= r.bottom + 4;
    };
    return (
      check(this.triggerPillEl) ||
      check(this.pinnedBarEl) ||
      check(this.simPopoverEl) ||
      check(this.calibBannerEl)
    );
  }

  private bindHitTestingAndDrag(): void {
    window.addEventListener('pointermove', (e) => {
      const overUI = this.isPointerOverInteractiveUI(e.clientX, e.clientY);
      const stageVisible = this.mode === 'pinned' || this.hoverExpanded || this.simOpen;
      const stageRegion: StageHitRegion = stageVisible ? this.stage.hitTestRegion(e.clientX, e.clientY) : 'none';
      const overCharacter = stageRegion !== 'none';

      const pillRect = this.triggerPillEl.getBoundingClientRect();
      const inBridge =
        this.mode === 'hover' &&
        this.hoverAnchorMode === 'pill' &&
        this.hoverExpanded &&
        e.clientX >= pillRect.left - 30 &&
        e.clientX <= pillRect.right + 30 &&
        e.clientY >= pillRect.top - 48 &&
        e.clientY <= pillRect.bottom + 6;
      this.pointerInsideInteractive = overUI || overCharacter || inBridge;

      if (this.isWindowDragging || this.stage.isStockingDragging()) {
        this.clearCollapseTimer();
        this.setMousePassThrough(false);
        return;
      }

      this.pinnedBarEl.classList.toggle('active', overUI || overCharacter || this.simOpen);
      this.skirtHintEl.classList.toggle('visible', this.mode === 'pinned' && stageRegion === 'skirt');

      if (this.mode === 'hover') {
        if (this.hoverAnchorMode === 'pill') {
          if (overUI) {
            this.expandHoverStage();
          } else if (this.hoverExpanded && (overCharacter || inBridge)) {
            this.clearCollapseTimer();
          } else if (this.hoverExpanded) {
            this.scheduleHoverCollapse();
          }
        } else {
          // Host-icon anchor mode: keep open while cursor is on stockings/toolbar or still on host hotspot
          if (this.hoverExpanded && (overUI || overCharacter || this.hostHotspotActive)) {
            this.clearCollapseTimer();
          } else if (this.hoverExpanded) {
            this.scheduleHoverCollapse();
          }
        }
      }

      this.setMousePassThrough(!(overUI || overCharacter));
    });

    window.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (this.stage.isStockingDragging()) return;
      if (this.isPointerOverInteractiveUI(e.clientX, e.clientY)) return;
      const stageVisible = this.mode === 'pinned' || this.hoverExpanded || this.simOpen;
      if (!stageVisible) return;

      const region = this.stage.hitTestRegion(e.clientX, e.clientY);
      if (region === 'skirt') {
        e.preventDefault();
        this.beginWindowDrag();
      }
    });

    window.addEventListener('pointerup', () => {
      this.finishWindowDrag();
    });
    window.addEventListener('pointercancel', () => {
      this.finishWindowDrag();
    });
  }

  private bindDesktopIpc(): void {
    if (!this.desktop) return;

    this.desktop.onStateSync((state) => {
      const modeChanged = state.mode !== this.mode;
      this.hoverAnchorMode = state.hoverAnchorMode ?? this.hoverAnchorMode;
      this.autoFollowAgent = state.autoFollowAgent ?? this.autoFollowAgent;
      this.hideTrayIcon = state.hideTrayIcon ?? this.hideTrayIcon;
      this.sentinelEnabled = state.sentinelEnabled ?? this.sentinelEnabled;
      this.autoExitWhenNoAgents = state.autoExitWhenNoAgents ?? this.autoExitWhenNoAgents;

      if (modeChanged) {
        this.setModeLocal(state.mode, false);
      } else {
        this.renderModeState();
      }

      if (state.activeAgent && state.activeAgent !== this.activeAgent) {
        this.activeAgent = state.activeAgent;
        this.buildDynamicAgentTabs();
      }
      if (state.presetId !== this.currentPresetId || state.laceCuff !== this.currentLaceCuff) {
        this.applyPresetVisual(state.presetId, state.laceCuff);
      }
      if (typeof state.scalePct === 'number' && state.scalePct !== this.currentScalePct) {
        this.updateScaleUI(state.scalePct);
      }
      this.simLeftQuota = state.leftQuota;
      this.simRightQuota = state.rightQuota;
      if (typeof state.dshFreeLegQuota === 'number') {
        this.dshFreeLegQuota = state.dshFreeLegQuota;
      }
      this.syncSlidersUI();
      this.syncSettingsTogglesUI();
      this.renderActiveAgentUI();
    });

    this.desktop.onQuotaUpdate((snap) => {
      this.simLeftQuota = snap.leftQuota;
      this.simRightQuota = snap.rightQuota;
      this.syncSlidersUI();
      if (this.activeAgent === 'simulated') {
        this.renderActiveAgentUI();
      }
    });

    this.desktop.onAgentMetric((metric) => {
      this.metrics[metric.agent] = metric;
      if (metric.agent === this.activeAgent) {
        this.renderActiveAgentUI();
      }
    });

    this.desktop.onDetectedAgentsSync((agents) => {
      this.detectedAgents = agents;
      this.buildDynamicAgentTabs();
    });

    this.desktop.onHostHoverTrigger((payload) => {
      this.hostHotspotActive = payload.active;
      if (payload.active) {
        this.hostPopupAgent = payload.agent;
        this.expandHoverStage();
      } else if (this.mode === 'hover' && this.hoverAnchorMode === 'host') {
        if (payload.immediate) {
          this.clearCollapseTimer();
          this.pointerInsideInteractive = false;
          this.hoverExpanded = false;
          this.hostPopupAgent = null;
          this.stageWrapEl.classList.add('instant-collapse');
          this.setSimOpen(false);
          this.setMousePassThrough(true);
        } else if (!this.pointerInsideInteractive) {
          this.scheduleHoverCollapse();
        }
      }
    });

    this.desktop.onCalibrationState((payload) => {
      this.calibBannerEl.classList.toggle('hidden', !payload.active);
      if (payload.hint) {
        this.calibHintEl.textContent = payload.hint;
      }
    });

    this.desktop.onSummonSettings(() => {
      this.stage?.setRenderingPaused(false);
      this.hoverExpanded = true;
      this.setSimOpen(true);
      this.setMousePassThrough(false);
    });

    this.desktop.onDshPluginStatus((status) => {
      this.dshPluginStatus = status;
      this.syncSettingsTogglesUI();
    });

    this.desktop.onRenderingPause((paused) => {
      if (this.pauseRenderTimer !== null) {
        clearTimeout(this.pauseRenderTimer);
        this.pauseRenderTimer = null;
      }
      this.stage?.setRenderingPaused(paused);
    });

    this.desktop.onCursorOutside(() => {
      this.pointerInsideInteractive = false;
      this.skirtHintEl.classList.remove('visible');
      if (!this.simOpen) this.pinnedBarEl.classList.remove('active');
      if (this.stage.isStockingDragging() || this.isWindowDragging) return;
      if (this.mode === 'hover' && !this.hostHotspotActive) {
        this.scheduleHoverCollapse();
      }
      this.setMousePassThrough(true);
    });

    this.desktop.onWindowFocusChange((focused) => {
      if (!focused) {
        this.finishWindowDrag();
        this.stage.cancelActiveDrag();
      }
    });

    this.desktop.onResumeRefresh(() => {
      this.stage.forceResize();
    });
  }
}

async function bootstrap() {
  const root = document.getElementById('widget-root');
  if (!root) return;
  const app = new DesktopWidgetApp();
  await app.mount(root);
}

bootstrap().catch((err) => {
  console.error('[StockingQuota Widget] Failed to initialize:', err);
});
