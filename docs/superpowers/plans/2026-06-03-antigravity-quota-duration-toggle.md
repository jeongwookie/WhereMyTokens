# Antigravity Quota Duration Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Based on current `main`, absorb masked Antigravity account labels, optional reset-time-derived 5h/weekly quota pace, and rich quota card title truncation without weakening `main`'s server identity, project filtering, or quota sanitization.

**Architecture:** Add one canonical boolean setting, `antigravityQuotaDurationPaceEnabled`, defaulting to `false`. Antigravity quota parsing keeps current percent-only behavior unless that setting is true. Account labels use the existing `maskEmail()` utility and stay local-RPC-only. Rich quota cards truncate long provider/period titles at render time while keeping the full title in the hover tooltip.

**Tech Stack:** Electron main process, TypeScript, React renderer, `electron-store` settings, Node test runner.

---

## File Structure

- Modify `src/main/ipc.ts`: add the canonical persisted setting, normalization, and default value.
- Modify `src/renderer/types.ts`: expose the setting in renderer `AppSettings`.
- Modify `src/renderer/App.tsx`: add the setting to boot fallback state and state normalization.
- Modify `src/renderer/views/SettingsView.tsx`: add a checkbox under Providers for Antigravity quota pace.
- Modify `src/main/providers/antigravity/quota.ts`: add masked `accountLabel`; add optional duration inference behind `ctx.settings.antigravityQuotaDurationPaceEnabled`.
- Modify `src/renderer/components/TokenStatsCard.tsx`: truncate rich card titles to 14 Unicode characters while preserving the full `title`.
- Modify `scripts/provider-settings.test.mjs`: cover settings defaults, normalization, renderer type, and settings UI exposure.
- Modify `scripts/antigravity-quota-parser.test.mjs`: cover default percent-only behavior and opt-in duration inference.
- Modify `scripts/antigravity-provider-integration.test.mjs`: cover masked account label and setting-driven duration output.
- Modify `scripts/state-readiness.test.mjs`: cover rich card title truncation source shape.
- PRD: no PRD file was found by `rg --files --encoding utf-8 | rg -i "(^|/)(prd|.*prd.*)\\.(md|txt|docx)$|PRD"`, so no PRD update is required unless one is added before implementation.

---

### Task 1: Add Canonical Setting

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/renderer/types.ts`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/views/SettingsView.tsx`
- Test: `scripts/provider-settings.test.mjs`

- [ ] **Step 1: Write failing settings tests**

Add these assertions to `scripts/provider-settings.test.mjs` in the existing settings tests:

```js
test('Antigravity quota duration pace setting defaults off and normalizes boolean values', () => {
  assert.equal(DEFAULT_SETTINGS.antigravityQuotaDurationPaceEnabled, false);
  assert.equal(normalizeSettings({}).antigravityQuotaDurationPaceEnabled, false);
  assert.equal(normalizeSettings({ antigravityQuotaDurationPaceEnabled: true }).antigravityQuotaDurationPaceEnabled, true);
  assert.equal(normalizeSettings({ antigravityQuotaDurationPaceEnabled: false }).antigravityQuotaDurationPaceEnabled, false);
  assert.equal(normalizeSettings({ antigravityQuotaDurationPaceEnabled: 'true' }).antigravityQuotaDurationPaceEnabled, false);
});
```

Extend `renderer settings model exposes enabledProviders as editable state`:

```js
assert.match(types, /antigravityQuotaDurationPaceEnabled: boolean/);
assert.match(settingsView, /'antigravityQuotaDurationPaceEnabled'/);
assert.match(settingsView, /Antigravity quota pace/);
```

- [ ] **Step 2: Run targeted test to verify failure**

Run: `npm.cmd run build:main && node --test scripts/provider-settings.test.mjs`

Expected before implementation: FAIL with missing `antigravityQuotaDurationPaceEnabled` assertions.

- [ ] **Step 3: Implement main-process setting schema**

In `src/main/ipc.ts`, update `AppSettings`:

```ts
  quotaTargetModes: Partial<Record<string, QuotaDisplayMode>>;
  quotaTargetOrder: string[];
  antigravityQuotaDurationPaceEnabled: boolean;
  compactWidgetEnabled: boolean;
```

In `normalizedSettingsPartial()` add:

```ts
  if (typeof record.antigravityQuotaDurationPaceEnabled === 'boolean') {
    next.antigravityQuotaDurationPaceEnabled = record.antigravityQuotaDurationPaceEnabled;
  }
```

In `DEFAULT_SETTINGS` add:

```ts
  quotaTargetModes: {},
  quotaTargetOrder: [],
  antigravityQuotaDurationPaceEnabled: false,
  compactWidgetEnabled: false,
```

- [ ] **Step 4: Implement renderer setting schema and boot default**

In `src/renderer/types.ts`, update `AppSettings`:

```ts
  quotaTargetModes: Partial<Record<string, QuotaDisplayMode>>;
  quotaTargetOrder: string[];
  antigravityQuotaDurationPaceEnabled: boolean;
  compactWidgetEnabled: boolean;
```

In `src/renderer/App.tsx`, update `DEFAULT_STATE.settings`:

```ts
    quotaTargetModes: {},
    quotaTargetOrder: [],
    antigravityQuotaDurationPaceEnabled: false,
    compactWidgetEnabled: false, compactWidgetWaitingAnimationEnabled: false, compactWidgetBounds: null,
```

In `src/renderer/App.tsx`, when normalizing incoming state settings near the existing quota target fields, add:

```ts
      antigravityQuotaDurationPaceEnabled: next.settings?.antigravityQuotaDurationPaceEnabled === true,
```

- [ ] **Step 5: Implement Settings UI checkbox**

In `src/renderer/views/SettingsView.tsx`, add the setting to `EDITABLE_SETTING_KEYS` after `quotaTargetOrder`:

```ts
  'quotaTargetModes',
  'quotaTargetOrder',
  'antigravityQuotaDurationPaceEnabled',
  'compactWidgetEnabled',
```

In `normalizeSettingsDraft()` add:

```ts
    antigravityQuotaDurationPaceEnabled: settings.antigravityQuotaDurationPaceEnabled === true,
```

Under the Providers section, after the provider checkbox block and before `quotaTargetOptions`, add:

```tsx
        {enabledProvidersFromSettings(s).includes('antigravity') && (
          <div style={row}>
            <div>
              <div style={labelStyle}>Antigravity quota pace</div>
              <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>
                Infer 5h or weekly pacing from reset times; off keeps Antigravity model quotas percent-only
              </div>
            </div>
            <input
              type="checkbox"
              style={chk}
              checked={s.antigravityQuotaDurationPaceEnabled}
              onChange={e => setS({ ...s, antigravityQuotaDurationPaceEnabled: e.target.checked })}
            />
          </div>
        )}
```

- [ ] **Step 6: Run settings test**

Run: `npm.cmd run build:main && node --test scripts/provider-settings.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/main/ipc.ts src/renderer/types.ts src/renderer/App.tsx src/renderer/views/SettingsView.tsx scripts/provider-settings.test.mjs
git commit -m "feat: add Antigravity quota pace setting"
```

---

### Task 2: Add Masked Account Label And Optional Duration Inference

**Files:**
- Modify: `src/main/providers/antigravity/quota.ts`
- Test: `scripts/antigravity-quota-parser.test.mjs`
- Test: `scripts/antigravity-provider-integration.test.mjs`

- [ ] **Step 1: Write failing parser tests**

In `scripts/antigravity-quota-parser.test.mjs`, keep the existing default percent-only tests and add:

```js
test('Antigravity quota parser infers 5h and weekly duration only when enabled', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  const models = parseAntigravityModelQuotas([
    {
      label: 'Gemini 3 Pro',
      modelOrAlias: { model: 'MODEL_GEMINI_3_PRO' },
      quotaInfo: { remainingFraction: 0.5, resetTime: now + 2 * 60 * 60 * 1000 },
    },
    {
      label: 'Claude Opus',
      modelOrAlias: { model: 'MODEL_CLAUDE_OPUS' },
      quotaInfo: { remainingFraction: 0.4, resetTime: now + 6 * 60 * 60 * 1000 },
    },
  ], now, { inferDurationFromReset: true });

  assert.equal(models[0].durationMs, 5 * 60 * 60 * 1000);
  assert.equal(models[0].visualKind, 'pace');
  assert.equal(models[1].durationMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(models[1].visualKind, 'pace');
});
```

In `scripts/antigravity-provider-integration.test.mjs`, extend the first integration test:

```js
    assert.equal(quota.accountLabel, 'pe***@example.com');
    assert.equal(quota.models[0].durationMs, undefined);
    assert.equal(quota.models[0].visualKind, 'percentOnly');
```

Add a second quota call in that same server block:

```js
    const quotaWithPace = await fetchAntigravityQuotaFromServers(
      context({
        nowMs,
        settings: {
          enabledProviders: ['antigravity'],
          antigravityQuotaDurationPaceEnabled: true,
        },
      }),
      [serverInfo],
    );
    assert.equal(quotaWithPace.models[0].durationMs, 5 * 60 * 60 * 1000);
    assert.equal(quotaWithPace.models[0].visualKind, 'pace');
```

- [ ] **Step 2: Run targeted tests to verify failure**

Run: `npm.cmd run build:main && node --test scripts/antigravity-quota-parser.test.mjs scripts/antigravity-provider-integration.test.mjs`

Expected before implementation: FAIL because `parseAntigravityModelQuotas()` does not accept the option and quota snapshots do not set `accountLabel`.

- [ ] **Step 3: Implement optional duration inference**

In `src/main/providers/antigravity/quota.ts`, update imports:

```ts
import { maskEmail, parseTimestampMs } from './pathUtils';
```

Add constants and options near the existing helper functions:

```ts
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface AntigravityQuotaParseOptions {
  inferDurationFromReset?: boolean;
}
```

Add helper:

```ts
function durationMsFromReset(resetMs: number | null, enabled: boolean): number | undefined {
  if (!enabled || resetMs == null) return undefined;
  return resetMs <= FIVE_HOURS_MS ? FIVE_HOURS_MS : WEEK_MS;
}
```

Change `parseAntigravityModelQuotas()` signature and model construction:

```ts
export function parseAntigravityModelQuotas(
  configs: AntigravityModelConfig[],
  nowMs: number,
  options: AntigravityQuotaParseOptions = {},
): ProviderModelQuota[] {
  return configs
    .filter(config => !!config.quotaInfo)
    .map((config): ProviderModelQuota | null => {
      const remainingPct = remainingPctFromFraction(config.quotaInfo?.remainingFraction);
      if (remainingPct == null) return null;
      const model = config.modelOrAlias?.model || config.label || 'unknown';
      const label = config.label || model;
      const resetMs = resetMsFromValue(config.quotaInfo?.resetTime, nowMs);
      const durationMs = durationMsFromReset(resetMs, options.inferDurationFromReset === true);
      const usageModel = normalizeAntigravityModel(model, new Map([[model, label]]));
      return {
        model,
        label,
        statsWindowKey: `model.${model}`,
        remainingPct,
        resetMs,
        defaultMode: defaultQuotaModeForModel(label, model),
        usageModel,
        visualKind: durationMs ? 'pace' : 'percentOnly',
        cacheMetricTitle: 'Cache read / prompt tokens',
        durationMs,
        hideCost: !resolveAntigravityPriceForModel(usageModel, `${model} ${label}`),
      };
    })
    .filter((quota): quota is ProviderModelQuota => !!quota);
}
```

- [ ] **Step 4: Implement masked account label and setting pass-through**

Change `snapshotFromStatus()`:

```ts
function snapshotFromStatus(
  response: AntigravityUserStatusResponse,
  nowMs: number,
  options: AntigravityQuotaParseOptions = {},
): ProviderQuotaSnapshot {
  const userStatus = response.userStatus;
  const rawConfigs = userStatus?.cascadeModelConfigData?.clientModelConfigs;
  const configs = Array.isArray(rawConfigs)
    ? rawConfigs.filter((config): config is AntigravityModelConfig => !!config && typeof config === 'object' && !Array.isArray(config))
    : [];
  return {
    provider: 'antigravity',
    source: 'localRpc',
    capturedAt: nowMs,
    accountLabel: maskEmail(userStatus?.email),
    planName: userStatus?.planStatus?.planInfo?.planName,
    models: parseAntigravityModelQuotas(configs, nowMs, options),
    status: {
      connected: true,
      code: 'connected',
      label: 'Connected',
      severity: 'ok',
    },
  };
}
```

In `fetchAntigravityQuotaFromServers()`, call:

```ts
        snapshot: snapshotFromStatus(status, ctx.nowMs, {
          inferDurationFromReset: ctx.settings.antigravityQuotaDurationPaceEnabled === true,
        }),
```

- [ ] **Step 5: Run Antigravity quota tests**

Run: `npm.cmd run build:main && node --test scripts/antigravity-quota-parser.test.mjs scripts/antigravity-provider-integration.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/main/providers/antigravity/quota.ts scripts/antigravity-quota-parser.test.mjs scripts/antigravity-provider-integration.test.mjs
git commit -m "feat: add Antigravity quota account and pace inference"
```

---

### Task 3: Add Rich Card Title Truncation

**Files:**
- Modify: `src/renderer/components/TokenStatsCard.tsx`
- Test: `scripts/state-readiness.test.mjs`

- [ ] **Step 1: Write failing source regression test**

In `scripts/state-readiness.test.mjs`, add a new test near the renderer display tests:

```js
test('rich quota card titles truncate visually while preserving full hover title', () => {
  const source = fs.readFileSync(path.resolve('src', 'renderer', 'components', 'TokenStatsCard.tsx'), 'utf8');

  assert.match(source, /function truncateTitle\(title: string, maxChars = 14\): string/);
  assert.match(source, /const visibleTitle = truncateTitle\(displayTitle\)/);
  assert.match(source, /title=\{displayTitle\}/);
  assert.match(source, /\{visibleTitle\}/);
});
```

- [ ] **Step 2: Run targeted test to verify failure**

Run: `npm.cmd run build:main && node --test scripts/state-readiness.test.mjs`

Expected before implementation: FAIL on missing `truncateTitle()` and `visibleTitle` patterns.

- [ ] **Step 3: Implement Unicode-safe title truncation**

In `src/renderer/components/TokenStatsCard.tsx`, add this helper after `formatUsagePct()`:

```ts
function truncateTitle(title: string, maxChars = 14): string {
  const chars = Array.from(title);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : title;
}
```

Inside `TokenStatsCard()`, after:

```ts
  const displayTitle = `${provider} ${period}`;
```

add:

```ts
  const visibleTitle = truncateTitle(displayTitle);
```

In the rich-card title span, replace:

```tsx
            {displayTitle}
```

with:

```tsx
            {visibleTitle}
```

Keep the existing `title={displayTitle}` prop unchanged so the full title remains available on hover.

- [ ] **Step 4: Run renderer/source test**

Run: `npm.cmd run build:main && node --test scripts/state-readiness.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/renderer/components/TokenStatsCard.tsx scripts/state-readiness.test.mjs
git commit -m "feat: truncate rich quota card titles"
```

---

### Task 4: Final Verification And Packaging Check

**Files:**
- No code changes unless a verification failure identifies a scoped bug.

- [ ] **Step 1: Run focused regression suite**

Run:

```bash
node --test scripts/provider-settings.test.mjs scripts/antigravity-quota-parser.test.mjs scripts/antigravity-provider-integration.test.mjs scripts/state-readiness.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run production build**

Run:

```bash
npm.cmd run build
```

Expected: TypeScript and renderer build complete without errors.

- [ ] **Step 3: Optional packaging only if user asks for exe**

Run:

```bash
npm.cmd run dist
```

Expected: `release/WhereMyTokens 1.18.0.exe` and `release/WhereMyTokens Setup 1.18.0.exe` are rebuilt from this branch.

- [ ] **Step 4: Final commit if previous tasks were squashed manually**

If the implementation was done without per-task commits, create one scoped commit:

```bash
git add src/main/ipc.ts src/renderer/types.ts src/renderer/App.tsx src/renderer/views/SettingsView.tsx src/main/providers/antigravity/quota.ts src/renderer/components/TokenStatsCard.tsx scripts/provider-settings.test.mjs scripts/antigravity-quota-parser.test.mjs scripts/antigravity-provider-integration.test.mjs scripts/state-readiness.test.mjs
git commit -m "feat: add optional Antigravity quota pacing"
```

---

## Self-Review

- Spec coverage: masked account label is in Task 2; optional reset-derived 5h/weekly duration is in Tasks 1 and 2; default-off behavior is in Tasks 1 and 2; rich card 14-character title truncation is in Task 3.
- Placeholder scan: no task uses TBD, TODO, or generic "add tests" wording without concrete code and commands.
- Type consistency: the setting name is `antigravityQuotaDurationPaceEnabled` across main IPC, renderer types, renderer default state, Settings UI, and quota parser pass-through.
- Boundary preservation: no task removes `serverIdentity`, `projectKeys`, legacy provider migration, quota sanitize, existing tray behavior, or existing percent-only default behavior.
