import { app } from 'electron';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REG_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REG_VALUE_NAME = 'StockingQuotaSentinel';

export function resolveSentinelExePath(appRoot: string): string | null {
  const candidates = [
    path.join(appRoot, 'vendor', 'win-sentinel', 'sq-sentinel.exe').replace('app.asar', 'app.asar.unpacked'),
    path.join(appRoot, 'vendor', 'win-sentinel', 'sq-sentinel.exe'),
    path.join(process.cwd(), 'vendor', 'win-sentinel', 'sq-sentinel.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveTargetAppExe(): string {
  if (app.isPackaged) {
    return process.execPath;
  }
  const unpacked = path.join(process.cwd(), 'release', 'win-unpacked', 'StockingQuota.exe');
  if (fs.existsSync(unpacked)) return unpacked;
  return process.execPath;
}

/**
 * Starts the ~3MB pure Win32 sentinel (`sq-sentinel.exe`) and optionally registers it
 * in HKCU\...\Run so Codex / Antigravity / DSH wake up StockingQuota automatically
 * without running heavy Electron at Windows boot!
 */
export function enableSentinel(appRoot: string, registerLoginRun = true): boolean {
  const sentinelBin = resolveSentinelExePath(appRoot);
  if (!sentinelBin) return false;
  const targetExe = resolveTargetAppExe();

  // Only write HKCU Run key when running the packaged Windows app (never point login autorun to dev electron.exe)
  if (registerLoginRun && app.isPackaged) {
    try {
      const cmdValue = `"${sentinelBin}" "${targetExe}"`;
      execFileSync('reg.exe', ['add', REG_RUN_KEY, '/v', REG_VALUE_NAME, '/t', 'REG_SZ', '/d', cmdValue, '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (err) {
      console.warn('[SentinelManager] Failed to register HKCU Run entry:', err);
    }
  }

  try {
    const child = spawn(sentinelBin, [targetExe], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (err) {
    console.warn('[SentinelManager] Failed to spawn sq-sentinel.exe:', err);
    return false;
  }
}

/**
 * Stops the running `sq-sentinel.exe` process cleanly (used when user disables sentinel or explicitly clicks Quit).
 */
export function stopSentinelProcess(): void {
  try {
    execFileSync('taskkill.exe', ['/IM', 'sq-sentinel.exe', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // Not running — totally fine
  }
}

/**
 * Disables sentinel completely: stops the process AND removes HKCU Run entry.
 */
export function disableSentinel(): void {
  stopSentinelProcess();
  try {
    execFileSync('reg.exe', ['delete', REG_RUN_KEY, '/v', REG_VALUE_NAME, '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch {
    // Key didn't exist — totally fine
  }
}
