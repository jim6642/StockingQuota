export type AgentId = 'codex' | 'antigravity' | 'dsh' | 'simulated';

export type MetricStatus = 'ok' | 'stale' | 'unavailable';

export interface AgentMetricWindow {
  id: string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  usedTokens?: number;
  capacityTokens?: number;
  resetAt?: string;
  resetDescription?: string;
  group?: string;
  /** True when this leg is intentionally unbound for free tactile interaction (e.g. DSH right leg) */
  isFreePlay?: boolean;
}

export interface AgentMetric {
  agent: AgentId;
  status: MetricStatus;
  updatedAt?: string;
  source?: string;
  planOrModel?: string;
  message?: string;
  windows: AgentMetricWindow[];
}

export interface DshContextPushPayload {
  sessionId?: string;
  model?: string;
  projectedTokens?: number | null;
  pressureTokens?: number | null;
  contextWindow?: number | null;
  updatedAt?: string;
}

export interface AgentStockingBinding {
  agent: AgentId;
  displayName: string;
  defaultPresetId: string;
  accentHex: string;
}

export const AGENT_BINDINGS: Record<AgentId, AgentStockingBinding> = {
  codex: {
    agent: 'codex',
    displayName: 'OpenAI Codex',
    defaultPresetId: 'codex-white',
    accentHex: '#f1ecf8',
  },
  antigravity: {
    agent: 'antigravity',
    displayName: 'Google Antigravity',
    defaultPresetId: 'antigravity-purple',
    accentHex: '#c4b5fd',
  },
  dsh: {
    agent: 'dsh',
    displayName: 'DeepSeek Harness',
    defaultPresetId: 'dsh-blue',
    accentHex: '#7dd3fc',
  },
  simulated: {
    agent: 'simulated',
    displayName: '模拟调试',
    defaultPresetId: 'antigravity-purple',
    accentHex: '#f472b6',
  },
};

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}
