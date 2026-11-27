import { AgentMetric, clampPercent, DshContextPushPayload } from './types';

/**
 * DeepSeek Harness (DSH) Context Capacity Adapter.
 *
 * Matches DSH's native `@deepseek-ai/dsh-token-meter` `contextPressure` calculation 1:1:
 *   usedTokens = projectedTokens ?? pressureTokens
 *   usedPercent = clamp((usedTokens / contextWindow) * 100, 0, 100)
 *   remainingPercent = 100 - usedPercent
 *
 * Strictly ignores cumulative session `92.7K tok` / cache-hit stats.
 * Never fabricates 100% or 0% when required fields are absent, and safely flags
 * brief model-switch / window-mismatch transitions as `stale` until resettled.
 */
export class DshContextProvider {
  private lastMetric: AgentMetric;
  private lastSessionId = '';
  private lastModel = '';
  private lastContextWindow = 0;
  private lastPushMs = 0;

  constructor() {
    this.lastMetric = {
      agent: 'dsh',
      status: 'unavailable',
      source: 'dsh-plugin-bridge',
      message: '等待 DSH 桥接插件推送当前会话上下文（请启用 dsh-stocking-quota-bridge）',
      windows: [
        {
          id: 'free-play',
          label: '自由互动',
          isFreePlay: true,
        },
      ],
    };
  }

  public ingestContextPush(payload: DshContextPushPayload): AgentMetric {
    const nowIso = payload.updatedAt ?? new Date().toISOString();
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : this.lastSessionId;
    const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : this.lastModel;

    const proj =
      typeof payload.projectedTokens === 'number' && Number.isFinite(payload.projectedTokens) && payload.projectedTokens >= 0
        ? payload.projectedTokens
        : undefined;
    const pres =
      typeof payload.pressureTokens === 'number' && Number.isFinite(payload.pressureTokens) && payload.pressureTokens >= 0
        ? payload.pressureTokens
        : undefined;
    const ctxWin =
      typeof payload.contextWindow === 'number' && Number.isFinite(payload.contextWindow) && payload.contextWindow > 0
        ? payload.contextWindow
        : undefined;

    const usedTokens = proj ?? pres;

    // Missing required fields -> strictly mark unavailable (NEVER fake 100% or 0%!)
    if (usedTokens === undefined || ctxWin === undefined) {
      this.lastSessionId = sessionId;
      this.lastModel = model;
      this.lastMetric = {
        agent: 'dsh',
        status: 'unavailable',
        updatedAt: nowIso,
        source: 'dsh-plugin-bridge',
        planOrModel: model || 'DeepSeek Harness',
        message: '当前会话尚未产生上下文压力投影（暂不可用）',
        windows: [
          {
            id: 'free-play',
            label: '自由互动',
            isFreePlay: true,
          },
        ],
      };
      return this.getMetric();
    }

    // Detect brief model/contextWindow switch mismatch (old token count vs newly switched smaller/different window)
    const modelChanged = Boolean(this.lastModel && model && model !== this.lastModel);
    const windowChanged = Boolean(this.lastContextWindow > 0 && ctxWin !== this.lastContextWindow);
    const ratioOverflow = usedTokens > ctxWin * 1.02;
    const isTransitionStale = (modelChanged || windowChanged) && ratioOverflow;

    this.lastSessionId = sessionId;
    this.lastModel = model;
    this.lastContextWindow = ctxWin;
    this.lastPushMs = Date.now();

    const rawUsedPct = Math.max(0, Math.min(100, (usedTokens / ctxWin) * 100));
    const usedPercent = clampPercent(rawUsedPct);
    const remainingPercent = clampPercent(100 - rawUsedPct);

    this.lastMetric = {
      agent: 'dsh',
      status: isTransitionStale ? 'stale' : 'ok',
      updatedAt: nowIso,
      source: proj !== undefined ? 'dsh-contextPressure (projected)' : 'dsh-contextPressure (pressure)',
      planOrModel: model || 'DeepSeek Harness',
      message: isTransitionStale
        ? '检测到模型切换，等待下一轮上下文重算'
        : `上下文已用 ${Math.round(rawUsedPct)}%（剩余 ${Math.round(remainingPercent)}%）`,
      windows: [
        {
          id: 'context',
          label: '上下文剩余',
          usedPercent,
          remainingPercent,
          usedTokens: Math.round(usedTokens),
          capacityTokens: Math.round(ctxWin),
          group: model || undefined,
        },
        {
          id: 'free-play',
          label: '自由互动',
          isFreePlay: true,
        },
      ],
    };

    return this.getMetric();
  }

  public getMetric(): AgentMetric {
    // Mark stale if DSH hasn't pushed any heartbeat/update for > 10 minutes
    if (this.lastMetric.status === 'ok' && this.lastPushMs > 0 && Date.now() - this.lastPushMs > 10 * 60 * 1000) {
      return {
        ...this.lastMetric,
        status: 'stale',
        message: 'DSH 长时间无更新（显示最近一次会话上下文）',
      };
    }
    return {
      ...this.lastMetric,
      windows: this.lastMetric.windows.map((w) => ({ ...w })),
    };
  }
}
