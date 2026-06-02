import type {
  AntigravityServerInfo,
  AntigravityTrajectorySummariesResponse,
  AntigravityUserStatusResponse,
} from './types';
import { findAntigravityServersUncached } from './processFinder';
import { AntigravityLsClient } from './lsClient';

const SERVER_TTL_MS = 10_000;
const TRAJECTORY_TTL_MS = 10_000;
const USER_STATUS_TTL_MS = 10_000;

let cachedServers: { at: number; value: AntigravityServerInfo[] } | null = null;
const trajectoryCache = new Map<string, { at: number; value: AntigravityTrajectorySummariesResponse }>();
const userStatusCache = new Map<string, { at: number; value: AntigravityUserStatusResponse }>();

function serverKey(server: AntigravityServerInfo): string {
  return `${server.pid}:${server.port}:${server.workspaceId ?? ''}`;
}

export async function findAntigravityServersCached(nowMs = Date.now(), timeoutMs = 15_000): Promise<AntigravityServerInfo[]> {
  if (cachedServers && nowMs - cachedServers.at < SERVER_TTL_MS) return cachedServers.value;
  const value = await findAntigravityServersUncached(timeoutMs);
  cachedServers = { at: nowMs, value };
  return value;
}

export async function getUserStatusCached(
  server: AntigravityServerInfo,
  nowMs = Date.now(),
  timeoutMs = 6_000,
): Promise<AntigravityUserStatusResponse> {
  const key = serverKey(server);
  const cached = userStatusCache.get(key);
  if (cached && nowMs - cached.at < USER_STATUS_TTL_MS) return cached.value;
  const value = await new AntigravityLsClient(server).getUserStatus(timeoutMs);
  userStatusCache.set(key, { at: nowMs, value });
  return value;
}

export async function getTrajectorySummariesCached(
  server: AntigravityServerInfo,
  nowMs = Date.now(),
  timeoutMs = 6_000,
): Promise<AntigravityTrajectorySummariesResponse | null> {
  const key = serverKey(server);
  const cached = trajectoryCache.get(key);
  if (cached && nowMs - cached.at < TRAJECTORY_TTL_MS) return cached.value;

  try {
    const value = await new AntigravityLsClient(server).getAllCascadeTrajectories(timeoutMs);
    trajectoryCache.set(key, { at: nowMs, value });
    return value;
  } catch {
    return null;
  }
}
