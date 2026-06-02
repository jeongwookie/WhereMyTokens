import type { QuotaDisplayMode } from '../types';

const LEGACY_MODEL_MAP: Record<string, string> = {
  MODEL_CLAUDE_4_5_SONNET: 'Claude 4.5 Sonnet',
};

export function buildModelLabelMap(
  configs: Array<{ label?: string; modelOrAlias?: { model?: string } }>,
): Map<string, string> {
  const map = new Map<string, string>(Object.entries(LEGACY_MODEL_MAP));
  for (const config of configs) {
    const model = config.modelOrAlias?.model;
    const label = config.label;
    if (model && label) map.set(model, label);
  }
  return map;
}

export function normalizeAntigravityModel(modelOrLabel: string, labelMap?: Map<string, string>): string {
  return labelMap?.get(modelOrLabel) ?? modelOrLabel;
}

export function defaultQuotaModeForModel(label: string, model: string): QuotaDisplayMode {
  const text = `${label} ${model}`.toLowerCase();
  if (/gemini[\s-]*3/.test(text) && text.includes('pro')) return 'simple';
  if (text.includes('claude') && text.includes('opus')) return 'simple';
  return 'none';
}
