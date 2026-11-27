import { fetchAntigravityMetric } from './antigravityProvider';
import { fetchCodexMetric } from './codexProvider';
import { DshContextProvider } from './dshProvider';
import { AgentId, AgentMetric, DshContextPushPayload } from './types';

type MetricListener = (agent: AgentId, metric: AgentMetric) => void;

/**
 * Coordinates all 3 real Agent providers + simulated fallback.
 *
 * Reliability rules enforced centrally:
 * - Failed reads NEVER overwrite a good reading with 0% (degrade gracefully to `stale` if cached,
 *   or `unavailable` if never received).
 * - Conservative 60-second polling interval + 5-second manual refresh cooldown to avoid rate limits.
 * - Zero secrets, OAuth tokens, or chat text logged anywhere.
 */
export class AgentManager {
  private readonly appRoot: string;
  private readonly dshProvider = new DshContextProvider();
  private readonly cache = new Map<AgentId, AgentMetric>();
  private readonly lastGood = new Map<AgentId, AgentMetric>();
  private readonly lastManualRefreshMs = new Map<AgentId, number>();
  private readonly listeners = new Set<MetricListener>();

  private activeAgent: AgentId = 'codex';
  private installedAgents = new Set<AgentId>(['codex', 'antigravity', 'dsh']);
  private pollTimer: NodeJS.Timeout | null = null;
  private inFlight = new Set<AgentId>();

  constructor(appRoot: string, initialAgent: AgentId = 'codex') {
    this.appRoot = appRoot;
    this.activeAgent = initialAgent;
    this.cache.set('dsh', this.dshProvider.getMetric());
  }

  public setInstalledAgents(agents: AgentId[]): void {
    this.installedAgents = new Set(agents);
  }

  public setActiveAgent(agent: AgentId): void {
    this.activeAgent = agent;
    if (agent === 'codex' || agent === 'antigravity') {
      void this.refresh(agent, false);
    } else if (agent === 'dsh') {
      this.emit('dsh', this.dshProvider.getMetric());
    }
  }

  public getActiveAgent(): AgentId {
    return this.activeAgent;
  }

  public getMetric(agent: AgentId): AgentMetric {
    if (agent === 'dsh') return this.dshProvider.getMetric();
    const cached = this.cache.get(agent);
    if (cached) return cached;
    return {
      agent,
      status: 'unavailable',
      message: '尚未拉取数据',
      windows: [],
    };
  }

  public getAllMetrics(): Record<AgentId, AgentMetric> {
    return {
      codex: this.getMetric('codex'),
      antigravity: this.getMetric('antigravity'),
      dsh: this.getMetric('dsh'),
      simulated: this.getMetric('simulated'),
    };
  }

  public ingestDshContext(payload: DshContextPushPayload): AgentMetric {
    const metric = this.dshProvider.ingestContextPush(payload);
    this.cache.set('dsh', metric);
    if (metric.status === 'ok') {
      this.lastGood.set('dsh', metric);
    }
    this.emit('dsh', metric);
    return metric;
  }

  public ingestExternalMetric(metric: AgentMetric): AgentMetric {
    if (metric.agent === 'dsh' || metric.agent === 'codex' || metric.agent === 'antigravity') {
      this.cache.set(metric.agent, metric);
      if (metric.status === 'ok') {
        this.lastGood.set(metric.agent, metric);
      }
      this.emit(metric.agent, metric);
    }
    return metric;
  }

  public async refresh(agent: AgentId, isManual = false): Promise<AgentMetric> {
    if (agent === 'simulated') {
      return this.getMetric('simulated');
    }
    if (agent === 'dsh') {
      const m = this.dshProvider.getMetric();
      this.emit('dsh', m);
      return m;
    }

    // Rate-limit guard: prevent spamming manual refresh (< 4.5s cooldown)
    const now = Date.now();
    if (isManual) {
      const last = this.lastManualRefreshMs.get(agent) ?? 0;
      if (now - last < 4500 && this.cache.has(agent)) {
        return this.cache.get(agent)!;
      }
      this.lastManualRefreshMs.set(agent, now);
    }

    if (this.inFlight.has(agent)) {
      return this.getMetric(agent);
    }
    this.inFlight.add(agent);

    try {
      const fresh =
        agent === 'codex'
          ? await fetchCodexMetric(this.appRoot)
          : await fetchAntigravityMetric(this.appRoot);

      let resolved = fresh;
      if (fresh.status === 'ok') {
        this.lastGood.set(agent, fresh);
      } else if (fresh.status === 'unavailable' && this.lastGood.has(agent)) {
        // Never overwrite valid quota with unavailable/0%; degrade smoothly to `stale`!
        const prev = this.lastGood.get(agent)!;
        resolved = {
          ...prev,
          status: 'stale',
          message: `刷新失败，保持上次有效数据（${fresh.message ?? '数据源暂不可用'}）`,
        };
      }

      this.cache.set(agent, resolved);
      this.emit(agent, resolved);
      return resolved;
    } finally {
      this.inFlight.delete(agent);
    }
  }

  public startPolling(intervalMs = 60_000, fetchAllInitial = true): void {
    this.stopPolling();
    if (fetchAllInitial) {
      // Only poll Agents that are actually installed on this machine
      if (this.installedAgents.has('codex')) void this.refresh('codex', false);
      if (this.installedAgents.has('antigravity')) void this.refresh('antigravity', false);
    } else if (
      (this.activeAgent === 'codex' || this.activeAgent === 'antigravity') &&
      this.installedAgents.has(this.activeAgent)
    ) {
      void this.refresh(this.activeAgent, false);
    }

    this.pollTimer = setInterval(() => {
      if (
        (this.activeAgent === 'codex' || this.activeAgent === 'antigravity') &&
        this.installedAgents.has(this.activeAgent)
      ) {
        void this.refresh(this.activeAgent, false);
      }
    }, intervalMs);
  }

  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  public subscribe(listener: MetricListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(agent: AgentId, metric: AgentMetric): void {
    for (const cb of this.listeners) cb(agent, metric);
  }
}
