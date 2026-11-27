import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { AgentMetric, AgentMetricWindow, clampPercent } from './types';

const execFileAsync = promisify(execFile);

interface CodexBarWindow {
  used_percent?: number;
  window_minutes?: number | null;
  resets_at?: string | null;
  reset_description?: string | null;
  is_informational?: boolean;
}

interface CodexBarProviderPayload {
  provider?: string;
  source?: string;
  usage?: {
    login_method?: string | null;
    primary?: CodexBarWindow | null;
    secondary?: CodexBarWindow | null;
    updated_at?: string | null;
  } | null;
  error?: string | null;
}

export function resolveSilentExecPath(appRoot?: string): string | null {
  const candidates = [
    appRoot ? path.join(appRoot, 'vendor', 'win-exec', 'sq-silent-exec.exe').replace('app.asar', 'app.asar.unpacked') : '',
    appRoot ? path.join(appRoot, 'vendor', 'win-exec', 'sq-silent-exec.exe') : '',
    path.join(process.cwd(), 'vendor', 'win-exec', 'sq-silent-exec.exe'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Executes a Windows console CLI (`codexbar-cli.exe`, `agy.exe`) through our 9KB WinExe ConPTY
 * headless runner (`sq-silent-exec.exe`) so neither the CLI nor any grandchild process it spawns
 * can ever flash a visible black console window on Windows 10/11!
 */
export async function execSilentCli(
  targetExe: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
  appRoot?: string,
): Promise<{ stdout: string; stderr: string }> {
  const runner = resolveSilentExecPath(appRoot);
  const execPath = runner ?? targetExe;
  const execArgs = runner ? [targetExe, ...args] : args;
  return execFileAsync(execPath, execArgs, {
    timeout: options.timeout ?? 25000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    cwd: options.cwd,
    windowsHide: true,
    env: options.env,
  });
}

/**
 * Resolve bundled MIT-licensed Win-CodexBar CLI binary (`vendor/codexbar/codexbar-cli.exe`)
 * or user-installed `codexbar-cli.exe` in PATH.
 */
export function resolveCodexBarCliPath(appRoot: string): string | null {
  const candidates = [
    path.join(appRoot, 'vendor', 'codexbar', 'codexbar-cli.exe').replace('app.asar', 'app.asar.unpacked'),
    path.join(appRoot, 'vendor', 'codexbar', 'codexbar-cli.exe'),
    path.join(process.cwd(), 'vendor', 'codexbar', 'codexbar-cli.exe'),
    process.env.CODEXBAR_CLI_PATH || '',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function runCodexBarCli(
  cliPath: string,
  provider: 'codex' | 'antigravity',
  timeoutMs = 25000,
  extraEnv?: NodeJS.ProcessEnv,
  appRoot?: string,
): Promise<CodexBarProviderPayload | null> {
  const { stdout } = await execSilentCli(
    cliPath,
    ['usage', '-p', provider, '--json'],
    {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1', ...extraEnv },
    },
    appRoot,
  );

  const text = stdout.trim();
  if (!text) return null;
  const parsed = JSON.parse(text) as CodexBarProviderPayload[] | CodexBarProviderPayload;
  if (Array.isArray(parsed)) {
    return parsed.find((item) => item.provider?.toLowerCase() === provider) ?? parsed[0] ?? null;
  }
  return parsed;
}

function toWindow(id: string, defaultLabel: string, raw?: CodexBarWindow | null): AgentMetricWindow | null {
  if (!raw || raw.is_informational) return null;
  if (typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent)) return null;
  const used = clampPercent(raw.used_percent);
  const remaining = clampPercent(100 - used);
  return {
    id,
    label: defaultLabel,
    usedPercent: used,
    remainingPercent: remaining,
    resetAt: raw.resets_at ?? undefined,
    resetDescription: raw.reset_description ?? undefined,
  };
}

/**
 * Fallback: read only numeric `rate_limits` metadata from the most recent `~/.codex/sessions/*.jsonl`
 * (never reading or logging conversation text or credentials).
 */
function readCodexSessionRateLimitsFallback(): AgentMetric | null {
  try {
    const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(sessionsRoot)) return null;

    const files: { fullPath: string; mtimeMs: number }[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            const st = fs.statSync(full);
            files.push({ fullPath: full, mtimeMs: st.mtimeMs });
          } catch {
            // ignore unreadable file
          }
        }
      }
    };
    walk(sessionsRoot, 0);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const file of files.slice(0, 6)) {
      const content = fs.readFileSync(file.fullPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('"rate_limits"')) continue;
        try {
          const obj = JSON.parse(line) as {
            timestamp?: string;
            payload?: {
              rate_limits?: {
                plan_type?: string;
                primary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
                secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number };
              };
            };
          };
          const rl = obj.payload?.rate_limits;
          if (!rl) continue;
          const windows: AgentMetricWindow[] = [];
          if (typeof rl.primary?.used_percent === 'number') {
            const u = clampPercent(rl.primary.used_percent);
            windows.push({
              id: '5h',
              label: '5H 会话',
              usedPercent: u,
              remainingPercent: clampPercent(100 - u),
              resetAt: rl.primary.resets_at ? new Date(rl.primary.resets_at * 1000).toISOString() : undefined,
            });
          }
          if (typeof rl.secondary?.used_percent === 'number') {
            const u = clampPercent(rl.secondary.used_percent);
            windows.push({
              id: 'weekly',
              label: '周额度',
              usedPercent: u,
              remainingPercent: clampPercent(100 - u),
              resetAt: rl.secondary.resets_at ? new Date(rl.secondary.resets_at * 1000).toISOString() : undefined,
            });
          }
          if (windows.length > 0) {
            const ts = obj.timestamp ? Date.parse(obj.timestamp) : file.mtimeMs;
            const ageMin = (Date.now() - (Number.isFinite(ts) ? ts : file.mtimeMs)) / 60000;
            return {
              agent: 'codex',
              status: ageMin > 20 ? 'stale' : 'ok',
              updatedAt: new Date(Number.isFinite(ts) ? ts : file.mtimeMs).toISOString(),
              source: 'codex-session-log',
              planOrModel: rl.plan_type ? `Codex ${rl.plan_type}` : 'Codex',
              message: ageMin > 20 ? '来自本地会话记录（稍旧）' : '来自本地 Codex 会话记录',
              windows,
            };
          }
        } catch {
          // skip malformed line
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function fetchCodexMetric(appRoot: string): Promise<AgentMetric> {
  const cliPath = resolveCodexBarCliPath(appRoot);

  if (cliPath) {
    try {
      const payload = await runCodexBarCli(cliPath, 'codex', 25000, undefined, appRoot);
      if (payload?.usage && payload.source !== 'offline') {
        const w5h = toWindow('5h', '5H 会话', payload.usage.primary);
        const wWeek = toWindow('weekly', '周额度', payload.usage.secondary);
        const windows = [w5h, wWeek].filter((w): w is AgentMetricWindow => w !== null);
        if (windows.length > 0) {
          return {
            agent: 'codex',
            status: 'ok',
            updatedAt: payload.usage.updated_at ?? new Date().toISOString(),
            source: `win-codexbar (${payload.source ?? 'oauth'})`,
            planOrModel: payload.usage.login_method ?? 'Codex',
            message: '实时同步自 Codex 登录会话',
            windows,
          };
        }
      }
    } catch {
      // Never leak raw CLI error details that could contain env info; fall back cleanly
    }
  }

  const fallback = readCodexSessionRateLimitsFallback();
  if (fallback) return fallback;

  return {
    agent: 'codex',
    status: 'unavailable',
    updatedAt: new Date().toISOString(),
    source: cliPath ? 'win-codexbar' : 'none',
    message: '未读取到 Codex 额度（请确认已登录 Codex）',
    windows: [],
  };
}
