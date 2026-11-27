import * as http from 'http';
import type { AgentId, AgentMetric, DshContextPushPayload } from './providers/types';

export interface QuotaSnapshot {
  leftQuota: number;
  rightQuota: number;
  source: 'simulated' | 'external';
  leftLabel: string;
  rightLabel: string;
  updatedAt: number;
}

type QuotaListener = (snapshot: QuotaSnapshot) => void;

export interface LocalBridgeHooks {
  onDshContextPush?: (payload: DshContextPushPayload) => AgentMetric;
  onExternalMetricPush?: (metric: AgentMetric) => AgentMetric;
  getAllMetrics?: () => Record<AgentId, AgentMetric>;
}

/**
 * Loopback-only (127.0.0.1:17821) data bridge supporting:
 * - `GET  /quota`         — current simulated quota snapshot
 * - `POST /quota`         — simulated quota push `{ left, right }`
 * - `GET  /metrics`       — unified AgentMetric map for Codex, Antigravity, DSH
 * - `POST /dsh/context`   — DSH Host+Client plugin contextPressure push
 * - `POST /agent-metric`  — generic normalized AgentMetric push
 */
export class QuotaBridge {
  private snapshot: QuotaSnapshot;
  private listeners = new Set<QuotaListener>();
  private server: http.Server | null = null;

  constructor(initialLeft: number, initialRight: number) {
    this.snapshot = {
      leftQuota: clampPct(initialLeft),
      rightQuota: clampPct(initialRight),
      source: 'simulated',
      leftLabel: '短周期',
      rightLabel: '周额度',
      updatedAt: Date.now(),
    };
  }

  public getSnapshot(): QuotaSnapshot {
    return { ...this.snapshot };
  }

  public setQuota(
    left: number,
    right: number,
    source: 'simulated' | 'external' = 'simulated',
    labels?: { leftLabel?: string; rightLabel?: string }
  ): QuotaSnapshot {
    this.snapshot = {
      leftQuota: clampPct(left),
      rightQuota: clampPct(right),
      source,
      leftLabel: labels?.leftLabel ?? this.snapshot.leftLabel,
      rightLabel: labels?.rightLabel ?? this.snapshot.rightLabel,
      updatedAt: Date.now(),
    };
    const copy = this.getSnapshot();
    for (const cb of this.listeners) cb(copy);
    return copy;
  }

  public subscribe(listener: QuotaListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public startLocalBridge(port = 17821, hooks: LocalBridgeHooks = {}): void {
    try {
      this.server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');

        if (req.method === 'GET' && req.url === '/quota') {
          res.writeHead(200);
          res.end(JSON.stringify(this.getSnapshot()));
          return;
        }

        if (req.method === 'GET' && req.url === '/metrics') {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, metrics: hooks.getAllMetrics?.() ?? {} }));
          return;
        }

        if (req.method === 'POST' && (req.url === '/quota' || req.url === '/dsh/context' || req.url === '/agent-metric')) {
          let body = '';
          req.on('data', (chunk) => {
            body += String(chunk);
            if (body.length > 16384) req.destroy();
          });
          req.on('end', () => {
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>;

              if (req.url === '/dsh/context') {
                const metric = hooks.onDshContextPush?.(parsed as DshContextPushPayload);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, metric }));
                return;
              }

              if (req.url === '/agent-metric') {
                const metric = hooks.onExternalMetricPush?.(parsed as unknown as AgentMetric);
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true, metric }));
                return;
              }

              const nextLeft = typeof parsed.left === 'number' ? parsed.left : this.snapshot.leftQuota;
              const nextRight = typeof parsed.right === 'number' ? parsed.right : this.snapshot.rightQuota;
              const snap = this.setQuota(nextLeft, nextRight, 'external', {
                leftLabel: typeof parsed.leftLabel === 'string' ? parsed.leftLabel : undefined,
                rightLabel: typeof parsed.rightLabel === 'string' ? parsed.rightLabel : undefined,
              });
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, snapshot: snap }));
            } catch {
              res.writeHead(400);
              res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: 'Not found' }));
      });

      this.server.on('error', () => {
        this.server = null;
      });
      this.server.listen(port, '127.0.0.1');
    } catch {
      this.server = null;
    }
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}

function clampPct(v: number): number {
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, Math.round(v)));
}
