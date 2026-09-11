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
  return `antigravity:${ownerKey}:cascade:${cascadeId}`;
}

/** Persistent usage scope. Connection/process identity must never become ledger identity. */
export function antigravityUsageOwnerKey(email: string | undefined): string {
  const normalized = email?.trim().toLowerCase() ?? '';
  if (!normalized || !normalized.includes('@')) return 'unknown';
  return crypto.createHash('sha256').update(`antigravity-account:${normalized}`).digest('base64url');
}
