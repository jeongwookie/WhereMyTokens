import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSafeLocalCwd } from './pathSafety';
import type { ProviderId } from './providers/types';

export type LogSourceKind = 'windows' | 'wsl';

export interface UsageLogSource {
  id: string;
  label: string;
  kind: LogSourceKind;
  rootDir: string;
  homeDir: string;
  claudeSessionsDir: string;
  claudeProjectsDir: string;
  codexHomeDir: string;
  codexSessionsDir: string;
  codexArchivedSessionsDir: string;
  codexSessionCleanupArchiveDir: string;
  codexUsageDirs: readonly string[];
  distro?: string;
  linuxHome?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedWslSources: { ts: number; sources: UsageLogSource[] } | null = null;
let pendingWslRefresh: Promise<UsageLogSource[]> | null = null;

function windowsSource(): UsageLogSource {
  const home = os.homedir();
  const codexHomeDir = path.join(home, '.codex');
  const codexSessionsDir = path.join(codexHomeDir, 'sessions');
  const codexArchivedSessionsDir = path.join(codexHomeDir, 'archived_sessions');
  const codexSessionCleanupArchiveDir = path.join(codexHomeDir, 'session-cleanup-archive');
  return {
    id: 'windows',
    label: 'Windows',
    kind: 'windows',
    rootDir: path.parse(home).root || home,
    homeDir: home,
    claudeSessionsDir: path.join(home, '.claude', 'sessions'),
    claudeProjectsDir: path.join(home, '.claude', 'projects'),
    codexHomeDir,
    codexSessionsDir,
    codexArchivedSessionsDir,
    codexSessionCleanupArchiveDir,
    codexUsageDirs: [
      codexSessionsDir,
      codexArchivedSessionsDir,
      codexSessionCleanupArchiveDir,
    ],
  };
}

function decodeWslOutput(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8');
  const nulCount = (utf8.match(/\0/g) ?? []).length;
  const decoded = nulCount > Math.max(1, utf8.length / 8)
    ? buffer.toString('utf16le')
    : utf8;
  return decoded.replace(/\0/g, '').replace(/\r/g, '').trim();
}

function runWsl(args: string[], timeout = 2500): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('wsl.exe', args, {
      encoding: 'buffer',
      timeout,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const text = decodeWslOutput(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''));
      resolve(text || null);
    });
  });
}

function cleanDistroName(value: string): string | null {
  const name = value.trim();
  if (!name || name.includes('\\') || name.includes('/')) return null;
  return name;
}

function isUserDistro(name: string): boolean {
  const lower = name.toLowerCase();
  return lower !== 'docker-desktop' && lower !== 'docker-desktop-data';
}

async function listWslDistros(): Promise<string[]> {
  const output = await runWsl(['--list', '--quiet']);
  if (!output) return [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const distro = cleanDistroName(line);
    if (distro && isUserDistro(distro)) seen.add(distro);
  }
  return [...seen];
}

function normalizeLinuxPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return '';
  return trimmed.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

async function getWslHome(distro: string): Promise<string | null> {
  const home = await runWsl(['-d', distro, 'sh', '-lc', 'printf %s "$HOME"']);
  if (!home) return null;
  return normalizeLinuxPath(home);
}

function uncPath(prefix: string, distro: string, linuxPath = '/'): string {
  const parts = normalizeLinuxPath(linuxPath).split('/').filter(Boolean);
  return path.win32.join(prefix, distro, ...parts);
}

function pickWslRootDir(distro: string): string {
  const localhost = uncPath('\\\\wsl.localhost', distro);
  if (fs.existsSync(localhost)) return localhost;
  return uncPath('\\\\wsl$', distro);
}

function buildWslSource(distro: string, linuxHome: string): UsageLogSource {
  const rootDir = pickWslRootDir(distro);
  const homeDir = path.win32.join(rootDir, ...normalizeLinuxPath(linuxHome).split('/').filter(Boolean));
  const codexHomeDir = path.win32.join(homeDir, '.codex');
  const codexSessionsDir = path.win32.join(codexHomeDir, 'sessions');
  const codexArchivedSessionsDir = path.win32.join(codexHomeDir, 'archived_sessions');
  const codexSessionCleanupArchiveDir = path.win32.join(codexHomeDir, 'session-cleanup-archive');
  return {
    id: `wsl:${distro}`,
    label: `WSL ${distro}`,
    kind: 'wsl',
    rootDir,
    homeDir,
    distro,
    linuxHome,
    claudeSessionsDir: path.win32.join(homeDir, '.claude', 'sessions'),
    claudeProjectsDir: path.win32.join(homeDir, '.claude', 'projects'),
    codexHomeDir,
    codexSessionsDir,
    codexArchivedSessionsDir,
    codexSessionCleanupArchiveDir,
    codexUsageDirs: [
      codexSessionsDir,
      codexArchivedSessionsDir,
      codexSessionCleanupArchiveDir,
    ],
  };
}

async function discoverWslSources(force = false): Promise<UsageLogSource[]> {
  const now = Date.now();
  if (!force && cachedWslSources && now - cachedWslSources.ts < CACHE_TTL_MS) {
    return cachedWslSources.sources;
  }

  const sources: UsageLogSource[] = [];
  for (const distro of await listWslDistros()) {
    const linuxHome = await getWslHome(distro);
    if (!linuxHome) continue;
    sources.push(buildWslSource(distro, linuxHome));
  }

  cachedWslSources = { ts: now, sources };
  return sources;
}

export function getUsageLogSources(enableWslTracking = false): UsageLogSource[] {
  const sources = [windowsSource()];
  if (enableWslTracking && cachedWslSources) sources.push(...cachedWslSources.sources);
  return sources;
}

export async function refreshUsageLogSources(enableWslTracking = false, force = false): Promise<UsageLogSource[]> {
  if (!enableWslTracking) return getUsageLogSources(false);
  if (!force && pendingWslRefresh) {
    const sources = await pendingWslRefresh;
    return [windowsSource(), ...sources];
  }

  pendingWslRefresh = discoverWslSources(force).finally(() => {
    pendingWslRefresh = null;
  });
  const sources = await pendingWslRefresh;
  return [windowsSource(), ...sources];
}

function comparablePath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  const parent = comparablePath(parentPath);
  const child = comparablePath(childPath);
  return child === parent || child.startsWith(`${parent}\\`);
}

function rootsForProvider(source: UsageLogSource, provider: ProviderId): readonly string[] {
  if (provider === 'claude') return [source.claudeProjectsDir];
  if (provider === 'codex') return source.codexUsageDirs;
  return [];
}

function isWindowsDriveCwd(value: string): boolean {
  return /^[a-z]:\\/i.test(value) && !value.includes('\0');
}

export function findUsageLogSourceForPath(
  provider: ProviderId,
  filePath: string,
  enableWslTracking = false,
): UsageLogSource | undefined {
  return getUsageLogSources(enableWslTracking).find(source =>
    rootsForProvider(source, provider).some(root => isSameOrChildPath(root, filePath))
  );
}

export function joinLogPath(source: UsageLogSource | undefined, basePath: string, ...parts: string[]): string {
  return source?.kind === 'wsl'
    ? path.win32.join(basePath, ...parts)
    : path.join(basePath, ...parts);
}

export function basenameForLogPath(value: string): string {
  return value.includes('\\') ? path.win32.basename(value) : path.basename(value);
}

export function mapCwdForSource(source: UsageLogSource | undefined, cwd: string): string | null {
  if (!cwd || cwd.includes('\0')) return null;
  if (!source || source.kind === 'windows') return isSafeLocalCwd(cwd) ? cwd : null;

  const normalized = normalizeLinuxPath(cwd);
  if (!normalized) return null;

  const mountedDrive = normalized.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (mountedDrive) {
    const drive = mountedDrive[1].toUpperCase();
    const rest = (mountedDrive[2] ?? '').split('/').filter(Boolean);
    const windowsPath = path.win32.join(`${drive}:\\`, ...rest);
    return isWindowsDriveCwd(windowsPath) ? windowsPath : null;
  }

  const parts = normalized.split('/').filter(Boolean);
  const unc = path.win32.join(source.rootDir, ...parts);
  return isSafeLocalCwd(unc) ? unc : null;
}

export function sourceLabel(source: UsageLogSource | undefined, base: string): string {
  return source?.kind === 'wsl' ? `${source.label} - ${base}` : base;
}
