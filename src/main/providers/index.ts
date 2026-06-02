export * from './types';
export * from './settings';
export * from './registry';

import { ProviderRegistry } from './registry';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import { antigravityProvider } from './antigravity';

export function createProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(claudeProvider);
  registry.register(codexProvider);
  registry.register(antigravityProvider);
  return registry;
}
