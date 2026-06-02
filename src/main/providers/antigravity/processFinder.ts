import { execFile } from 'child_process';
import { promisify } from 'util';
import * as http from 'http';
import * as https from 'https';
import type { AntigravityServerInfo } from './types';

const execFileAsync = promisify(execFile);

export interface ProcessCandidate {
  pid: number;
  extensionPort: number;
  serverPort: number;
  csrfToken: string;
  workspaceId?: string;
  processStartedAtMs?: number;
}

function processName(): string {
  if (process.platform === 'win32') return 'language_server_windows_x64.exe';
  if (process.platform === 'darwin') return `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`;
  return `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`;
}

async function runPowerShell(script: string, timeout = 15_000): Promise<string> {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

function remainingTimeoutMs(stopAt: number, maxMs: number): number {
  return Math.max(1, Math.min(maxMs, stopAt - Date.now()));
}

function parseJsonArray(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const start = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart) ? arrayStart : objectStart;
  if (start < 0) return [];
  const parsed = JSON.parse(trimmed.slice(start));
  return Array.isArray(parsed) ? parsed : [parsed];
}

function extractFlag(commandLine: string, flag: string): string | null {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = commandLine.match(new RegExp(`${escaped}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s"']+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isAntigravityAppDataDir(value: string | null): boolean {
  if (!value) return false;
  return value
    .split(/[\\/]+/)
    .some(segment => segment.toLowerCase() === 'antigravity');
}

function isAntigravityCommandLine(commandLine: string): boolean {
  return commandLine.includes('--csrf_token')
    && isAntigravityAppDataDir(extractFlag(commandLine, '--app_data_dir'));
}

function creationDateMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseWindowsProcessCandidates(stdout: string): ProcessCandidate[] {
  const rows = parseJsonArray(stdout);
  const candidates: ProcessCandidate[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const commandLine = typeof rec.CommandLine === 'string' ? rec.CommandLine : '';
    const pid = typeof rec.ProcessId === 'number' ? rec.ProcessId : Number(rec.ProcessId);
    if (!pid || !commandLine || !isAntigravityCommandLine(commandLine)) continue;

    const csrfToken = extractFlag(commandLine, '--csrf_token');
    if (!csrfToken) continue;

    candidates.push({
      pid,
      extensionPort: Number(extractFlag(commandLine, '--extension_server_port') ?? 0),
      serverPort: Number(extractFlag(commandLine, '--server_port') ?? 0),
      csrfToken,
      workspaceId: extractFlag(commandLine, '--workspace_id') ?? undefined,
      processStartedAtMs: creationDateMs(rec.CreationDate),
    });
  }

  return candidates;
}

async function findWindowsProcessCandidates(timeoutMs = 15_000): Promise<ProcessCandidate[]> {
  const name = processName();
  const primary = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
    $p = Get-CimInstance Win32_Process -Filter "Name='${name}'" -ErrorAction SilentlyContinue;
    if ($p) { @($p) | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress } else { '[]' }
  `;

  try {
    return parseWindowsProcessCandidates(await runPowerShell(primary, timeoutMs));
  } catch {
    const fallback = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
      $p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'csrf_token' -and $_.CommandLine -match 'antigravity' };
      if ($p) { @($p) | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress } else { '[]' }
    `;
    try {
      return parseWindowsProcessCandidates(await runPowerShell(fallback, timeoutMs));
    } catch {
      return [];
    }
  }
}

async function getListeningPorts(pid: number, timeoutMs = 8_000): Promise<number[]> {
  if (process.platform !== 'win32') return [];
  const script = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
    $p = Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort;
    if ($p) { $p | Sort-Object -Unique }
  `;
  try {
    const stdout = await runPowerShell(script, timeoutMs);
    return stdout.trim().split(/\r?\n/)
      .map(line => Number(line.trim()))
      .filter(port => Number.isInteger(port) && port > 0 && port <= 65535);
  } catch {
    return [];
  }
}

async function testPortWithProtocol(port: number, csrfToken: string, protocol: 'http' | 'https', timeoutMs = 3_000): Promise<boolean> {
  return new Promise(resolve => {
    const lib = protocol === 'https' ? https : http;
    const options: http.RequestOptions & https.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'X-Codeium-Csrf-Token': csrfToken,
      },
      rejectUnauthorized: false,
      timeout: timeoutMs,
    };
    const req = lib.request(options, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          JSON.parse(raw || '{}');
          resolve(true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(JSON.stringify({ wrapper_data: {} }));
    req.end();
  });
}

async function findWorkingPort(candidate: ProcessCandidate, stopAt: number): Promise<number | null> {
  const ports = [
    candidate.extensionPort,
    candidate.serverPort,
    ...(Date.now() >= stopAt ? [] : await getListeningPorts(candidate.pid, remainingTimeoutMs(stopAt, 8_000))),
  ].filter((port, index, arr) => Number.isInteger(port) && port > 0 && arr.indexOf(port) === index);

  for (const port of ports) {
    if (Date.now() >= stopAt) return null;
    if (await testPortWithProtocol(port, candidate.csrfToken, 'http', remainingTimeoutMs(stopAt, 3_000))) return port;
    if (Date.now() >= stopAt) return null;
    if (await testPortWithProtocol(port, candidate.csrfToken, 'https', remainingTimeoutMs(stopAt, 3_000))) return port;
  }
  return null;
}

export async function findAntigravityServersUncached(timeoutMs = 15_000): Promise<AntigravityServerInfo[]> {
  const stopAt = Date.now() + Math.max(1, timeoutMs);
  const candidates = process.platform === 'win32' ? await findWindowsProcessCandidates(remainingTimeoutMs(stopAt, 15_000)) : [];
  const servers: AntigravityServerInfo[] = [];

  for (const candidate of candidates) {
    if (Date.now() >= stopAt) break;
    const port = await findWorkingPort(candidate, stopAt);
    if (!port) continue;
    servers.push({
      pid: candidate.pid,
      port,
      csrfToken: candidate.csrfToken,
      workspaceId: candidate.workspaceId,
      processStartedAtMs: candidate.processStartedAtMs,
    });
  }

  return servers.sort((a, b) => (b.processStartedAtMs ?? 0) - (a.processStartedAtMs ?? 0));
}
