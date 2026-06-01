# Quota Target Usage Filtering Plan

> Final design update: provider enablement controls usage statistics. Quota target display modes control Plan Usage and floating widget presentation only.

## Goal

- `enabledProviders` controls provider scope for usage statistics and alerts.
- `quotaTargetModes` controls Plan Usage and floating widget presentation only.
- If a provider is enabled, its usage counts even when all of its quota targets are set to `None`.
- If a provider is disabled, its usage does not count even when one of its persisted quota target modes is `Rich` or `Simple`.

## Architecture

- Provider quota snapshots own display metadata: groups, windows, row labels, badges, colors, and default display modes.
- `UsageVisibilityFilter` owns only provider visibility from `enabledProviders`.
- Main-process usage aggregation receives the provider filter and applies it consistently to summary fallback, ledger usage, trend, session counts, quota window stats, heatmaps, time-of-day buckets, and model totals.
- Renderer normalizes provider usage windows generically and preserves arbitrary provider/window keys such as future Antigravity model windows.
- `usageScope` is not part of the quota metadata shape. Provider/model stats are not derived from quota target scopes.

## Implementation

- `src/main/usageVisibilityFilter.ts`
  - Build `providerScopes` from `settings.enabledProviders`.
  - Do not read `providerQuotas` or `settings.quotaTargetModes`.

- `src/main/usageWindows.ts`
  - Filter all usage rows by provider visibility.
  - Aggregate custom provider windows provider-wide.
  - Use `providerQuotas[provider].windows[windowKey].resetMs` for that window before falling back to generic reset hints.

- `src/main/usageLedgerUsage.ts`
  - Filter daily, monthly, minute, and hourly aggregate rows by provider visibility.
  - Aggregate provider windows provider-wide.

- `src/main/stateManager.ts`
  - Build the usage visibility filter from settings only.
  - Count ledger checkpoints by provider visibility plus `hasUsage`/`needsRebuild`; do not require `rawModel`.
  - Count summary fallback sessions by provider visibility plus actual usage.

- `src/renderer/App.tsx`
  - Normalize `usage.byProvider` with a generic window map helper.
  - Preserve every incoming window key instead of hardcoding `h5`/`week` per provider.

- `src/main/providers/types.ts` and `src/renderer/types.ts`
  - Keep quota display metadata display-only.
  - Do not define `ProviderQuotaUsageScope` or `usageScope`.

## Tests

- `scripts/usage-visibility-filter.test.mjs`
  - Enabled providers define visibility.
  - Quota target modes do not define visibility.

- `scripts/provider-usage-shape.test.mjs`
  - Custom windows aggregate provider-wide.
  - Custom windows use their own reset time.
  - Quota metadata has no usage-scope shape.

- `scripts/usage-ledger-usage.test.mjs`
  - Ledger usage and trend queries filter by provider visibility.

- `scripts/usage-ledger-state.test.mjs`
  - All-time session count does not depend on checkpoint `rawModel`.

- `scripts/stability-regressions.test.mjs`
  - Summary fallback session counts use the same provider visibility rule.

- `scripts/state-readiness.test.mjs`
  - Renderer state normalization preserves arbitrary provider window keys.

## Documentation

- `README.md` and `README.zh-CN.md` describe provider-driven statistics:
  - `Providers` controls scanning, quota fetching, sessions, statistics, and alerts.
  - `Quota display` affects Plan Usage and the floating widget only.
