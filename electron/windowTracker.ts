import { ChildProcess, spawn } from 'child_process';
import { screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentId } from './providers/types';

export type RealAgentId = Exclude<AgentId, 'simulated'>;

export interface WindowTrackerSnapshot {
  /** Which Agent currently owns the foreground window ('self' = StockingQuota itself, '' = other app) */
  fgAgent: RealAgentId | 'self' | '';
  /** Last real Agent that was active (kept while user interacts with StockingQuota overlay) */
  activeHostAgent: RealAgentId | null;
  /** Host window rectangle in Electron DIP coordinates (multi-monitor / 125%-150% DPI normalized) */
  hostRectDip: Electron.Rectangle | null;
  antigravityModelButtonDip: Electron.Rectangle | null;
  antigravityModelMenuOpen: boolean;
  /** Live UIA bounds of Codex's bottom-left circular quota button (immune to sidebar toggle/resize!) */
  codexQuotaButtonDip: Electron.Rectangle | null;
  /** True when Codex's UIA button tree is active (distinguishes "sidebar collapsed" from "UIA not loaded yet") */
  codexUiaReady: boolean;
  codexMenuOpen: boolean;
  /** Currently running Agent processes on this Windows PC */
  runningAgents: RealAgentId[];
}

type TrackerListener = (snap: WindowTrackerSnapshot) => void;

export class WinForegroundTracker {
  private readonly appRoot: string;
  private child: ChildProcess | null = null;
  private listeners = new Set<TrackerListener>();
  private modelMouseDownListeners = new Set<(point: Electron.Point) => void>();
  private codexMouseDownListeners = new Set<(point: Electron.Point) => void>();
  private stdoutBuf = '';

  private snapshot: WindowTrackerSnapshot = {
    fgAgent: '',
    activeHostAgent: null,
    hostRectDip: null,
    antigravityModelButtonDip: null,
    antigravityModelMenuOpen: false,
    codexQuotaButtonDip: null,
    codexUiaReady: false,
    codexMenuOpen: false,
    runningAgents: [],
  };

  constructor(appRoot: string) {
    this.appRoot = appRoot;
  }

  private resolveBinaryPath(): string | null {
    const candidates = [
      path.join(this.appRoot, 'vendor', 'win-tracker', 'sq-wintracker.exe').replace('app.asar', 'app.asar.unpacked'),
      path.join(this.appRoot, 'vendor', 'win-tracker', 'sq-wintracker.exe'),
      path.join(process.cwd(), 'vendor', 'win-tracker', 'sq-wintracker.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  public start(): void {
    if (this.child) return;
    const bin = this.resolveBinaryPath();
    if (!bin) {
      console.warn('[WindowTracker] sq-wintracker.exe not found; host-anchor tracking disabled');
      return;
    }

    try {
      this.child = spawn(bin, [], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });

      this.child.stdout?.setEncoding('utf8');
      this.child.stdout?.on('data', (chunk: string) => {
        this.stdoutBuf += chunk;
        let idx = this.stdoutBuf.indexOf('\n');
        while (idx !== -1) {
          const line = this.stdoutBuf.slice(0, idx).trim();
          this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
          if (line) this.handleLine(line);
          idx = this.stdoutBuf.indexOf('\n');
        }
      });

      this.child.on('exit', () => {
        this.child = null;
      });
    } catch (err) {
      console.warn('[WindowTracker] Failed to launch tracker:', err);
      this.child = null;
    }
  }

  public stop(): void {
    if (!this.child) return;
    try {
      this.child.stdin?.end();
      this.child.kill();
    } catch {
      // ignore
    }
    this.child = null;
  }

  public getSnapshot(): WindowTrackerSnapshot {
    return {
      ...this.snapshot,
      hostRectDip: this.snapshot.hostRectDip ? { ...this.snapshot.hostRectDip } : null,
      antigravityModelButtonDip: this.snapshot.antigravityModelButtonDip
        ? { ...this.snapshot.antigravityModelButtonDip }
        : null,
      codexQuotaButtonDip: this.snapshot.codexQuotaButtonDip ? { ...this.snapshot.codexQuotaButtonDip } : null,
      runningAgents: [...this.snapshot.runningAgents],
    };
  }

  public subscribe(listener: TrackerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onModelMouseDown(listener: (point: Electron.Point) => void): void {
    this.modelMouseDownListeners.add(listener);
  }

  public onCodexMouseDown(listener: (point: Electron.Point) => void): void {
    this.codexMouseDownListeners.add(listener);
  }

  private handleLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as {
        fgAgent?: string;
        rect?: Electron.Rectangle | null;
        modelButton?: Electron.Rectangle | null;
        modelMenuOpen?: boolean;
        modelMouseDown?: Electron.Point;
        codexButton?: Electron.Rectangle | null;
        codexUiaReady?: boolean;
        codexMenuOpen?: boolean;
        codexMouseDown?: Electron.Point;
        running?: string[];
      };

      if (parsed.modelMouseDown) {
        const point = screen.screenToDipPoint(parsed.modelMouseDown);
        for (const cb of this.modelMouseDownListeners) cb(point);
        return;
      }

      if (parsed.codexMouseDown) {
        const point = screen.screenToDipPoint(parsed.codexMouseDown);
        for (const cb of this.codexMouseDownListeners) cb(point);
        return;
      }

      const rawFg = parsed.fgAgent ?? '';
      const fgAgent: WindowTrackerSnapshot['fgAgent'] =
        rawFg === 'codex' || rawFg === 'antigravity' || rawFg === 'dsh' || rawFg === 'self' ? rawFg : '';

      const runningAgents: RealAgentId[] = Array.isArray(parsed.running)
        ? parsed.running.filter((a): a is RealAgentId => a === 'codex' || a === 'antigravity' || a === 'dsh')
        : [];

      let activeHostAgent = this.snapshot.activeHostAgent;
      let hostRectDip = this.snapshot.hostRectDip;
      let antigravityModelButtonDip = this.snapshot.antigravityModelButtonDip;
      let codexQuotaButtonDip = this.snapshot.codexQuotaButtonDip;
      let codexUiaReady = this.snapshot.codexUiaReady;

      if (fgAgent === 'codex' || fgAgent === 'antigravity' || fgAgent === 'dsh') {
        activeHostAgent = fgAgent;
        antigravityModelButtonDip =
          fgAgent === 'antigravity' && parsed.modelButton ? screen.screenToDipRect(null, parsed.modelButton) : null;
        codexQuotaButtonDip =
          fgAgent === 'codex' && parsed.codexButton ? screen.screenToDipRect(null, parsed.codexButton) : null;
        codexUiaReady = fgAgent === 'codex' && parsed.codexUiaReady === true;

        if (parsed.rect && parsed.rect.width > 80 && parsed.rect.height > 80) {
          try {
            hostRectDip = screen.screenToDipRect(null, parsed.rect);
          } catch {
            hostRectDip = parsed.rect;
          }
        }
      } else if (fgAgent === 'self') {
        // User clicked/hovered our own StockingQuota overlay — keep remembering the active host window behind it!
        if (activeHostAgent && !runningAgents.includes(activeHostAgent)) {
          activeHostAgent = null;
          hostRectDip = null;
          antigravityModelButtonDip = null;
          codexQuotaButtonDip = null;
          codexUiaReady = false;
        }
      } else {
        // User switched to a completely unrelated window (e.g. browser, game, explorer)
        activeHostAgent = null;
        hostRectDip = null;
        antigravityModelButtonDip = null;
        codexQuotaButtonDip = null;
        codexUiaReady = false;
      }

      this.snapshot = {
        fgAgent,
        activeHostAgent,
        hostRectDip,
        antigravityModelButtonDip,
        antigravityModelMenuOpen: fgAgent === 'antigravity' && parsed.modelMenuOpen === true,
        codexQuotaButtonDip,
        codexUiaReady,
        codexMenuOpen: fgAgent === 'codex' && parsed.codexMenuOpen === true,
        runningAgents,
      };

      const copy = this.getSnapshot();
      for (const cb of this.listeners) cb(copy);
    } catch {
      // ignore malformed line
    }
  }
}
