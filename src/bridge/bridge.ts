/**
 * WhereMyTokens stdin bridge
 * Claude Code statusLine plugin: receives JSON via stdin, writes to shared file
 *
 * Setup in ~/.claude/settings.json:
 *   { "statusLine": { "type": "command", "command": "node \"/path/to/bridge.js\"" } }
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const outDir = path.join(os.homedir(), 'AppData', 'Roaming', 'WhereMyTokens');
const outFile = path.join(outDir, 'live-session.json');

try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }

let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk: string) => { buf += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(buf) as Record<string, unknown>;
    fs.writeFileSync(outFile, JSON.stringify({ ...data, _ts: Date.now() }), 'utf-8');
  } catch { /* invalid JSON — ignore */ }
  // statusLine expects a line of text on stdout; empty = no display
  process.stdout.write('');
  process.exit(0);
});

// Timeout: if stdin never closes, exit after 5s
setTimeout(() => process.exit(0), 5000).unref();
