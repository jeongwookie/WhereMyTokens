import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(repoRoot, 'scripts', 'prepare-taskbar-helper-resource.mjs');

test('copies only the taskbar helper executable into dist resources', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-taskbar-resource-'));
  const sourceDir = path.join(tempRoot, 'taskbar-helper', 'bin');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.exe'), 'exe');
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.dll'), 'dll');
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.deps.json'), '{}');
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.runtimeconfig.json'), '{}');
  fs.writeFileSync(path.join(sourceDir, 'local-debug.txt'), 'do not ship');
  fs.mkdirSync(path.join(sourceDir, 'Release'));
  fs.writeFileSync(path.join(sourceDir, 'Release', 'nested.txt'), 'ignore');

  execFileSync(process.execPath, [script], { cwd: tempRoot, stdio: 'pipe' });

  const targetDir = path.join(tempRoot, 'dist', 'taskbar-helper');
  assert.equal(fs.readFileSync(path.join(targetDir, 'WhereMyTokens.Taskbar.exe'), 'utf8'), 'exe');
  assert.equal(fs.existsSync(path.join(targetDir, 'WhereMyTokens.Taskbar.dll')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'WhereMyTokens.Taskbar.deps.json')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'WhereMyTokens.Taskbar.runtimeconfig.json')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'local-debug.txt')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'Release')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'README.txt')), false);
});

test('warns and skips the helper resource when the published exe predates Program.cs', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-taskbar-resource-'));
  const sourceDir = path.join(tempRoot, 'taskbar-helper', 'bin');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.exe'), 'exe');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.exe'), past, past);
  fs.writeFileSync(path.join(tempRoot, 'taskbar-helper', 'Program.cs'), '// exe보다 새 파일');

  const result = spawnSync(process.execPath, [script], { cwd: tempRoot, encoding: 'utf8' });
  assert.match(result.stdout + result.stderr, /WARNING.*stale helper/i);
  assert.equal(fs.existsSync(path.join(tempRoot, 'dist', 'taskbar-helper', 'WhereMyTokens.Taskbar.exe')), false);
  assert.match(
    fs.readFileSync(path.join(tempRoot, 'dist', 'taskbar-helper', 'README.txt'), 'utf8'),
    /artifact is stale/i,
  );
});

test('warns and skips the helper resource when the published exe predates the csproj', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-taskbar-resource-'));
  const sourceDir = path.join(tempRoot, 'taskbar-helper', 'bin');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.exe'), 'exe');
  fs.writeFileSync(path.join(tempRoot, 'taskbar-helper', 'Program.cs'), '// unchanged source');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.exe'), past, past);
  fs.utimesSync(path.join(tempRoot, 'taskbar-helper', 'Program.cs'), past, past);
  fs.writeFileSync(path.join(tempRoot, 'taskbar-helper', 'WhereMyTokens.Taskbar.csproj'), '<Project />');

  const result = spawnSync(process.execPath, [script], { cwd: tempRoot, encoding: 'utf8' });
  assert.match(result.stdout + result.stderr, /WARNING.*stale helper/i);
  assert.equal(fs.existsSync(path.join(tempRoot, 'dist', 'taskbar-helper', 'WhereMyTokens.Taskbar.exe')), false);
  assert.match(
    fs.readFileSync(path.join(tempRoot, 'dist', 'taskbar-helper', 'README.txt'), 'utf8'),
    /artifact is stale/i,
  );
});

test('does not warn when the published helper exe is newer than Program.cs', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-taskbar-resource-'));
  const sourceDir = path.join(tempRoot, 'taskbar-helper', 'bin');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'taskbar-helper', 'Program.cs'), '// 빌드 뒤에 수정되지 않은 파일');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(tempRoot, 'taskbar-helper', 'Program.cs'), past, past);
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.exe'), 'exe');

  const result = spawnSync(process.execPath, [script], { cwd: tempRoot, encoding: 'utf8' });
  assert.doesNotMatch(result.stdout + result.stderr, /WARNING/i);
});
