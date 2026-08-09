import * as fs from 'fs';
import * as path from 'path';
import chokidar from 'chokidar';
import type { ClaudeStatusLineSnapshot } from '../shared/claudeStatusLine';
import {
  claudeStatusLineFilePath,
  readClaudeStatusLineFile,
} from '../bridge/claudeStatusLineFile';

export type LiveSessionData = ClaudeStatusLineSnapshot;

export class BridgeWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private readonly onData: (data: LiveSessionData) => void;
  private readonly liveSessionFile: string;
  private readonly shouldRead: () => boolean;
  private latestCapturedAt = 0;

  constructor(
    onData: (data: LiveSessionData) => void,
    liveSessionFile = claudeStatusLineFilePath(),
    shouldRead: () => boolean = () => true,
  ) {
    this.onData = onData;
    this.liveSessionFile = liveSessionFile;
    this.shouldRead = shouldRead;
  }

  start() {
    try { fs.mkdirSync(path.dirname(this.liveSessionFile), { recursive: true }); } catch { /* watcher가 재시도하게 둔다. */ }
    this.watcher = chokidar.watch(this.liveSessionFile, {
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
    return this.liveSessionFile;
  }

  private readAndNotify() {
    if (!this.shouldRead()) return;
    const data = readClaudeStatusLineFile(this.liveSessionFile);
    if (!data || data.capturedAt < this.latestCapturedAt) return;
    this.latestCapturedAt = data.capturedAt;
    this.onData(data);
  }
}
