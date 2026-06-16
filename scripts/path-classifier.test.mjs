import test from 'node:test';
import assert from 'node:assert/strict';
import mod from '../dist/main/pathClassifier.js';

const { classifyPath } = mod;

test('classifyPath hits each category', () => {
  assert.equal(classifyPath('src/main/index.ts'), 'product_code');
  assert.equal(classifyPath('scripts/foo.test.mjs'), 'test_code');
  assert.equal(classifyPath('src/__tests__/bar.spec.ts'), 'test_code');
  assert.equal(classifyPath('docs/superpowers/specs/x.md'), 'docs_spec');
  assert.equal(classifyPath('README.md'), 'docs_spec');
  assert.equal(classifyPath('LICENSE'), 'docs_spec');
  assert.equal(classifyPath('COPYING'), 'docs_spec');
  assert.equal(classifyPath('package.json'), 'config_build');
  assert.equal(classifyPath('tsconfig.json'), 'config_build');
  assert.equal(classifyPath('.github/workflows/ci.yml'), 'config_build');
  assert.equal(classifyPath('migrations/2026_add_col.sql'), 'schema_migration');
  assert.equal(classifyPath('prisma/schema.prisma'), 'schema_migration');
  assert.equal(classifyPath('node_modules/react/index.js'), 'vendor');
  assert.equal(classifyPath('vendor/lib/x.go'), 'vendor');
  assert.equal(classifyPath('assets/logo.png'), 'asset');
  assert.equal(classifyPath('public/icon.svg'), 'asset');
});

test('classifyPath falls back to product_code', () => {
  assert.equal(classifyPath('weird/no-extension-file'), 'product_code');
  assert.equal(classifyPath('src/lib/helper.ts'), 'product_code');
});

test('classifyPath precedence: test wins over product, vendor wins over all', () => {
  assert.equal(classifyPath('src/components/Button.test.tsx'), 'test_code');
  assert.equal(classifyPath('node_modules/jest/x.test.js'), 'vendor');
});
