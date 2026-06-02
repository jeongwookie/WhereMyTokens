import { sourceHashForIdentity } from '../../usageLedgerImporter';
import type { AntigravityServerInfo } from './types';

export function antigravityServerOwnerKey(
  server: Pick<AntigravityServerInfo, 'workspaceId' | 'pid' | 'port' | 'processStartedAtMs'>,
): string {
  const raw = server.workspaceId
    ? `workspace:${server.workspaceId}`
    : server.processStartedAtMs != null
      ? `process:${server.pid}:${server.processStartedAtMs}`
      : `endpoint:${server.pid}:${server.port}`;
  return sourceHashForIdentity(`antigravity:${raw}`);
}

export function antigravityCascadeSummaryKey(ownerKey: string, cascadeId: string): string {
  if (ownerKey === 'legacy') return `antigravity:cascade:${cascadeId}`;
  return `antigravity:${ownerKey}:cascade:${cascadeId}`;
}
