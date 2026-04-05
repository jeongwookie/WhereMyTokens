/**
 * Claude Code statusLine bridge file watcher
 * Calls callback when live-session.json changes
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chokidar from 'chokidar';

export interface LiveSessionData {
  rate_limits?: {
    five_hour?: { used_percentage: number; resets_at: number };
    seven_day?:  { used_percentage: number; resets_at: number };
  };
  context_window?: {
    used_percentage: number;
    total_input_tokens: number;
  };
  model?: { id: string; display_name: string };
  cost?:  { total_cost_usd: number };
  _ts?: number;
}

const LIVE_SESSION_FILE = path.join(
  os.homedir(), 'AppData', 'Roaming', 'WhereMyTokens', 'live-session.json'
);

export class BridgeWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private onData: (data: LiveSessionData) => void;

  constructor(onData: (data: LiveSessionData) => void) {
    this.onData = onData;
  }

  start() {
    // Start watcher even if file doesn't exist yet (will detect when created)
    const dir = path.dirname(LIVE_SESSION_FILE);
    try { require('fs').mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

    this.watcher = chokidar.watch(LIVE_SESSION_FILE, {
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    this.watcher.on('add', () => this.readAndNotify());
    this.watcher.on('change', () => this.readAndNotify());
  }

  stop() {
    this.watcher?.close();
  }

  getLiveSessionFile(): string {
    return LIVE_SESSION_FILE;
  }

  private readAndNotify() {
    try {
      const raw = fs.readFileSync(LIVE_SESSION_FILE, 'utf-8');
      const data = JSON.parse(raw) as LiveSessionData;
      this.onData(data);
    } catch { /* ignore read failures */ }
  }
}
