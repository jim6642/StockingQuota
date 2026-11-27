/**
 * dsh-stocking-quota-bridge (Host half — Node ESM).
 * 1. Receives sanitized numeric contextPressure snapshots from the browser half
 *    and forwards them to StockingQuota's loopback-only HTTP endpoint (127.0.0.1:17821).
 * 2. Keeps the latest sanitized snapshot in memory and automatically re-syncs to StockingQuota
 *    every few seconds so even if StockingQuota is started or restarted AFTER DSH is already open,
 *    DSH recovers from "unavailable" automatically without switching chats!
 * 3. Optionally auto-launches StockingQuota.exe silently (`--silent --from-agent=dsh`)
 *    when DeepSeek Harness starts — zero Windows boot startup needed!
 * Never accesses credentials, API keys, or conversation text.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export const name = 'dsh-stocking-quota-bridge';

const DEFAULT_TARGET = 'http://127.0.0.1:17821/dsh/context';

async function maybeAutoLaunchStockingQuota(exePath) {
  if (typeof exePath !== 'string' || !exePath || !existsSync(exePath)) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 400);
  try {
    const res = await fetch('http://127.0.0.1:17821/metrics', { signal: ctrl.signal });
    if (res.ok) return;
  } catch {
    // Not running yet -> spawn silently!
  } finally {
    clearTimeout(timer);
  }

  try {
    const child = spawn(exePath, ['--silent', '--from-agent=dsh'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Never interrupt DSH startup if launch fails
  }
}

async function forwardSnapshot(targetUrl, snapshot) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1200);
  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function apply(ctx, config = {}) {
  const targetUrl =
    typeof config?.targetUrl === 'string' && config.targetUrl.startsWith('http://127.0.0.1:')
      ? config.targetUrl
      : DEFAULT_TARGET;

  if (config?.autoLaunch !== false && typeof config?.stockingQuotaExe === 'string') {
    void maybeAutoLaunchStockingQuota(config.stockingQuotaExe);
  }

  if (typeof ctx.inject !== 'function') return;

  ctx.inject(['webServer'], (scope) => {
    try {
      let lastSanitized = null;
      let lastDeliveredOk = false;

      // Auto-resync loop: if StockingQuota restarts or starts after DSH, re-deliver the latest
      // snapshot automatically (every 4s while disconnected, every 12s while connected).
      let tickCount = 0;
      const heartbeat = setInterval(() => {
        if (!lastSanitized) return;
        tickCount++;
        if (!lastDeliveredOk || tickCount % 3 === 0) {
          void forwardSnapshot(targetUrl, lastSanitized).then((ok) => {
            lastDeliveredOk = ok;
          });
        }
      }, 4000);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();

      scope.effect(() => () => clearInterval(heartbeat), 'dsh-stocking-quota-bridge: heartbeat');

      const route = {
        name: 'dsh-stocking-quota-context',
        kind: 'exact',
        path: '/dsh-stocking-quota/context',
        handler: async (req, res) => {
          const send = (status, body) => {
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(body));
          };
          if (req.method !== 'POST') {
            send(405, { ok: false });
            return;
          }

          try {
            const chunks = [];
            let total = 0;
            for await (const chunk of req) {
              total += chunk.length;
              if (total > 8192) {
                send(413, { ok: false });
                req.destroy();
                return;
              }
              chunks.push(chunk);
            }
            const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const mr = raw.meterRect && typeof raw.meterRect === 'object' ? raw.meterRect : null;
            const meterRect =
              mr &&
              typeof mr.x === 'number' &&
              typeof mr.y === 'number' &&
              typeof mr.width === 'number' &&
              typeof mr.height === 'number' &&
              typeof mr.viewportW === 'number' &&
              typeof mr.viewportH === 'number'
                ? {
                    x: Math.round(mr.x),
                    y: Math.round(mr.y),
                    width: Math.round(mr.width),
                    height: Math.round(mr.height),
                    viewportW: Math.round(mr.viewportW),
                    viewportH: Math.round(mr.viewportH),
                  }
                : null;
            const sanitized = {
              sessionId: typeof raw.sessionId === 'string' ? raw.sessionId.slice(0, 128) : undefined,
              model: typeof raw.model === 'string' ? raw.model.slice(0, 128) : undefined,
              projectedTokens: typeof raw.projectedTokens === 'number' ? raw.projectedTokens : null,
              pressureTokens: typeof raw.pressureTokens === 'number' ? raw.pressureTokens : null,
              contextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : null,
              meterRect,
              updatedAt: new Date().toISOString(),
            };

            lastSanitized = sanitized;
            lastDeliveredOk = await forwardSnapshot(targetUrl, sanitized);
            send(200, { ok: lastDeliveredOk });
          } catch {
            send(200, { ok: false });
          }
        },
      };
      scope.effect(() => scope.webServer.register(route), 'dsh-stocking-quota-bridge: host route');
    } catch (error) {
      console.error(`[dsh-stocking-quota-bridge] host route skipped: ${error}`);
    }
  });
}
