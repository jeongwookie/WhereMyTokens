import * as fs from 'fs';
import { isSafeLocalCwd } from './pathSafety';
import { readJsonlCwdForSource } from './sessionMetadata';
import type { ProviderId } from './providers/types';
import { getUsageLogSources, joinLogPath, type UsageLogSource } from './wslPaths';

export function discoverAllProjectCwds(providers: readonly ProviderId[] = ['claude', 'codex'], enableWslTracking = false): string[] {
  const cwds = new Set<string>();
  const enabled = new Set(providers);
  for (const source of getUsageLogSources(enableWslTracking)) {
    if (enabled.has('claude')) addClaudeProjectCwds(cwds, source);
    if (enabled.has('codex')) addCodexProjectCwds(cwds, source);
  }

  return [...cwds].filter(cwd => {
    if (!isSafeLocalCwd(cwd)) return false;
    try { return fs.statSync(cwd).isDirectory(); } catch { return false; }
  });
}

function addClaudeProjectCwds(cwds: Set<string>, source: UsageLogSource): void {
  if (!fs.existsSync(source.claudeProjectsDir)) return;
  try {
    const dirs = fs.readdirSync(source.claudeProjectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of dirs) {
      const dirPath = joinLogPath(source, source.claudeProjectsDir, dir.name);
      try {
        const jsonlFiles = fs.readdirSync(dirPath)
          .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
        if (jsonlFiles.length === 0) continue;
        const cwd = readJsonlCwdForSource(joinLogPath(source, dirPath, jsonlFiles[0]), 'claude', source);
        if (cwd && isSafeLocalCwd(cwd)) cwds.add(cwd);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

function addCodexProjectCwds(cwds: Set<string>, source: UsageLogSource): void {
  if (!fs.existsSync(source.codexSessionsDir)) return;
  for (const filePath of listJsonlFiles(source.codexSessionsDir, source)) {
    const cwd = readJsonlCwdForSource(filePath, 'codex', source);
    if (cwd && isSafeLocalCwd(cwd)) cwds.add(cwd);
  }
}

function listJsonlFiles(dir: string, source: UsageLogSource): string[] {
  const files: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = joinLogPath(source, dir, entry.name);
      if (entry.isDirectory()) files.push(...listJsonlFiles(fullPath, source));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(fullPath);
    }
  } catch { /* skip */ }
  return files;
}
