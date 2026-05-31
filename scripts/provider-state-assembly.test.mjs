import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const stateManagerSource = fs.readFileSync('src/main/stateManager.ts', 'utf8');

function methodBody(name) {
  const markers = [`private ${name}`, `private async ${name}`];
  const start = markers
    .map(marker => stateManagerSource.indexOf(marker))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0] ?? -1;
  assert.notEqual(start, -1, `${name} method not found`);
  const nextPrivate = stateManagerSource.indexOf('\n  private ', start + name.length);
  return stateManagerSource.slice(start, nextPrivate === -1 ? undefined : nextPrivate);
}

test('StateManager owns a provider registry and resolves enabled source-backed providers', () => {
  assert.match(stateManagerSource, /createProviderRegistry/);
  assert.match(stateManagerSource, /private readonly providerRegistry: ProviderRegistry/);
  assert.match(stateManagerSource, /options\.providerRegistry \?\? createProviderRegistry\(\)/);
  assert.match(stateManagerSource, /private enabledProviders\(settings: AppSettings\)/);
  assert.match(stateManagerSource, /private sourceBackedProviders\(settings: AppSettings\)/);
  assert.match(stateManagerSource, /private providerContext\(/);
});

test('StateManager summary loading iterates source-backed providers instead of hard-coded Claude and Codex branches', () => {
  const body = methodBody('loadProviderSummaries');

  assert.match(body, /for \(const provider of this\.sourceBackedProviders\(settings\)\)/);
  assert.match(body, /provider\.scanSourceSummary\(ctx, source\)/);
  assert.doesNotMatch(body, /settings\.provider/);
});

test('StateManager invokes generic provider usage scans for non-source-backed providers', () => {
  const body = methodBody('scanGenericProviderUsage');

  assert.match(body, /for \(const provider of this\.enabledProviders\(settings\)\)/);
  assert.match(body, /provider\.scanUsage\(ctx\)/);
  assert.match(body, /isSourceBackedProvider\(provider\)/);
  assert.doesNotMatch(body, /sourceBackedProviders\(settings\)/);
});

test('StateManager refreshes quota through provider capabilities instead of hard-coded provider branches', () => {
  const body = methodBody('refreshProviderQuotas');
  const refreshBody = methodBody('heavyRefresh');

  assert.match(body, /for \(const provider of this\.enabledProviders\(settings\)\)/);
  assert.match(body, /provider\.fetchQuota/);
  assert.match(stateManagerSource, /applyProviderQuotaSnapshot/);
  assert.doesNotMatch(refreshBody, /isProviderEnabled\(settingsForApi, 'claude'\) \? this\.refreshApiUsagePct/);
  assert.doesNotMatch(refreshBody, /isProviderEnabled\(settingsForApi, 'codex'\) \? this\.refreshCodexUsagePct/);
  assert.doesNotMatch(stateManagerSource, /private async refreshAutoLimits/);
  assert.doesNotMatch(stateManagerSource, /private async refreshApiUsagePct/);
  assert.doesNotMatch(stateManagerSource, /private async refreshCodexUsagePct/);
});

test('provider adapter context does not expose the mutable Electron store', () => {
  const providerTypes = fs.readFileSync('src/main/providers/types.ts', 'utf8');

  assert.doesNotMatch(providerTypes, /store: Store<AppSettings>/);
  assert.doesNotMatch(stateManagerSource, /store: this\.store/);
  assert.match(providerTypes, /settings: AppSettings/);
});

test('StateManager ledger source discovery uses provider ledger sources', () => {
  const body = methodBody('ledgerSourceFiles');

  assert.match(body, /ProviderLedgerSource/);
  assert.match(body, /for \(const provider of this\.sourceBackedProviders\(settings\)\)/);
  assert.match(body, /provider\.ledgerSource/);
  assert.doesNotMatch(body, /provider\.id === 'codex' \? 'codex' : 'claude'/);

  const refreshBody = methodBody('refreshUsageLedgerSources');
  assert.match(refreshBody, /source\.importIntoSnapshot\(snapshot, Date\.now\(\)\)/);
});

test('StateManager session discovery and startup bootstrap use provider adapters', () => {
  const body = methodBody('buildScopedSessionInfosDetailed');

  assert.match(body, /this\.enabledProviders\(settings\)/);
  assert.match(body, /provider\.discoverSessions/);
  assert.match(body, /await provider\.discoverSessions/);
  assert.match(body, /provider\.buildStartupSession/);
  assert.doesNotMatch(body, /discoverSessions\(settings\.provider/);
  assert.doesNotMatch(body, /listRecentClaudeJsonlFiles/);
  assert.doesNotMatch(body, /listRecentCodexJsonlFiles/);
  assert.doesNotMatch(body, /buildStartupClaudeSession/);
  assert.doesNotMatch(body, /buildStartupCodexSession/);
});

test('StateManager recent watcher targets are assembled through source-backed providers', () => {
  const body = methodBody('buildRecentWatchTargets');

  assert.match(body, /for \(const provider of this\.sourceBackedProviders\(settings\)\)/);
  assert.match(body, /provider\.listRecentSources/);
  assert.doesNotMatch(body, /listRecentClaudeJsonlFiles/);
  assert.doesNotMatch(body, /listRecentCodexJsonlFiles/);
});
