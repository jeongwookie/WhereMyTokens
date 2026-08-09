import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const target of [
  join(root, 'dist', 'main'),
  join(root, 'dist', 'shared'),
  join(root, 'dist', 'bridge'),
  join(root, 'dist', 'renderer', 'breakdownViewModel.js'),
  join(root, 'dist', 'renderer', 'trendSelection.js'),
]) {
  rmSync(target, { recursive: true, force: true });
}

const result = spawnSync(
  process.execPath,
  [join(root, 'node_modules', 'typescript', 'bin', 'tsc')],
  { cwd: root, stdio: 'inherit' },
);

if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

// 설치된 statusLine 명령은 app.asar 밖에서 실행되므로 의존성까지 단일 파일로 묶는다.
buildSync({
  entryPoints: [join(root, 'src', 'bridge', 'bridge.ts')],
  outfile: join(root, 'dist', 'bridge', 'bridge.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
});
