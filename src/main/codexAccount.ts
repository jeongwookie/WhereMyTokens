import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CodexAccountState {
  serviceTier: string | null;
}

const CODEX_GLOBAL_STATE_PATH = path.join(os.homedir(), '.codex', '.codex-global-state.json');

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function readCodexAccountState(): CodexAccountState {
  try {
    const raw = JSON.parse(fs.readFileSync(CODEX_GLOBAL_STATE_PATH, 'utf-8')) as Record<string, unknown>;
    const atomState = asRecord(raw['electron-persisted-atom-state']);
    const serviceTier = typeof atomState?.['default-service-tier'] === 'string'
      ? atomState['default-service-tier']
      : null;
    return { serviceTier };
  } catch {
    return { serviceTier: null };
  }
}
