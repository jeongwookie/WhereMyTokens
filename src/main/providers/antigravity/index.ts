import type { ProviderAdapter } from '../types';
import { fetchAntigravityQuota } from './quota';
import { discoverAntigravitySessions } from './sessions';
import { scanAntigravityUsage } from './usage';

export const antigravityProvider: ProviderAdapter = {
  id: 'antigravity',
  displayName: 'Antigravity',
  capabilities: new Set(['sessions', 'usage', 'quota']),

  async isAvailable() {
    return true;
  },

  discoverSessions: discoverAntigravitySessions,
  scanUsage: scanAntigravityUsage,
  fetchQuota: fetchAntigravityQuota,
};
