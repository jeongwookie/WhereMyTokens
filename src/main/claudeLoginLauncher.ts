import { spawn, type SpawnOptions } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ClaudeLoginLaunchResult } from '../shared/claudeLogin';

const CLAUDE_COMMAND_NAMES = ['claude.exe', 'claude.cmd'] as const;
const WINDOWS_TERMINAL_NAME = 'wt.exe';
const CLAUDE_NPM_EXE_SEGMENTS = ['npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'] as const;

type FileExists = (filePath: string) => boolean;

function pathCandidates(fileNames: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const directories = (env.PATH ?? '')
    .split(path.delimiter)
    .map(directory => directory.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  return directories.flatMap(directory => fileNames.map(fileName => path.join(directory, fileName)));
}

export function resolveClaudeCommand(
  env: NodeJS.ProcessEnv = process.env,
  exists: FileExists = fs.existsSync,
): string | null {
  const candidates = [
    ...(env.APPDATA ? [
      path.join(env.APPDATA, ...CLAUDE_NPM_EXE_SEGMENTS),
      path.join(env.APPDATA, 'npm', 'claude.cmd'),
    ] : []),
    ...pathCandidates(CLAUDE_COMMAND_NAMES, env),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
  ];
  return candidates.find(candidate => exists(candidate)) ?? null;
}

export function resolveWindowsTerminal(
  env: NodeJS.ProcessEnv = process.env,
  exists: FileExists = fs.existsSync,
): string | null {
  const pathMatch = pathCandidates([WINDOWS_TERMINAL_NAME], env).find(candidate => exists(candidate));
  if (pathMatch) return pathMatch;
  // Windows App Execution Alias는 PowerShell에서는 보이지만 Node fs.existsSync에는 안 잡힐 수 있다.
  return env.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', WINDOWS_TERMINAL_NAME)
    : null;
}

export interface ClaudeLoginLaunchSpec {
  file: string;
  args: string[];
  options: SpawnOptions;
}

function encodedPowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function buildClaudeLoginLaunchSpec(
  claudeCommand: string,
  windowsTerminal: string | null,
): ClaudeLoginLaunchSpec {
  const options: SpawnOptions = {
    cwd: os.homedir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  };
  if (windowsTerminal) {
    const escapedCommand = claudeCommand.replace(/'/g, "''");
    const commandArgs = path.extname(claudeCommand).toLowerCase() === '.cmd'
      ? [
        process.env.SystemRoot
          ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : 'powershell.exe',
        '-NoExit',
        '-NoProfile',
        '-EncodedCommand',
        encodedPowerShellCommand(`$command = '${escapedCommand}'; & $command 'auth' 'login'`),
      ]
      : [claudeCommand, 'auth', 'login'];
    return {
      file: windowsTerminal,
      args: ['-w', 'new', 'new-tab', '--title', 'Claude Code login', ...commandArgs],
      options,
    };
  }
  const escapedCommand = claudeCommand.replace(/'/g, "''");
  const script = path.extname(claudeCommand).toLowerCase() === '.cmd'
    ? `$command = '${escapedCommand}'; Start-Process -FilePath $env:COMSPEC -ArgumentList @('/d', '/k', ('"' + $command + '" auth login')) -WindowStyle Normal`
    : `Start-Process -FilePath '${escapedCommand}' -ArgumentList @('auth', 'login') -WindowStyle Normal`;
  return {
    file: process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShellCommand(script)],
    options: { ...options, windowsHide: true },
  };
}

function spawnLaunchSpec(spec: ClaudeLoginLaunchSpec): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      const child = spawn(spec.file, spec.args, spec.options);
      child.once('spawn', () => {
        child.unref();
        finish(true);
      });
      child.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

export async function launchClaudeLogin(): Promise<ClaudeLoginLaunchResult> {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' };
  const claudeCommand = resolveClaudeCommand();
  if (!claudeCommand) return { ok: false, reason: 'claude-not-found' };
  const windowsTerminal = resolveWindowsTerminal();
  if (windowsTerminal && await spawnLaunchSpec(buildClaudeLoginLaunchSpec(claudeCommand, windowsTerminal))) {
    return { ok: true };
  }
  if (await spawnLaunchSpec(buildClaudeLoginLaunchSpec(claudeCommand, null))) return { ok: true };
  return { ok: false, reason: 'launch-failed' };
}
