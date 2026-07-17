import * as crypto from 'crypto';
import type { AntigravityServerInfo } from './types';

export function antigravityServerOwnerKey(
  server: Pick<AntigravityServerInfo, 'workspaceId' | 'pid' | 'port' | 'processStartedAtMs'>,
): string {
  const raw = server.workspaceId
    ? `workspace:${server.workspaceId}`
    : server.processStartedAtMs != null
      ? `process:${server.pid}:${server.processStartedAtMs}`
      : `endpoint:${server.pid}:${server.port}`;
  return crypto.createHash('sha256').update(`antigravity:${raw}`).digest('base64url');
}

export function antigravityCascadeSummaryKey(ownerKey: string, cascadeId: string): string {
  if (ownerKey === 'legacy') return `antigravity:cascade:${cascadeId}`;
  return `antigravity:${ownerKey}:cascade:${cascadeId}`;
}
