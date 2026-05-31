import * as os from 'os';
import * as path from 'path';

const CODEX_HOME_DIR = path.join(os.homedir(), '.codex');

export const CODEX_SESSIONS_DIR = path.join(CODEX_HOME_DIR, 'sessions');
export const CODEX_ARCHIVED_SESSIONS_DIR = path.join(CODEX_HOME_DIR, 'archived_sessions');
export const CODEX_SESSION_CLEANUP_ARCHIVE_DIR = path.join(CODEX_HOME_DIR, 'session-cleanup-archive');
export const CODEX_USAGE_DIRS = [
  CODEX_SESSIONS_DIR,
  CODEX_ARCHIVED_SESSIONS_DIR,
  CODEX_SESSION_CLEANUP_ARCHIVE_DIR,
] as const;
