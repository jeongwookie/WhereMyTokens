import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

async function loadModels() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmt-reset-'));
  const outfile = path.join(outdir, 'quotaDisplayModels.mjs');
  await esbuild.build({ entryPoints: [path.resolve('src', 'renderer', 'quotaDisplayModels.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

function resetSnapshot(overrides = {}) {
  return {
    provider: 'codex', source: 'api', capturedAt: Date.now(),
    groups: [
      { key: 'account', label: 'Codex', windowKeys: ['h5', 'week'], defaultMode: 'rich', sortOrder: 0 },
      { key: 'resets', label: 'Codex Resets', windowKeys: [], defaultMode: 'simple', sortOrder: 1 },
    ],
    windowDisplay: { h5: { label: '5h' }, week: { label: '1w' } },
    windows: { h5: { pct: 23, resetMs: 3600000, source: 'api' }, week: { pct: 58, resetMs: 86400000, source: 'api' } },
    status: { connected: true, code: 'ok' },
    resetCredits: {
      credits: [
        { idSuffix: 'aaa', status: 'available', expiresAtUtc: '2026-07-12T11:46:00Z' },
        { idSuffix: 'bbb', status: 'available', expiresAtUtc: '2026-07-18T08:36:00Z' },
      ],
      availableCount: 2, totalEarnedCount: 0, checkedAt: Date.now(), countOnly: false, source: 'api',
      status: { connected: true, code: 'ok' },
    },
    ...overrides,
  };
}

function baseOptions(snapshot) {
  return {
    usage: { byProvider: {}, modelWindows: {} },
    providerQuotas: { codex: snapshot },
    settings: { enabledProviders: ['codex'], quotaTargetModes: {}, quotaTargetOrder: [] },
    historyWarmupPending: false, historyWarmupStartsAt: null, formatWarmupEta: () => '',
  };
}

test('resets group appears as a settings target when resetCredits present', async () => {
  const M = await loadModels();
  const models = M.buildQuotaDisplayModels(baseOptions(resetSnapshot()));
  const resets = models.settingsTargets.find(g => g.label === 'Codex Resets');
  assert.ok(resets, 'Codex Resets target should exist');
  assert.equal(resets.provider, 'codex');
});

test('resets group is dropped when resetCredits is null', async () => {
  const M = await loadModels();
  const models = M.buildQuotaDisplayModels(baseOptions(resetSnapshot({ resetCredits: null })));
  const resets = models.settingsTargets.find(g => g.label === 'Codex Resets');
  assert.equal(resets, undefined, 'Codex Resets target should not exist without reset data');
});

test('formatCreditDuration renders 2d 4h / 9h 3m / 12m forms', async () => {
  const M = await loadModels();
  const HOUR = 3600000, MIN = 60000, DAY = 86400000;
  assert.equal(M.formatCreditDuration(2 * DAY + 4 * HOUR), '2d 4h');
  assert.equal(M.formatCreditDuration(9 * HOUR + 3 * MIN), '9h 3m');
  assert.equal(M.formatCreditDuration(12 * MIN), '12m');
  assert.equal(M.formatCreditDuration(0), '0m');
});

test('creditUrgencyBucket maps by soonest expiry', async () => {
  const M = await loadModels();
  const DAY = 86400000, HOUR = 3600000;
  assert.equal(M.creditUrgencyBucket(8 * DAY), 'ok');     // >7d
  assert.equal(M.creditUrgencyBucket(3 * DAY), 'warn');   // 1-7d
  assert.equal(M.creditUrgencyBucket(9 * HOUR), 'red');   // <24h
  assert.equal(M.creditUrgencyBucket(null), 'muted');     // no data
});

test('buildResetCreditsViewModel exposes sorted credits + count + next expiry + mode/source', async () => {
  const M = await loadModels();
  const now = Date.parse('2026-07-04T00:00:00Z');
  const vm = M.buildResetCreditsViewModel(resetSnapshot().resetCredits, now, 'rich');
  assert.equal(vm.availableCount, 2);
  assert.equal(vm.credits.length, 2);
  assert.equal(vm.credits[0].remainingMs > 0, true);
  assert.equal(vm.nextExpiryMs, vm.credits[0].remainingMs);
  assert.equal(vm.urgency, 'ok');
  assert.equal(vm.countOnly, false);
  assert.equal(vm.errored, false);
  assert.equal(vm.mode, 'rich');
  assert.equal(vm.source, 'api');
  assert.equal(vm.stale, false);
});

test('buildResetCreditsViewModel marks cached data stale and preserves checkedAt', async () => {
  const M = await loadModels();
  const now = Date.parse('2026-07-04T00:00:00Z');
  const cached = { ...resetSnapshot().resetCredits, source: 'cache', checkedAt: now - 3600000, status: { connected: false, code: 'ok' } };
  const vm = M.buildResetCreditsViewModel(cached, now, 'simple');
  assert.equal(vm.source, 'cache');
  assert.equal(vm.stale, true);
  assert.equal(vm.checkedAt, now - 3600000);   // last successful update reachable for the tooltip
});

test('buildQuotaDisplayModels routes the reset card independently of row-signal groups (F3)', async () => {
  const M = await loadModels();
  const models = M.buildQuotaDisplayModels(baseOptions(resetSnapshot()));
  assert.ok(models.resetCredits, 'resetCredits present on models despite empty windowKeys / zero rows');
  assert.equal(models.resetCredits.mode, 'simple');   // resets defaultMode
  assert.equal(models.resetCredits.availableCount, 2);
  // and it is NOT smuggled through richGroups/simpleGroups
  assert.equal(models.richGroups.some(g => g.label === 'Codex Resets'), false);
  assert.equal(models.simpleGroups.some(g => g.label === 'Codex Resets'), false);
});

// --- Task 7b: renderer IPC-state normalizer (anti-假接入 boundary, R7-1) ---

// Shared esbuild helper: bundle a renderer .tsx/.ts entry, import it.
// Task 8+ reuse this to render components; here it drives the real App.tsx normalizer.
// `packages: 'external'` leaves every npm import (react, react-dom, lucide-react, …) for
// node to resolve from node_modules — so react stays a singleton shared with
// react-dom/server, and lucide-react loads its ESM build instead of esbuild inlining the
// CJS build (whose module-eval `require('react')` throws under ESM). Only our own relative
// source is bundled; App.tsx has no top-level render side effect, so importing it is safe.
async function importComponent(entry, name) {
  const outdir = fs.mkdtempSync(path.resolve(`.tmp-${name}-`));
  const outfile = path.join(outdir, `${name}.mjs`);
  await esbuild.build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', logLevel: 'silent' });
  const mod = await import(pathToFileURL(outfile).href);
  fs.rmSync(outdir, { recursive: true, force: true });
  return mod;
}

test('renderer normalizeProviderQuotas preserves resetCredits (R7-1 anti-假接入)', async () => {
  const mod = await importComponent(path.resolve('src', 'renderer', 'App.tsx'), 'AppNormalize');
  const { normalizeProviderQuotas } = mod;
  const out = normalizeProviderQuotas({
    codex: {
      provider: 'codex', source: 'api', capturedAt: 1,
      resetCredits: {
        credits: [{ idSuffix: 'aaa', status: 'available', expiresAtUtc: '2026-07-12T00:00:00Z', title: 'leak' }],
        availableCount: 1, totalEarnedCount: 0, checkedAt: 123, countOnly: false, source: 'api',
        status: { connected: true, code: 'ok', httpStatus: 200 },
      },
    },
  });
  assert.ok(out.codex.resetCredits, 'resetCredits survives renderer IPC normalization');
  assert.equal(out.codex.resetCredits.credits.length, 1);
  assert.deepEqual(Object.keys(out.codex.resetCredits.credits[0]).sort(), ['expiresAtUtc', 'idSuffix', 'status']);
  assert.equal(out.codex.resetCredits.availableCount, 1);
  assert.equal(out.codex.resetCredits.status.code, 'ok');
  assert.equal('httpStatus' in out.codex.resetCredits.status, false); // public status shape only
});

// --- Task 8: rich ResetCreditsCard + shared tooltip (visual contract §9.2/9.4/9.5) ---

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// ONE bundle for the themed render tests: ThemeProvider + DARK + MainView's exports must share
// a SINGLE ThemeContext instance so <ThemeProvider value={DARK}> actually reaches the tested
// component's useTheme(). Two separate esbuild bundles would each embed their own ThemeContext
// (distinct React context objects) → provider/consumer mismatch → useTheme falls back to LIGHT.
// (This is why production ThemeContext stays a plain createContext — the dual-context problem is a
// test-bundling artifact, not a production one; fix it here in the harness, not in prod code.)
// packages:'external' leaves react/react-dom/lucide-react for node to resolve (shared singletons;
// lucide-react's ESM build, not the CJS dynamic-require one).
let _rendererBundle = null;
async function loadRendererBundle() {
  if (_rendererBundle) return _rendererBundle;
  // mkdtemp lands directly under the repo root, so ../src reaches the source. Forward-slash
  // relative specifiers only (no file:// URL, no backslashes — both break esbuild's import on Windows).
  const outdir = fs.mkdtempSync(path.resolve('.tmp-harness-'));
  const outfile = path.join(outdir, 'harness.mjs');
  const entry = path.join(outdir, 'entry.mjs');
  fs.writeFileSync(entry, [
    `export { ThemeProvider } from '../src/renderer/ThemeContext';`,
    `export { DARK } from '../src/renderer/theme';`,
    `export * from '../src/renderer/views/MainView';`,
    `export { default as SettingsView } from '../src/renderer/views/SettingsView';`,
    '',
  ].join('\n'));
  await esbuild.build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', packages: 'external', loader: { '.ts': 'ts', '.tsx': 'tsx' }, logLevel: 'silent' });
  _rendererBundle = await import(pathToFileURL(outfile).href);
  fs.rmSync(outdir, { recursive: true, force: true });
  return _rendererBundle;
}
async function loadHarness() { return loadRendererBundle(); }
const { ThemeProvider, DARK } = await loadHarness();

const DAY = 86400000, HOUR = 3600000, MIN = 60000;

function richVM() {
  return {
    provider: 'codex', mode: 'rich', source: 'api', stale: false,
    availableCount: 4, countOnly: false, errored: false, urgency: 'ok', totalEarnedCount: 0,
    nextExpiryMs: 7 * DAY + 23 * HOUR, checkedAt: Date.parse('2026-07-04T00:00:00Z'),
    status: { connected: true, code: 'ok', label: 'API' },
    credits: [
      { idSuffix: 'a', status: 'available', expiresAtUtc: '2026-07-12T11:46:00Z', remainingMs: 7 * DAY + 23 * HOUR },
      { idSuffix: 'b', status: 'available', expiresAtUtc: '2026-07-18T08:36:00Z', remainingMs: 13 * DAY + 20 * HOUR },
      { idSuffix: 'c', status: 'available', expiresAtUtc: '2026-07-27T07:46:00Z', remainingMs: 22 * DAY + 23 * HOUR },
      { idSuffix: 'd', status: 'available', expiresAtUtc: '2026-08-01T04:05:00Z', remainingMs: 27 * DAY + 16 * HOUR },
    ],
  };
}

function stateVM(over) {
  return { ...richVM(), ...over };
}

async function mainView() {
  // Same single bundle as loadHarness → ResetCreditsCard/PlanUsagePanel share the DARK ThemeContext.
  return loadRendererBundle();
}

function bodyRegion(html) {
  const b = html.indexOf('data-testid="reset-card-body"');
  const t = html.indexOf('data-testid="reset-tooltip"');
  return t === -1 ? html.slice(b) : html.slice(b, t);
}

test('rich ResetCreditsCard BODY: N available, next expiry, one chip per credit, NO earned line (F4)', async () => {
  const mod = await mainView();
  const html = renderToStaticMarkup(React.createElement(mod.ResetCreditsCard, { vm: richVM() }));
  const bodyStart = html.indexOf('data-testid="reset-card-body"');
  assert.notEqual(bodyStart, -1, 'card body region present');
  const body = bodyRegion(html);
  assert.match(body, /CODEX RESETS/i);
  assert.match(body, /4/);
  assert.match(body, /available/i);
  assert.match(body, /next expires/i);
  assert.match(body, /7d\s+23h/);
  for (const rel of ['7d 23h', '13d 20h', '22d 23h', '27d 16h']) assert.match(body, new RegExp(rel.replace(/ /g, '\\s+')));
  assert.doesNotMatch(body, /earned/i);            // Earned is TOOLTIP-only, never in the card body
  assert.doesNotMatch(body, /2026-\d\d-\d\dT/);    // relative time only on the main surface
});

test('shared tooltip lists Earned + every credit + Updated/Source (F4)', async () => {
  const mod = await mainView();
  const html = renderToStaticMarkup(React.createElement(mod.ResetCreditsCard, { vm: richVM() }));
  const tipStart = html.indexOf('data-testid="reset-tooltip"');
  assert.notEqual(tipStart, -1, 'tooltip region present');
  const tip = html.slice(tipStart);
  assert.match(tip, /Available/i);
  assert.match(tip, /Next expires/i);
  assert.match(tip, /Earned/i);                    // Earned lives here (F4), not in the card body
  for (const rel of ['7d 23h', '13d 20h', '22d 23h', '27d 16h']) assert.match(tip, new RegExp(rel.replace(/ /g, '\\s+')));
  assert.match(tip, /Updated/i);
  assert.match(tip, /Source/i);
});

test('rich card state colors: warn=waiting, red=barRed, 0=muted+No resets, errored=muted+unavailable (F4)', async () => {
  const mod = await mainView();
  const dark = (vm) => renderToStaticMarkup(React.createElement(ThemeProvider, { value: DARK }, React.createElement(mod.ResetCreditsCard, { vm })));

  const warn = bodyRegion(dark(stateVM({ urgency: 'warn', availableCount: 2, nextExpiryMs: 2 * DAY + 4 * HOUR,
    credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2026-07-06T00:00:00Z', remainingMs: 2 * DAY + 4 * HOUR }] })));
  assert.ok(warn.includes(DARK.waiting), 'warn count uses DARK.waiting');

  const red = bodyRegion(dark(stateVM({ urgency: 'red', availableCount: 1, nextExpiryMs: 9 * HOUR + 3 * MIN,
    credits: [{ idSuffix: 'a', status: 'available', expiresAtUtc: '2026-07-04T09:03:00Z', remainingMs: 9 * HOUR + 3 * MIN }] })));
  assert.ok(red.includes(DARK.barRed), 'red count uses DARK.barRed');

  const zero = bodyRegion(dark(stateVM({ urgency: 'muted', availableCount: 0, nextExpiryMs: null, credits: [] })));
  assert.ok(zero.includes(DARK.textMuted), 'zero count uses DARK.textMuted');
  assert.match(zero, /no resets available/i);

  const errored = bodyRegion(dark(stateVM({ errored: true, urgency: 'muted', availableCount: 0, nextExpiryMs: null, credits: [],
    source: 'cache', status: { connected: false, code: 'unauthorized', label: 'auth failed', detail: 'Codex rejected the saved login.' } })));
  assert.ok(errored.includes(DARK.textMuted), 'errored uses DARK.textMuted');
  assert.match(errored, /reset data unavailable/i);
  assert.match(errored, /unauthorized/);          // error chip carries the status code
});

test('error-state tooltip shows status code + detail + last-successful-update time (F4)', async () => {
  const mod = await mainView();
  const vm = stateVM({ errored: true, urgency: 'muted', availableCount: 0, nextExpiryMs: null, credits: [],
    source: 'cache', checkedAt: Date.parse('2026-07-04T01:12:00Z'),
    status: { connected: false, code: 'unauthorized', label: 'auth failed', detail: 'Codex rejected the saved login.' } });
  const html = renderToStaticMarkup(React.createElement(mod.ResetCreditsCard, { vm }));
  const tipStart = html.indexOf('data-testid="reset-tooltip"');
  assert.notEqual(tipStart, -1);
  const tip = html.slice(tipStart);
  assert.match(tip, /unauthorized/);
  assert.match(tip, /Codex rejected the saved login\./);
  assert.match(tip, /last update/i);
});

test('PlanUsagePanel renders CODEX RESETS as a sibling row AFTER 5H/1W, not nested (F6/R2-5)', async () => {
  const mod = await mainView();
  const groupId = mod.quotaGroupId ? mod.quotaGroupId('codex', 'resets') : 'codex.group.resets';
  const props = {
    usage: { byProvider: {}, modelWindows: {} },
    providerQuotas: { codex: resetSnapshot() },
    settings: { enabledProviders: ['codex'], quotaTargetModes: { [groupId]: 'rich' }, quotaTargetOrder: [], currency: 'USD', usdToKrw: 1300 },
    historyWarmupPending: false, historyWarmupStartsAt: null,
  };
  const html = renderToStaticMarkup(React.createElement(ThemeProvider, { value: DARK }, React.createElement(mod.PlanUsagePanel, props)));

  const TAG = /<div\b|<\/div>/g;
  function closeFrom(h, openIdx) {
    let depth = 0; TAG.lastIndex = openIdx; let m;
    while ((m = TAG.exec(h))) {
      if (m[0] === '</div>') { depth -= 1; if (depth === 0) return m.index + m[0].length; }
      else { depth += 1; }
    }
    throw new Error('unbalanced div');
  }
  function openOf(h, marker) {
    const mi = h.indexOf(marker);
    assert.notEqual(mi, -1, `marker ${marker} present`);
    const open = h.lastIndexOf('<div', mi);
    assert.notEqual(open, -1, `opening <div> for ${marker}`);
    return open;
  }
  function directChildDivs(h, parentOpen) {
    const parentEnd = closeFrom(h, parentOpen);
    const firstTagEnd = h.indexOf('>', parentOpen) + 1;
    const children = [];
    let cursor = firstTagEnd;
    while (true) {
      const nextOpen = h.indexOf('<div', cursor);
      if (nextOpen === -1 || nextOpen >= parentEnd) break;
      const childEnd = closeFrom(h, nextOpen);
      children.push([nextOpen, childEnd]);
      cursor = childEnd;
    }
    return { parentEnd, children };
  }

  const panelStart = openOf(html, 'data-testid="plan-usage-body"');
  const { parentEnd: panelEnd, children } = directChildDivs(html, panelStart);
  const rrStart = openOf(html, 'data-testid="reset-rich-row"');
  const rrEnd = closeFrom(html, rrStart);
  const heroRowStart = openOf(html, 'data-testid="plan-usage-rich-row"');

  const isDirectChild = (start) => children.some(([s, e]) => s === start && e <= panelEnd);
  assert.ok(rrStart > panelStart && rrEnd <= panelEnd, 'reset row is bounded inside the panel body');
  assert.ok(isDirectChild(heroRowStart), 'plan-usage-rich-row is a DIRECT child of plan-usage-body');
  assert.ok(isDirectChild(rrStart), 'reset-rich-row is a DIRECT child of plan-usage-body (sibling of the hero row)');
  const heroIdx = children.findIndex(([s]) => s === heroRowStart);
  const resetIdx = children.findIndex(([s]) => s === rrStart);
  assert.ok(heroIdx !== -1 && resetIdx !== -1 && resetIdx > heroIdx, 'reset row is ordered AFTER the 5H/1W hero row');

  const resetRowHtml = html.slice(rrStart, rrEnd);
  assert.match(resetRowHtml, /data-testid="reset-card-body"/);
  assert.doesNotMatch(resetRowHtml, /data-testid="hero-card"/);
});


// --- Task 7 xreview backfill: cross-phase integration bugs the unit tests missed ---

// F1 (BLOCKER): the `resets` group has empty windowKeys; the renderer IPC normalizer must
// NOT drop it, else the "Codex Resets" settings row is invisible in the running app. Drives
// the REAL App.tsx normalizer (anti-假接入), unlike the Task 6 test which bypasses it.
test('renderer normalizeProviderQuotas keeps the empty-windowKeys resets group (F1)', async () => {
  const app = await importComponent(path.resolve('src', 'renderer', 'App.tsx'), 'AppGroupNorm');
  const out = app.normalizeProviderQuotas({ codex: resetSnapshot() });
  const groups = out.codex.groups ?? [];
  const resets = groups.find(g => g.key === 'resets');
  assert.ok(resets, 'resets group survives renderer IPC normalization');
  assert.deepEqual(resets.windowKeys, [], 'resets keeps its empty windowKeys');
  // End-to-end: the normalized snapshot must still surface the settings target.
  const M = await loadModels();
  const models = M.buildQuotaDisplayModels(baseOptions(out.codex));
  assert.ok(models.settingsTargets.find(g => g.label === 'Codex Resets'), 'settings target present after real IPC normalization');
});

// F2 (MAJOR): reset card routing must respect the enabledProviders gate like every other group.
test('reset card is null when codex is not an enabled provider (F2)', async () => {
  const M = await loadModels();
  const opts = baseOptions(resetSnapshot());
  opts.settings = { ...opts.settings, enabledProviders: ['claude'] };  // codex NOT enabled
  const models = M.buildQuotaDisplayModels(opts);
  assert.equal(models.resetCredits, null, 'no reset card when codex disabled');
});

// --- Task 9: simple single-line ResetCreditsSimpleRow + shared tooltip (visual contract §9.3/9.4) ---

test('simple main LINE is single-line count + next + badge with NO per-credit chips (F5)', async () => {
  const mod = await mainView();
  const html = renderToStaticMarkup(React.createElement(mod.ResetCreditsSimpleRow, { vm: richVM() }));
  const lineStart = html.indexOf('data-testid="reset-simple-line"');
  assert.notEqual(lineStart, -1, 'simple main line region present');
  const tipStart = html.indexOf('data-testid="reset-tooltip"');
  const line = tipStart === -1 ? html.slice(lineStart) : html.slice(lineStart, tipStart);
  assert.match(line, /Codex Resets/i);
  assert.match(line, /4/);
  assert.match(line, /available/i);
  assert.match(line, /next/i);
  assert.match(line, /7d\s+23h/);                       // only the soonest (next) relative time on the line
  assert.doesNotMatch(line, /13d 20h/);                 // no per-credit chips on the main line
  assert.doesNotMatch(line, /22d 23h/);
  assert.doesNotMatch(line, /2026-\d\d-\d\dT/);      // no ISO on the main surface
});

test('simple row shares the SAME tooltip listing every credit (F5)', async () => {
  const mod = await mainView();
  const html = renderToStaticMarkup(React.createElement(mod.ResetCreditsSimpleRow, { vm: richVM() }));
  const tipStart = html.indexOf('data-testid="reset-tooltip"');
  assert.notEqual(tipStart, -1, 'simple row carries the shared tooltip');
  const tip = html.slice(tipStart);
  for (const rel of ['7d 23h', '13d 20h', '22d 23h', '27d 16h']) assert.match(tip, new RegExp(rel.replace(/ /g, '\\s+')));
  assert.match(tip, /Earned/i);
});

test('PlanUsagePanel renders the simple reset row when mode is simple (F5 integration — visible by default)', async () => {
  const mod = await mainView();
  const groupId = mod.quotaGroupId ? mod.quotaGroupId('codex', 'resets') : 'codex.group.resets';
  const props = {
    usage: { byProvider: {}, modelWindows: {} },
    providerQuotas: { codex: resetSnapshot() },
    settings: { enabledProviders: ['codex'], quotaTargetModes: { [groupId]: 'simple' }, quotaTargetOrder: [], currency: 'USD', usdToKrw: 1300 },
    historyWarmupPending: false, historyWarmupStartsAt: null,
  };
  const html = renderToStaticMarkup(React.createElement(ThemeProvider, { value: DARK }, React.createElement(mod.PlanUsagePanel, props)));
  const bodyStart = html.indexOf('data-testid="plan-usage-body"');
  assert.notEqual(bodyStart, -1, 'plan-usage-body present');
  assert.match(html.slice(bodyStart), /data-testid="reset-simple-line"/, 'simple reset row rendered inside the panel body');
  // simple mode must NOT also render the rich reset row
  assert.doesNotMatch(html.slice(bodyStart), /data-testid="reset-rich-row"/);
});

// --- Task 10: settings row (rich/simple/none) — zero-new-UI reuse (visual contract §9.6) ---

test('settings quota list yields a Codex Resets target with rich/simple/none controls', async () => {
  const M = await loadModels();
  const options = M.buildQuotaTargetSettingsOptions(
    { enabledProviders: ['codex'], quotaTargetModes: {}, quotaTargetOrder: [] },
    { codex: resetSnapshot() },
  );
  const row = options.find(o => o.label === 'Codex Resets');
  assert.ok(row, 'Codex Resets settings row present');
  assert.equal(row.defaultMode, 'simple');
});

test('mode none hides the reset card (models.resetCredits null) but the settings row stays', async () => {
  const M = await loadModels();
  const groupId = M.quotaGroupId('codex', 'resets');
  const opts = baseOptions(resetSnapshot());
  opts.settings = { ...opts.settings, quotaTargetModes: { [groupId]: 'none' } };
  const hidden = M.buildQuotaDisplayModels(opts);
  assert.equal(hidden.resetCredits, null, 'none nulls the rendered card');
  assert.ok(hidden.settingsTargets.find(g => g.label === 'Codex Resets'), 'settings target survives so the user can re-enable');
});

test('SettingsView DOM: Codex Resets row renders with Rich/Simple/None buttons (F10)', async () => {
  const mod = await mainView();
  const SettingsView = mod.SettingsView;
  assert.ok(SettingsView, 'SettingsView exported from the bundle');
  const props = {
    settings: { enabledProviders: ['codex'], quotaTargetModes: {}, quotaTargetOrder: [] },
    providerQuotas: { codex: resetSnapshot() },
    onSave: () => {}, onBack: () => {},
  };
  const html = renderToStaticMarkup(React.createElement(ThemeProvider, { value: DARK }, React.createElement(SettingsView, props)));
  assert.match(html, /Codex Resets/, 'settings row label present');
  assert.match(html, />Rich<\/button>/);
  assert.match(html, />Simple<\/button>/);
  assert.match(html, />None<\/button>/);
});

// --- Closing-gate fixes: G1 (errored card shown, not hidden) + G2 (non-ok status visible) ---

test('simple row errored → "Reset data unavailable" + status code (G1)', async () => {
  const mod = await mainView();
  const vm = stateVM({ errored: true, urgency: 'muted', availableCount: 0, nextExpiryMs: null, credits: [],
    countOnly: false, source: 'cache',
    status: { connected: false, code: 'no-credentials', label: 'local log', detail: 'Codex auth.json with ChatGPT tokens was not found.' } });
  const html = renderToStaticMarkup(React.createElement(mod.ResetCreditsSimpleRow, { vm }));
  const lineStart = html.indexOf('data-testid="reset-simple-line"');
  const tipStart = html.indexOf('data-testid="reset-tooltip"');
  const line = tipStart === -1 ? html.slice(lineStart) : html.slice(lineStart, tipStart);
  assert.match(line, /reset data unavailable/i);
  assert.match(line, /no-credentials/);
});

test('count-only rate-limited fallback shows N available but tooltip reveals the non-ok status (G2/§8)', async () => {
  const mod = await mainView();
  const vm = stateVM({ countOnly: true, availableCount: 3, credits: [], nextExpiryMs: null,
    errored: false, stale: true, source: 'cache',
    status: { connected: false, code: 'rate-limited', label: 'rate limited', detail: 'slow down' } });
  const html = renderToStaticMarkup(React.createElement(mod.ResetCreditsCard, { vm }));
  const bodyStart = html.indexOf('data-testid="reset-card-body"');
  const tipStart = html.indexOf('data-testid="reset-tooltip"');
  const body = html.slice(bodyStart, tipStart === -1 ? undefined : tipStart);
  assert.match(body, /3/);                              // count still shown (fallback)
  assert.match(body, /available/i);
  const tip = html.slice(tipStart);
  assert.match(tip, /rate-limited/);                    // §8: the real status is visible in the tooltip
  assert.match(tip, /slow down/);                       // detail too
});

test('reset simple row anchors to the Codex simple group when Codex has no rich row (G5 edge)', async () => {
  const mod = await mainView();
  const accountId = mod.quotaGroupId ? mod.quotaGroupId('codex', 'account') : 'codex.group.account';
  const resetsId = mod.quotaGroupId ? mod.quotaGroupId('codex', 'resets') : 'codex.group.resets';
  const props = {
    usage: { byProvider: {}, modelWindows: {} },
    providerQuotas: { codex: resetSnapshot() },
    // Force the Codex 5H/1W (account) group to simple, so there is no codex rich row to anchor after.
    settings: { enabledProviders: ['codex'], quotaTargetModes: { [accountId]: 'simple', [resetsId]: 'simple' }, quotaTargetOrder: [], currency: 'USD', usdToKrw: 1300 },
    historyWarmupPending: false, historyWarmupStartsAt: null,
  };
  const html = renderToStaticMarkup(React.createElement(ThemeProvider, { value: DARK }, React.createElement(mod.PlanUsagePanel, props)));
  const bodyStart = html.indexOf('data-testid="plan-usage-body"');
  assert.notEqual(bodyStart, -1);
  assert.match(html.slice(bodyStart), /data-testid="reset-simple-line"/, 'reset simple line still rendered when Codex account is simple');
});
