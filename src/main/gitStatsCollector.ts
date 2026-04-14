import { execFile } from 'child_process';
import path from 'path';
import Store from 'electron-store';

export interface GitStats {
  branch: string | null;
  toplevel: string | null;
  gitCommonDir: string | null;  // 워크트리 중복 제거용 (절대 경로 정규화)
  commitsToday: number;
  linesAdded: number;
  linesRemoved: number;
  commits7d: number;
  linesAdded7d: number;
  linesRemoved7d: number;
  commits30d: number;
  linesAdded30d: number;
  linesRemoved30d: number;
  totalCommits: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
}

// cwd별 캐시 (120초 TTL — git 명령이 무거우므로 여유 있게)
const cache = new Map<string, { stats: GitStats; ts: number }>();
const CACHE_TTL = 120_000;

// 진행 중인 요청 중복 방지
const pending = new Map<string, Promise<GitStats | null>>();

// 영속 스토어 — cwd가 삭제되어 git 명령이 실패해도 마지막 수집 stats를 반환하기 위함
interface PersistedStatsStore { cache: Record<string, GitStats>; }
let persistedStore: Store<PersistedStatsStore> | null = null;
function getPersistedStore(): Store<PersistedStatsStore> {
  if (!persistedStore) {
    persistedStore = new Store<PersistedStatsStore>({ name: 'gitStatsCache', defaults: { cache: {} } });
  }
  return persistedStore;
}
function saveStats(cwd: string, stats: GitStats): void {
  try {
    const store = getPersistedStore();
    store.set('cache', { ...store.get('cache'), [cwd]: stats });
  } catch { /* 저장 실패는 무시 */ }
}
function loadStats(cwd: string): GitStats | null {
  try {
    return getPersistedStore().get('cache')[cwd] ?? null;
  } catch { return null; }
}

function parseNumstat(output: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const a = parseInt(parts[0], 10);
    const r = parseInt(parts[1], 10);
    if (!isNaN(a)) added += a;
    if (!isNaN(r)) removed += r;
  }
  return { added, removed };
}

// 비동기 git 실행 (메인 프로세스 블로킹 방지)
function execGitAsync(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5000, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout ?? '').trim());
    });
  });
}

function countLines(output: string): number {
  if (!output) return 0;
  return output.split('\n').length;
}

async function collectStats(cwd: string): Promise<GitStats | null> {
  try {
    // 현재 저장소 git user 이메일로 본인 커밋만 필터링 (미설정 시 전체 포함)
    const userEmail = await execGitAsync(['config', 'user.email'], cwd).catch(() => '');
    const authorArgs = userEmail ? [`--author=${userEmail}`] : [];

    // 병렬로 가벼운 명령 먼저 실행
    const [branch, toplevel, gitCommonDirRaw, todayLog, todayNumstat, totalCountStr] = await Promise.all([
      execGitAsync(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).catch(() => null),
      execGitAsync(['rev-parse', '--show-toplevel'], cwd).catch(() => null),
      execGitAsync(['rev-parse', '--git-common-dir'], cwd).catch(() => null),
      execGitAsync(['log', '--since=midnight', '--format=%H', ...authorArgs], cwd).catch(() => ''),
      execGitAsync(['log', '--since=midnight', '--numstat', '--format=', ...authorArgs], cwd).catch(() => ''),
      execGitAsync(['rev-list', '--count', 'HEAD', ...authorArgs], cwd).catch(() => '0'),
    ]);
    // git-common-dir은 일반 저장소에서 '.git'(상대 경로), worktree에서 절대 경로 반환 → 정규화
    const gitCommonDir = gitCommonDirRaw ? path.resolve(cwd, gitCommonDirRaw) : null;

    const commitsToday = countLines(todayLog);
    const today = parseNumstat(todayNumstat);
    const totalCommits = parseInt(totalCountStr, 10) || 0;

    // 7d/30d/all numstat — 순차 실행 (무거운 작업이므로 하나씩)
    // shortlog --summary로 커밋 수만 세고, numstat은 최소한으로
    const [log7d, numstat7d] = await Promise.all([
      execGitAsync(['log', '--since=7 days ago', '--format=%H', ...authorArgs], cwd).catch(() => ''),
      execGitAsync(['log', '--since=7 days ago', '--numstat', '--format=', ...authorArgs], cwd).catch(() => ''),
    ]);
    const commits7d = countLines(log7d);
    const d7 = parseNumstat(numstat7d);

    const [log30d, numstat30d] = await Promise.all([
      execGitAsync(['log', '--since=30 days ago', '--format=%H', ...authorArgs], cwd).catch(() => ''),
      execGitAsync(['log', '--since=30 days ago', '--numstat', '--format=', ...authorArgs], cwd).catch(() => ''),
    ]);
    const commits30d = countLines(log30d);
    const d30 = parseNumstat(numstat30d);

    // 전체 numstat — 가장 무거움, shortstat으로 대체
    const allStat = await execGitAsync(['log', '--format=', '--numstat', ...authorArgs], cwd).catch(() => '');
    const total = parseNumstat(allStat);

    return {
      branch,
      toplevel,
      gitCommonDir,
      commitsToday,
      linesAdded: today.added,
      linesRemoved: today.removed,
      commits7d,
      linesAdded7d: d7.added,
      linesRemoved7d: d7.removed,
      commits30d,
      linesAdded30d: d30.added,
      linesRemoved30d: d30.removed,
      totalCommits,
      totalLinesAdded: total.added,
      totalLinesRemoved: total.removed,
    };
  } catch {
    return null;
  }
}

export async function getGitStatsAsync(cwd: string): Promise<GitStats | null> {
  // 캐시 확인
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.stats;

  // 동일 cwd에 대한 중복 요청 방지
  const inflight = pending.get(cwd);
  if (inflight) return inflight;

  const promise = collectStats(cwd).then(stats => {
    if (stats) {
      cache.set(cwd, { stats, ts: Date.now() });
      saveStats(cwd, stats);
    }
    pending.delete(cwd);
    // 수집 실패 시 마지막으로 저장된 stats 반환 (cwd 삭제된 경우 등)
    return stats ?? loadStats(cwd);
  }).catch(() => {
    pending.delete(cwd);
    return loadStats(cwd);
  });

  pending.set(cwd, promise);
  return promise;
}

// 동기 버전 — 캐시에 있을 때만 반환, 없으면 비동기 수집 시작 후 null 반환
export function getGitStats(cwd: string): GitStats | null {
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.stats;

  // 캐시 미스: 비동기로 수집 시작 (결과는 다음 refresh에서 캐시에서 가져옴)
  if (!pending.has(cwd)) {
    void getGitStatsAsync(cwd);
  }
  // 만료된 캐시라도 있으면 stale 반환 (다음 refresh에서 갱신)
  return cached?.stats ?? null;
}
