import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tCallRegex, enText } from './test-support/i18n.mjs';

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

test('Antigravity provider stays local-only and does not add OAuth, cloud, credits, or credential logging paths', () => {
  const providerFiles = listFiles(path.join('src', 'main', 'providers', 'antigravity'));
  const providerSource = providerFiles
    .map(filePath => `\nFILE ${filePath}\n${fs.readFileSync(filePath, 'utf8')}`)
    .join('\n');

  assert.doesNotMatch(providerSource, /cloudcode-pa\.googleapis\.com/i);
  assert.doesNotMatch(providerSource, /googleapis/i);
  assert.doesNotMatch(providerSource, /refresh_token/i);
  assert.doesNotMatch(providerSource, /\boauth\b/i);
  assert.doesNotMatch(providerSource, /\bcredits?\b/i);
  assert.doesNotMatch(providerSource, /state\.vscdb/i);
  assert.doesNotMatch(providerSource, /console\.(log|debug|info|warn|error)/);

  const settingsView = fs.readFileSync('src/renderer/views/SettingsView.tsx', 'utf8');
  assert.match(settingsView, tCallRegex('settingsView.providers.antigravityDetail'));
  // The disclosure wording itself is privacy-relevant (users are told Antigravity is
  // local-RPC-only, no cloud/credits), so pin its English content, not just the key.
  assert.equal(enText('settingsView.providers.antigravityDetail'), 'Requires Antigravity IDE running and signed in. Uses local RPC only.');
  assert.doesNotMatch(settingsView, /Antigravity[\s\S]{0,240}credits?/i);
});

test('public help and README document Antigravity as local RPC only', () => {
  const helpView = fs.readFileSync('src/renderer/views/HelpView.tsx', 'utf8');
  const readmes = [
    'README.md',
    'README.zh-CN.md',
    'README.ko.md',
    'README.ja.md',
    'README.es.md',
  ].map(filePath => [filePath, fs.readFileSync(filePath, 'utf8')]);

  for (const source of [helpView, ...readmes.map(([, source]) => source)]) {
    assert.match(source, /Antigravity/);
    assert.match(source, /local RPC/i);
  }

  for (const [filePath, source] of readmes) {
    assert.doesNotMatch(source, /Claude\s*\/\s*Codex\s*\/\s*Both|Claude.*Codex.*Both/, `${filePath} still describes a Claude/Codex/Both selector`);
  }

  const readme = readmes.find(([filePath]) => filePath === 'README.md')[1];
  const zhReadme = readmes.find(([filePath]) => filePath === 'README.zh-CN.md')[1];
  assert.match(readme, /does not use Google OAuth, refresh tokens, Google cloud usage endpoints, or offline database fallback/);
  assert.match(zhReadme, /不会使用 Google OAuth、refresh token、Google cloud usage endpoint 或离线数据库 fallback/);

  const packageJson = fs.readFileSync('package.json', 'utf8');
  assert.match(packageJson, /Antigravity/);
});
