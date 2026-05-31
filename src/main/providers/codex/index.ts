import type { SourceBackedProviderAdapter } from '../types';
import { discoverCodexSessions } from './discovery';
import {
  buildStartupCodexSession,
  codexWatchTargets,
  isExcludedCodexSource,
  listAllCodexSources,
  listRecentCodexSources,
  ownsCodexPath,
  readCodexSourceCwd,
  buildCodexLedgerSource,
  scanCodexSourceSummary,
} from './sources';
import { fetchCodexQuota } from './quota';

export const codexProvider: SourceBackedProviderAdapter = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: new Set(['sessions', 'usage', 'quota']),

  async isAvailable() {
    return true;
  },

  discoverSessions: discoverCodexSessions,
  ownsPath: ownsCodexPath,
  listRecentSources: listRecentCodexSources,
  listAllSources: listAllCodexSources,
  scanSourceSummary: scanCodexSourceSummary,
  ledgerSource: buildCodexLedgerSource,
  fetchQuota: fetchCodexQuota,
  buildStartupSession: buildStartupCodexSession,
  readSourceCwd: readCodexSourceCwd,
  watchTargets: codexWatchTargets,
  isExcludedSource: isExcludedCodexSource,
};
