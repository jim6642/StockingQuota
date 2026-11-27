import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { resolveCodexBarCliPath, runCodexBarCli } from './codexProvider';
import { AgentMetric, AgentMetricWindow } from './types';

const execFileAsync = promisify(execFile);
const GEMINI = /\bgemini\b/i;
const EXCLUDED = /\b(?:gpt|openai|claude|anthropic|sonnet|opus|haiku|o[134])\b/i;
const WINDOW_LABELS = { '5h': '5H 额度', weekly: '周额度' };
type Cadence = keyof typeof WINDOW_LABELS;
type GeminiWindow = AgentMetricWindow & { id: Cadence; group: string; remainingPercent: number };

interface QuotaBucket {
  bucketId?: string;
  id?: string;
  displayName?: string;
  name?: string;
  window?: string;
  remainingFraction?: number;
  remaining_fraction?: number;
  remaining?: { remainingFraction?: number; remaining_fraction?: number; case?: string; value?: number };
  resetTime?: string;
  reset_time?: string;
  disabled?: boolean;
}

interface UsageReport {
  status?: string;
  command?: { name?: string; data?: { groups?: { name?: string; displayName?: string; buckets?: QuotaBucket[] }[] } };
}

interface CodexBarWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: string;
  is_informational?: boolean;
}

interface CodexBarUsage {
  primary?: CodexBarWindow;
  primary_label?: string;
  secondary?: CodexBarWindow;
  secondary_label?: string;
  updated_at?: string;
}

function getCadence(label: unknown): Cadence | undefined {
  if (typeof label !== 'string') return undefined;
  if (/(?:^|[^a-z0-9])(?:5[\s_-]*(?:hours?|hrs?|h)|300)(?:$|[^a-z0-9])/i.test(label)) return '5h';
  if (/(?:^|[^a-z0-9])(?:weekly|7[\s_-]*(?:days?|d)|10080)(?:$|[^a-z0-9])/i.test(label)) return 'weekly';
  return undefined;
}

function isGemini(identity: string): boolean {
  const words = identity.replace(/_/g, '-');
  return GEMINI.test(words) && !EXCLUDED.test(words);
}

function isBoundedNumber(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

function quotaWindow(id: Cadence, group: string, remainingPercent: number, reset?: string): GeminiWindow {
  return {
    id,
    label: WINDOW_LABELS[id],
    group,
    remainingPercent,
    usedPercent: 100 - remainingPercent,
    resetAt: typeof reset === 'string' && Number.isFinite(Date.parse(reset)) ? reset : undefined,
  };
}

function selectCompleteGroup(groups: Iterable<GeminiWindow[]>): GeminiWindow[] {
  const pairs = [];
  for (const windows of groups) {
    const left = windows.filter(window => window.id === '5h').sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
    const right = windows.filter(window => window.id === 'weekly').sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
    if (left && right) {
      const group = left.group;
      pairs.push({ group, left, right, ordinary: /^gemini(?: models?)?$/i.test(group) });
    }
  }
  pairs.sort((a, b) => Number(b.ordinary) - Number(a.ordinary) ||
    a.left.remainingPercent - b.left.remainingPercent ||
    a.right.remainingPercent - b.right.remainingPercent || a.group.localeCompare(b.group));
  return pairs.length ? [pairs[0].left, pairs[0].right] : [];
}

function parseCliUsage(report: UsageReport): GeminiWindow[] {
  const command = report?.command;
  if (report?.status !== 'SUCCESS' || command?.name !== 'usage' || !Array.isArray(command.data?.groups)) return [];
  const groups: GeminiWindow[][] = [];
  for (const group of command.data.groups) {
    const groupLabel = [group?.displayName, group?.name].find(label => typeof label === 'string' && label.trim())?.trim();
    if (!groupLabel || !isGemini(`${group.displayName ?? ''} ${group.name ?? ''}`) || !Array.isArray(group.buckets)) continue;

    const windows: GeminiWindow[] = [];
    for (const bucket of group.buckets) {
      if (!bucket || bucket.disabled) continue;
      const identity = `${bucket.bucketId ?? bucket.id ?? ''} ${bucket.displayName ?? bucket.name ?? ''}`.replace(/_/g, '-');
      if (EXCLUDED.test(identity)) continue;
      const id = bucket.window ? getCadence(bucket.window) : getCadence(identity);
      const fraction = bucket.remainingFraction ?? bucket.remaining_fraction ??
        bucket.remaining?.remainingFraction ?? bucket.remaining?.remaining_fraction ??
        (bucket.remaining?.case === 'remainingFraction' ? bucket.remaining.value : undefined);
      if (id && isBoundedNumber(fraction, 1)) {
        windows.push(quotaWindow(id, groupLabel, fraction * 100, bucket.resetTime ?? bucket.reset_time));
      }
    }
    // Keep source groups distinct even if Google gives two groups the same display name.
    groups.push(windows);
  }
  return selectCompleteGroup(groups);
}

function fromCodexBar(usage: CodexBarUsage): GeminiWindow[] {
  const convert = (id: Cadence, minutes: number, title?: string, raw?: CodexBarWindow) => {
    if (typeof title !== 'string' || !isGemini(title) || !raw || raw.is_informational ||
        !isBoundedNumber(raw.used_percent, 100) || (raw.window_minutes ?? minutes) !== minutes ||
        getCadence(title) !== id) return undefined;
    const group = title.replace(/\s+(?:5[\s_-]*(?:hours?|hrs?|h)|weekly)(?:\s+(?:limit|quota))?$/i, '').trim();
    return quotaWindow(id, group, 100 - raw.used_percent, raw.resets_at);
  };
  // Win-CodexBar selects its two primary lanes from the preferred grouped quota.
  // Extra lanes can share display labels across groups, so they cannot replace a missing lane.
  const left = convert('5h', 300, usage.primary_label, usage.primary);
  const right = convert('weekly', 10080, usage.secondary_label, usage.secondary);
  return left && right && left.group.toLowerCase() === right.group.toLowerCase() ? [left, right] : [];
}

function resolveAgyCli(): string | undefined {
  const configured = process.env.ANTIGRAVITY_CLI_PATH;
  const local = process.env.LOCALAPPDATA;
  const candidates = configured !== undefined ? [configured] : [
    ...(local ? [path.join(local, 'agy', 'bin', 'agy.exe')] : []),
    path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agy.exe'),
    ...(process.env.PATH ?? '').split(path.delimiter)
      .map(entry => entry.trim().replace(/^"|"$/g, ''))
      .filter(entry => path.isAbsolute(entry))
      .map(entry => path.join(entry, 'agy.exe')),
  ];
  return candidates.find(candidate => candidate && path.isAbsolute(candidate) &&
    /\.exe$/i.test(candidate) && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

function getSafeAgyVersion(stdout: string): string | undefined {
  const match = /^(?:(?:agy|antigravity(?: cli)?)(?:\s+version)?\s+)?v?(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/im.exec(stdout.trim());
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (major > 1 || major === 1 && (minor > 1 || minor === 1 && (patch > 11 || patch === 11 && !match[4]))) {
    return `${major}.${minor}.${patch}${match[4] ?? ''}`;
  }
  return undefined;
}

async function readAgyUsage(): Promise<{ windows: GeminiWindow[]; version?: string }> {
  let version: string | undefined;
  try {
    const agy = resolveAgyCli();
    if (!agy) return { windows: [] };

    const options = { windowsHide: true, maxBuffer: 1024 * 1024 };
    const { stdout: versionOutput } = await execFileAsync(agy, ['--version'], { ...options, timeout: 5000 });
    version = getSafeAgyVersion(versionOutput);
    if (!version) return { windows: [] };

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agy-'));
    try {
      const { stdout } = await execFileAsync(agy, ['-p', '/usage', '--output-format', 'json'], {
        ...options, cwd: workdir, timeout: 35000,
      });
      return { windows: parseCliUsage(JSON.parse(stdout)), version };
    } finally {
      fs.rmSync(workdir, { recursive: true, force: true });
    }
  } catch {
    return { windows: [], version };
  }
}

export async function fetchAntigravityMetric(appRoot: string): Promise<AgentMetric> {
  const agy = await readAgyUsage();
  if (agy.windows.length) {
    return {
      agent: 'antigravity',
      status: 'ok',
      updatedAt: new Date().toISOString(),
      source: `agy-cli (${agy.version})`,
      planOrModel: agy.windows[0].group,
      windows: agy.windows,
    };
  }

  try {
    const cli = resolveCodexBarCliPath(appRoot);
    // Use Win-CodexBar's local probe only. StockingQuota owns all agy invocations and version checks.
    const result = cli && await runCodexBarCli(cli, 'antigravity', 25000, { ANTIGRAVITY_CLI_PATH: '' });
    if (result && result.source && result.source !== 'offline' && result.usage) {
      const usage = result.usage as CodexBarUsage;
      const windows = fromCodexBar(usage);
      if (windows.length) {
        return {
          agent: 'antigravity',
          status: 'ok',
          updatedAt: usage.updated_at ?? new Date().toISOString(),
          source: `win-codexbar (${result.source})`,
          planOrModel: windows[0].group,
          windows,
        };
      }
    }
  } catch {
    // The provider manager retains the last valid reading when neither source succeeds.
  }

  return {
    agent: 'antigravity',
    status: 'unavailable',
    source: 'unavailable',
    message: agy.version
      ? '未读到 Gemini 同一模型组的 5 小时和周额度，请确认 agy 已登录且账户提供这两个周期'
      : '未读到 Gemini 实时额度，请确认已安装官方 agy ≥ 1.1.11',
    windows: [],
  };
}
