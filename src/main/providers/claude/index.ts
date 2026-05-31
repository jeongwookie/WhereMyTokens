import type { SourceBackedProviderAdapter } from '../types';
import { discoverClaudeSessions } from './discovery';
import {
  buildStartupClaudeSession,
  claudeWatchTargets,
  isExcludedClaudeSource,
  listAllClaudeSources,
  listRecentClaudeSources,
  ownsClaudePath,
  readClaudeSourceCwd,
  buildClaudeLedgerSource,
  scanClaudeSourceSummary,
} from './sources';
import { fetchClaudeQuota } from './quota';

export const claudeProvider: SourceBackedProviderAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: new Set(['sessions', 'usage', 'quota']),

  async isAvailable() {
    return true;
  },

  discoverSessions: discoverClaudeSessions,
  ownsPath: ownsClaudePath,
  listRecentSources: listRecentClaudeSources,
  listAllSources: listAllClaudeSources,
  scanSourceSummary: scanClaudeSourceSummary,
  ledgerSource: buildClaudeLedgerSource,
  fetchQuota: fetchClaudeQuota,
  buildStartupSession: buildStartupClaudeSession,
  readSourceCwd: readClaudeSourceCwd,
  watchTargets: claudeWatchTargets,
  isExcludedSource: isExcludedClaudeSource,
};
