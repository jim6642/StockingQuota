import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RealAgentId } from '../windowTracker';

export interface DetectedAgentInfo {
  id: RealAgentId;
  installed: boolean;
  running: boolean;
  reason: string;
}

function hasCodexInstalled(): boolean {
  const home = os.homedir();
  if (fs.existsSync(path.join(home, '.codex'))) return true;
  const localApps = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps');
  if (fs.existsSync(path.join(localApps, 'codex.exe'))) return true;
  // Check Program Files / WindowsApps via safe APPDATA/LOCALAPPDATA package folders
  const packagesDir = path.join(process.env.LOCALAPPDATA ?? '', 'Packages');
  try {
    if (fs.existsSync(packagesDir)) {
      const entries = fs.readdirSync(packagesDir);
      if (entries.some((e) => e.startsWith('OpenAI.Codex') || e.startsWith('OpenAI.ChatGPT'))) {
        return true;
      }
    }
  } catch {
    // ignore permission errors
  }
  return false;
}

function hasAntigravityInstalled(): boolean {
  const home = os.homedir();
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'antigravity', 'Antigravity.exe'),
    path.join(home, '.gemini', 'antigravity', 'bin', 'agy.exe'),
    path.join(process.env.APPDATA ?? '', 'npm', 'agy.cmd'),
  ];
  if (candidates.some((p) => p && fs.existsSync(p))) return true;
  if (fs.existsSync(path.join(home, '.gemini', 'antigravity'))) return true;
  return false;
}

function hasDshInstalled(): boolean {
  const home = os.homedir();
  if (fs.existsSync(path.join(home, '.dsh'))) return true;
  return false;
}

/**
 * Automatically detects which AI Agents are installed/running on this Windows machine.
 * Allows the settings UI to display only the Agents this user actually owns, instead of hardcoding all 3.
 */
export function detectLocalAgents(runningAgents: RealAgentId[] = []): DetectedAgentInfo[] {
  const runningSet = new Set(runningAgents);

  const codexInstalled = hasCodexInstalled() || runningSet.has('codex');
  const agyInstalled = hasAntigravityInstalled() || runningSet.has('antigravity');
  const dshInstalled = hasDshInstalled() || runningSet.has('dsh');

  return [
    {
      id: 'codex',
      installed: codexInstalled,
      running: runningSet.has('codex'),
      reason: runningSet.has('codex')
        ? '运行中'
        : codexInstalled
          ? '已检测到本机安装'
          : '未检测到安装',
    },
    {
      id: 'antigravity',
      installed: agyInstalled,
      running: runningSet.has('antigravity'),
      reason: runningSet.has('antigravity')
        ? '运行中'
        : agyInstalled
          ? '已检测到本机安装'
          : '未检测到安装',
    },
    {
      id: 'dsh',
      installed: dshInstalled,
      running: runningSet.has('dsh'),
      reason: runningSet.has('dsh')
        ? '运行中'
        : dshInstalled
          ? '已检测到本机安装'
          : '未检测到安装',
    },
  ];
}
