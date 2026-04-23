import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSafeLocalCwd } from './pathSafety';

export type LogSourceKind = 'windows' | 'wsl';

export interface UsageLogSource {
  id: string;
  label: string;
  kind: LogSourceKind;
  claudeSessionsDir: string;
  claudeProjectsDir: string;
  codexSessionsDir: string;
  distro?: string;
  linuxHome?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedWslSources: { ts: number; sources: UsageLogSource[] } | null = null;
let pendingWslRefresh: Promise<UsageLogSource[]> | null = null;

function windowsSource(): UsageLogSource {
  const home = os.homedir();
  return {
    id: 'windows',
    label: 'Windows',
    kind: 'windows',
    claudeSessionsDir: path.join(home, '.claude', 'sessions'),
    claudeProjectsDir: path.join(home, '.claude', 'projects'),
    codexSessionsDir: path.join(home, '.codex', 'sessions'),
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

function uncPath(prefix: string, distro: string, linuxPath: string): string {
  const parts = normalizeLinuxPath(linuxPath).split('/').filter(Boolean);
  return path.win32.join(prefix, distro, ...parts);
}

function pickWslHomePath(distro: string, linuxHome: string): string {
  const localhost = uncPath('\\\\wsl.localhost', distro, linuxHome);
  if (fs.existsSync(localhost)) return localhost;
  return uncPath('\\\\wsl$', distro, linuxHome);
}

function buildWslSource(distro: string, linuxHome: string): UsageLogSource {
  const home = pickWslHomePath(distro, linuxHome);
  return {
    id: `wsl:${distro}`,
    label: `WSL ${distro}`,
    kind: 'wsl',
    distro,
    linuxHome,
    claudeSessionsDir: path.win32.join(home, '.claude', 'sessions'),
    claudeProjectsDir: path.win32.join(home, '.claude', 'projects'),
    codexSessionsDir: path.win32.join(home, '.codex', 'sessions'),
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

export function mapCwdForSource(source: UsageLogSource, cwd: string): string | null {
  if (!cwd || cwd.includes('\0')) return null;

  if (source.kind === 'windows') {
    return isSafeLocalCwd(cwd) ? cwd : null;
  }

  const normalized = normalizeLinuxPath(cwd);
  if (!normalized || !source.distro) return null;

  const mountedDrive = normalized.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (mountedDrive) {
    const drive = mountedDrive[1].toUpperCase();
    const rest = (mountedDrive[2] ?? '').split('/').filter(Boolean);
    const windowsPath = path.win32.join(`${drive}:\\`, ...rest);
    return isSafeLocalCwd(windowsPath) ? windowsPath : null;
  }

  const homeRoot = path.win32.dirname(source.claudeProjectsDir).replace(/\\\.claude$/, '');
  const root = homeRoot.endsWith('\\') ? homeRoot.slice(0, -1) : homeRoot;
  const parts = normalized.split('/').filter(Boolean);
  const unc = path.win32.join(root.split('\\').slice(0, 4).join('\\'), ...parts);
  return isSafeLocalCwd(unc) ? unc : null;
}

export function sourceLabel(source: UsageLogSource, base: string): string {
  return source.kind === 'wsl' ? `${source.label} - ${base}` : base;
}
