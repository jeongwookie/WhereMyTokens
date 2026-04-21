import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TrackingProvider } from './sessionDiscovery';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

export function discoverAllProjectCwds(provider: TrackingProvider = 'both'): string[] {
  const cwds = new Set<string>();
  if (provider === 'claude' || provider === 'both') addClaudeProjectCwds(cwds);
  if (provider === 'codex' || provider === 'both') addCodexProjectCwds(cwds);

  return [...cwds].filter(cwd => {
    try { return fs.statSync(cwd).isDirectory(); } catch { return false; }
  });
}

function addClaudeProjectCwds(cwds: Set<string>): void {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of dirs) {
      const dirPath = path.join(PROJECTS_DIR, dir.name);
      try {
        const jsonlFiles = fs.readdirSync(dirPath)
          .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
        if (jsonlFiles.length === 0) continue;
        const cwd = extractCwdFromClaudeJsonl(path.join(dirPath, jsonlFiles[0]));
        if (cwd) cwds.add(cwd);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

function addCodexProjectCwds(cwds: Set<string>): void {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return;
  for (const filePath of listJsonlFiles(CODEX_SESSIONS_DIR)) {
    const cwd = extractCwdFromCodexJsonl(filePath);
    if (cwd) cwds.add(cwd);
  }
}

function listJsonlFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...listJsonlFiles(fullPath));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  } catch { /* skip */ }
  return files;
}

function extractCwdFromClaudeJsonl(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, bytesRead).toString('utf-8').split('\n').slice(0, 8)) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (typeof data.cwd === 'string' && data.cwd) return data.cwd;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}

function extractCwdFromCodexJsonl(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, bytesRead).toString('utf-8').split('\n').slice(0, 12)) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.type === 'session_meta' && typeof data.payload?.cwd === 'string') return data.payload.cwd;
        if (data.type === 'turn_context' && typeof data.payload?.cwd === 'string') return data.payload.cwd;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}
