import type { AppSettings } from './ipc';
import type { AppState } from './stateManager';
import type { QuotaDisplayMode } from '../shared/quotaTypes';
import { groupQuotaEntries } from '../shared/quotaDomain';

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

function targetMode(settings: AppSettings, groupId: string, defaultMode: QuotaDisplayMode): QuotaDisplayMode {
  return settings.quotaTargetModes?.[groupId] ?? defaultMode;
}

export function compactWidgetTargetSummary(settings: AppSettings, state?: AppState | null): CompactWidgetTargetSummary {
  let groupCount = 0;
  let rowCount = 0;

  for (const provider of settings.enabledProviders) {
    const quota = state?.providerQuotas?.[provider];
    if (!quota) continue;
    for (const group of groupQuotaEntries(quota.entries)) {
      if (targetMode(settings, group.target.id, group.target.defaultMode) === 'none') continue;
      groupCount += 1;
      rowCount += group.entries.length;
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
