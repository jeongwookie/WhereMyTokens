import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isSafeLocalCwd } from './pathSafety';
import { readJsonlCwd } from './sessionMetadata';
import type { ProviderId } from './providers/types';
import { compareClaudeSessionJsonlNames, isClaudeJsonlName } from './providers/claude/logFiles';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

export function discoverAllProjectCwds(providers: readonly ProviderId[] = ['claude', 'codex']): string[] {
  const cwds = new Set<string>();
  const enabled = new Set(providers);
  if (enabled.has('claude')) addClaudeProjectCwds(cwds);
  if (enabled.has('codex')) addCodexProjectCwds(cwds);

  return [...cwds].filter(cwd => {
    if (!isSafeLocalCwd(cwd)) return false;
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
          .filter(isClaudeJsonlName)
          .sort(compareClaudeSessionJsonlNames);
        if (jsonlFiles.length === 0) continue;
        for (const fileName of jsonlFiles) {
          const cwd = readJsonlCwd(path.join(dirPath, fileName), 'claude');
          if (cwd && isSafeLocalCwd(cwd)) {
            cwds.add(cwd);
            break;
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

function addCodexProjectCwds(cwds: Set<string>): void {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return;
  for (const filePath of listJsonlFiles(CODEX_SESSIONS_DIR)) {
    const cwd = readJsonlCwd(filePath, 'codex');
    if (cwd && isSafeLocalCwd(cwd)) cwds.add(cwd);
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
