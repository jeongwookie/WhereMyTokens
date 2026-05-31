import * as os from 'os';
import * as path from 'path';

export const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
