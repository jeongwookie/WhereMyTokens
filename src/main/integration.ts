import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export type IntegrationOwner = 'wmt' | 'other' | 'none';

export interface IntegrationStatus {
  configured: boolean;
  owner: IntegrationOwner;
  command?: string;
}

export interface IntegrationMutationResult extends IntegrationStatus {
  ok: boolean;
  error?: string;
}

const STATUS_LINE_KEY = 'statusLine';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readSettings(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const parsed = JSON.parse(raw);
  const record = asRecord(parsed);
  if (!record) throw new Error('Claude settings.json must be a JSON object.');
  return record;
}

function writeSettings(settingsPath: string, settings: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

function normalizeCommand(command: string): string {
  return command.replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function buildBridgeCommand(bridgeJs: string): string {
  return `node "${bridgeJs.replace(/\\/g, '\\\\')}"`;
}

export function resolveBridgeScriptPath(
  appPath: string,
  resourcesPath: string,
  isPackaged: boolean,
): string {
  return isPackaged
    ? path.join(resourcesPath, 'bridge', 'bridge.js')
    : path.join(appPath, 'dist', 'bridge', 'bridge.js');
}

export function isWhereMyTokensBridgeCommand(command: string, bridgeJs: string): boolean {
  const normalizedCommand = normalizeCommand(command);
  const expectedCommand = normalizeCommand(buildBridgeCommand(bridgeJs));
  const expectedPath = normalizeCommand(bridgeJs);
  if (normalizedCommand === expectedCommand) return true;
  if (normalizedCommand.includes(expectedPath)) return true;
  return normalizedCommand.includes('wheremytokens')
    && normalizedCommand.includes('/bridge/bridge.js');
}

export function getIntegrationStatus(settingsPath: string, bridgeJs: string): IntegrationStatus {
  try {
    const settings = readSettings(settingsPath);
    if (!Object.prototype.hasOwnProperty.call(settings, STATUS_LINE_KEY)) {
      return { configured: false, owner: 'none' };
    }

    const statusLine = asRecord(settings[STATUS_LINE_KEY]);
    const command = typeof statusLine?.command === 'string' ? statusLine.command : undefined;
    const owner: IntegrationOwner = command && isWhereMyTokensBridgeCommand(command, bridgeJs)
      ? 'wmt'
      : 'other';

    return { configured: owner === 'wmt', owner, command };
  } catch {
    return { configured: false, owner: 'none' };
  }
}

export function setupIntegration(settingsPath: string, bridgeJs: string): IntegrationMutationResult {
  try {
    const settings = readSettings(settingsPath);
    const current = getIntegrationStatus(settingsPath, bridgeJs);
    if (current.owner === 'other') {
      return {
        ok: false,
        ...current,
        error: 'Another statusLine command is already configured. Remove it before setting up WhereMyTokens.',
      };
    }

    const check = spawnSync('node', ['--check', bridgeJs], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (check.error || check.status !== 0) {
      return {
        ok: false,
        configured: current.configured,
        owner: current.owner,
        command: current.command,
        error: 'The Claude statusLine bridge could not be validated. Check that Node.js and the bridge file are available.',
      };
    }

    const command = buildBridgeCommand(bridgeJs);
    settings[STATUS_LINE_KEY] = { type: 'command', command };
    writeSettings(settingsPath, settings);
    return { ok: true, configured: true, owner: 'wmt', command };
  } catch (e) {
    return { ok: false, configured: false, owner: 'none', error: String(e) };
  }
}

export function disableIntegration(settingsPath: string, bridgeJs: string): IntegrationMutationResult {
  try {
    const settings = readSettings(settingsPath);
    const current = getIntegrationStatus(settingsPath, bridgeJs);

    if (current.owner === 'none') {
      return { ok: true, configured: false, owner: 'none' };
    }

    if (current.owner === 'other') {
      return {
        ok: false,
        ...current,
        error: 'Another statusLine command is configured. WhereMyTokens did not change it.',
      };
    }

    delete settings[STATUS_LINE_KEY];
    writeSettings(settingsPath, settings);
    return { ok: true, configured: false, owner: 'none' };
  } catch (e) {
    return { ok: false, configured: false, owner: 'none', error: String(e) };
  }
}
