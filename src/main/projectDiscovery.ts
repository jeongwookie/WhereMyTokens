import * as fs from 'fs';
import * as path from 'path';
import { TrackingProvider } from './sessionDiscovery';
import { isSafeLocalCwd } from './pathSafety';
import { readJsonlCwd } from './sessionMetadata';
import { getUsageLogSources, UsageLogSource } from './wslPaths';

export function discoverAllProjectCwds(provider: TrackingProvider = 'both', enableWslTracking = false): string[] {
  const cwds = new Set<string>();
  for (const source of getUsageLogSources(enableWslTracking)) {
    if (provider === 'claude' || provider === 'both') addClaudeProjectCwds(cwds, source);
    if (provider === 'codex' || provider === 'both') addCodexProjectCwds(cwds, source);
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
      const dirPath = `${source.claudeProjectsDir}\\${dir.name}`;
      try {
        const jsonlFiles = fs.readdirSync(dirPath)
          .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
        if (jsonlFiles.length === 0) continue;
        const cwd = readJsonlCwd(`${dirPath}\\${jsonlFiles[0]}`, 'claude', source);
        if (cwd && isSafeLocalCwd(cwd)) cwds.add(cwd);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

function addCodexProjectCwds(cwds: Set<string>, source: UsageLogSource): void {
  if (!fs.existsSync(source.codexSessionsDir)) return;
  for (const filePath of listJsonlFiles(source.codexSessionsDir)) {
    const cwd = readJsonlCwd(filePath, 'codex', source);
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
