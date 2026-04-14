import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** ~/.claude/projects/ 내 모든 프로젝트 디렉토리에서 cwd를 추출하여 반환.
 *  각 JSONL 파일 첫 2KB만 읽어 성능 유지.
 *  로컬에 실제로 존재하는 디렉토리만 반환. */
export function discoverAllProjectCwds(): string[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const cwds = new Set<string>();
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const dir of dirs) {
      const dirPath = path.join(PROJECTS_DIR, dir.name);
      try {
        const jsonlFiles = fs.readdirSync(dirPath)
          .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
        if (jsonlFiles.length === 0) continue;
        const cwd = extractCwdFromJsonl(path.join(dirPath, jsonlFiles[0]));
        if (cwd) cwds.add(cwd);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  // 로컬에 존재하는 디렉토리만 반환 (삭제된 워크트리 등 자동 제외)
  return [...cwds].filter(cwd => {
    try { return fs.statSync(cwd).isDirectory(); } catch { return false; }
  });
}

function extractCwdFromJsonl(filePath: string): string | null {
  try {
    // 첫 2KB만 읽기 — cwd는 초반 라인에 존재
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, bytesRead).toString('utf-8').split('\n').slice(0, 8)) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (typeof data.cwd === 'string' && data.cwd) return data.cwd;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}
