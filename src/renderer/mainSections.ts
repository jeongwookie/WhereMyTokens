export const MAIN_SECTION_IDS = ['planUsage', 'codeOutput', 'trend', 'sessions', 'activity', 'modelUsage'] as const;

export type MainSectionId = typeof MAIN_SECTION_IDS[number];

export const DEFAULT_MAIN_SECTION_ORDER: MainSectionId[] = [...MAIN_SECTION_IDS];

export const MAIN_SECTION_LABELS: Record<MainSectionId, string> = {
  planUsage: 'Plan Usage',
  codeOutput: 'Code Output',
  trend: 'Trend',
  sessions: 'Sessions',
  activity: 'Activity',
  modelUsage: 'Model Usage',
};

export function normalizeMainSectionOrder(value: readonly string[] | null | undefined): MainSectionId[] {
  const valid = new Set<string>(MAIN_SECTION_IDS);
  const seen = new Set<string>();
  const normalized: MainSectionId[] = [];

  for (const id of Array.isArray(value) ? value : []) {
    if (!valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id as MainSectionId);
  }

  for (const id of MAIN_SECTION_IDS) {
    if (!seen.has(id)) normalized.push(id);
  }

  return normalized;
}

export function normalizeHiddenMainSections(
  value: readonly string[] | null | undefined,
  order: readonly string[] | null | undefined = DEFAULT_MAIN_SECTION_ORDER,
): MainSectionId[] {
  const ordered = normalizeMainSectionOrder(order);
  const valid = new Set<string>(ordered);
  const seen = new Set<string>();
  const normalized: MainSectionId[] = [];

  for (const id of Array.isArray(value) ? value : []) {
    if (!valid.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id as MainSectionId);
  }

  if (normalized.length >= ordered.length) return [];
  return normalized;
}
