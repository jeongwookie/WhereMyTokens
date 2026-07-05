import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(repoRoot, 'scripts', 'prepare-taskbar-helper-resource.mjs');

test('copies all top-level taskbar helper publish artifacts into dist resources', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-taskbar-resource-'));
  const sourceDir = path.join(tempRoot, 'taskbar-helper', 'bin');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.exe'), 'exe');
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.dll'), 'dll');
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.deps.json'), '{}');
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.runtimeconfig.json'), '{}');
  fs.mkdirSync(path.join(sourceDir, 'Release'));
  fs.writeFileSync(path.join(sourceDir, 'Release', 'nested.txt'), 'ignore');

  execFileSync(process.execPath, [script], { cwd: tempRoot, stdio: 'pipe' });

  const targetDir = path.join(tempRoot, 'dist', 'taskbar-helper');
  assert.equal(fs.readFileSync(path.join(targetDir, 'WhereMyTokens.Taskbar.exe'), 'utf8'), 'exe');
  assert.equal(fs.readFileSync(path.join(targetDir, 'WhereMyTokens.Taskbar.dll'), 'utf8'), 'dll');
  assert.equal(fs.existsSync(path.join(targetDir, 'WhereMyTokens.Taskbar.deps.json')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'WhereMyTokens.Taskbar.runtimeconfig.json')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'Release')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'README.txt')), false);
});

test('warns when the published helper dll predates the Program.cs source', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-taskbar-resource-'));
  const sourceDir = path.join(tempRoot, 'taskbar-helper', 'bin');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.exe'), 'exe');
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.dll'), 'dll');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.dll'), past, past);
  fs.writeFileSync(path.join(tempRoot, 'taskbar-helper', 'Program.cs'), '// newer than the dll');

  const result = spawnSync(process.execPath, [script], { cwd: tempRoot, encoding: 'utf8' });
  assert.match(result.stdout + result.stderr, /WARNING.*stale helper/i);
});

test('does not warn when the published helper dll is newer than Program.cs', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-taskbar-resource-'));
  const sourceDir = path.join(tempRoot, 'taskbar-helper', 'bin');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'taskbar-helper', 'Program.cs'), '// built after this edit');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(tempRoot, 'taskbar-helper', 'Program.cs'), past, past);
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.exe'), 'exe');
  fs.writeFileSync(path.join(sourceDir, 'WhereMyTokens.Taskbar.dll'), 'dll');

  const result = spawnSync(process.execPath, [script], { cwd: tempRoot, encoding: 'utf8' });
  assert.doesNotMatch(result.stdout + result.stderr, /WARNING/i);
});
