import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
process.exit(result.status ?? 1);
