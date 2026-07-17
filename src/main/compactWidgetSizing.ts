import type { AppSettings } from './ipc';
import type { AppState } from './stateManager';
import type { ProviderId, ProviderQuotaWindow, QuotaDisplayMode } from './providers/types';
import type { WindowStats } from './usageWindows';

export const WIDGET_WIDTH = 320;

const WIDGET_MIN_HEIGHT = 104;
const WIDGET_STATIC_HEIGHT = 76;
const WIDGET_GROUP_HEADER_HEIGHT = 13;
const WIDGET_TARGET_ROW_HEIGHT = 14;
const WIDGET_TARGET_ROW_GAP = 5;
const WIDGET_GROUP_GAP = 9;

export interface CompactWidgetTargetSummary {
  groupCount: number;
  rowCount: number;
}

function quotaGroupId(provider: ProviderId, groupKey: string): string {
  return `${provider}.group.${encodeURIComponent(groupKey)}`;
}

function modelQuotaGroupKey(model: string): string {
  return `model.${model}`;
}

function targetMode(settings: AppSettings, groupId: string, defaultMode: QuotaDisplayMode): QuotaDisplayMode {
  return settings.quotaTargetModes?.[groupId] ?? defaultMode;
}

function hasLimitData(window: ProviderQuotaWindow | undefined): boolean {
  return !!window && (window.pct > 0 || window.resetMs != null || !!window.resetLabel || window.limitState === 'unlimited' || window.limitState === 'unreported');
}

function hasUsageData(stats: WindowStats | undefined): boolean {
  return !!stats && stats.totalTokens > 0;
}

function hasQuotaSignal(window: ProviderQuotaWindow | undefined): boolean {
  return hasLimitData(window) || !!window?.source;
}

function hasDisplayRowSignal(window: ProviderQuotaWindow | undefined, stats: WindowStats | undefined): boolean {
  return hasQuotaSignal(window) || hasUsageData(stats);
}

export function compactWidgetTargetSummary(settings: AppSettings, state?: AppState | null): CompactWidgetTargetSummary {
  let groupCount = 0;
  let rowCount = 0;

  for (const provider of settings.enabledProviders) {
    const quota = state?.providerQuotas?.[provider];
    if (!quota) continue;
    const coveredModelGroups = new Set<string>();
    for (const group of quota.groups ?? []) {
      coveredModelGroups.add(group.key);
      const groupId = quotaGroupId(provider, group.key);
      if (targetMode(settings, groupId, group.defaultMode) === 'none') continue;
      const rows = group.windowKeys.filter(windowKey => {
        if (!state) return true;
        return hasDisplayRowSignal(
          quota.windows?.[windowKey],
          state.usage?.byProvider?.[provider]?.windows?.[windowKey],
        );
      });
      if (rows.length === 0) continue;
      groupCount += 1;
      rowCount += rows.length;
    }
    for (const model of quota.models ?? []) {
      const groupKey = model.groupKey ?? modelQuotaGroupKey(model.model);
      if (coveredModelGroups.has(groupKey)) continue;
      const groupId = quotaGroupId(provider, groupKey);
      if (targetMode(settings, groupId, model.defaultMode ?? 'simple') === 'none') continue;
      groupCount += 1;
      rowCount += 1;
    }
  }

  return { groupCount, rowCount };
}

export function compactWidgetSize(settings: AppSettings, state?: AppState | null): { width: number; height: number } {
  const { groupCount, rowCount } = compactWidgetTargetSummary(settings, state);
  const rowGaps = Math.max(0, rowCount - groupCount);
  const groupGaps = Math.max(0, groupCount - 1);
  const estimatedHeight = WIDGET_STATIC_HEIGHT
    + groupCount * WIDGET_GROUP_HEADER_HEIGHT
    + rowCount * WIDGET_TARGET_ROW_HEIGHT
    + rowGaps * WIDGET_TARGET_ROW_GAP
    + groupGaps * WIDGET_GROUP_GAP;
  return {
    width: WIDGET_WIDTH,
    height: Math.max(WIDGET_MIN_HEIGHT, estimatedHeight),
  };
}
