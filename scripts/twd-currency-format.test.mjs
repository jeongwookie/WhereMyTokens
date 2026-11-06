import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformSync } from 'esbuild';

// Test the real TypeScript formatters without changing the app's build configuration.
const source = readFileSync('src/renderer/theme.ts', 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { fmtCost, fmtCostShort } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

for (const [name, format] of [['fmtCost', fmtCost], ['fmtCostShort', fmtCostShort]]) {
  test(`${name} renders NT$ for TWD values above and below one dollar`, () => {
    assert.equal(format(1, 'TWD', 32), 'NT$32.00');
    assert.equal(format(0.01, 'TWD', 32), 'NT$0.3200');
    assert.equal(format(1, 'USD', 32), '$1.00');
  });
}
