import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

async function loadFilterModule() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-usage-filter-'));
  const outfile = path.join(outdir, 'usageVisibilityFilter.mjs');
  await esbuild.build({
    entryPoints: [path.resolve('src', 'main', 'usageVisibilityFilter.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  return import(pathToFileURL(outfile).href);
}

function settings(enabledProviders = ['claude', 'codex'], quotaTargetModes = {}) {
  return { enabledProviders, quotaTargetModes };
}

test('usage visibility filter follows enabled providers only', async () => {
  const { buildUsageVisibilityFilter, usageProviderVisible } = await loadFilterModule();
  const filter = buildUsageVisibilityFilter(settings(['claude'], {
    'claude.group.account': 'none',
    'claude.group.sonnet': 'none',
    'codex.group.account': 'rich',
  }));

  assert.equal(usageProviderVisible(filter, 'claude'), true);
  assert.equal(usageProviderVisible(filter, 'codex'), false);
  assert.equal('modelScopes' in filter, false);
});

test('usage visibility filter does not accept provider quota metadata', async () => {
  const { buildUsageVisibilityFilter } = await loadFilterModule();

  assert.equal(buildUsageVisibilityFilter.length, 1);
});

test('empty usage visibility filter hides every provider', async () => {
  const { emptyUsageVisibilityFilter, usageProviderVisible } = await loadFilterModule();
  const filter = emptyUsageVisibilityFilter();

  assert.equal(usageProviderVisible(filter, 'claude'), false);
  assert.equal(usageProviderVisible(filter, 'codex'), false);
});
