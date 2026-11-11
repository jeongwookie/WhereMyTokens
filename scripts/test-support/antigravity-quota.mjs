export const QUOTA_NOW = Date.parse('2026-11-11T03:00:00Z');
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function antigravityQuotaFixture() {
  const reset = offset => new Date(QUOTA_NOW + offset).toISOString();
  const model = (label, raw, modelId, offset) => ({
    label, modelOrAlias: { model: raw }, modelId,
    quotaInfo: { remainingFraction: 0.42, resetTime: reset(offset) },
  });
  const bucket = (bucketId, window, offset) => ({
    bucketId, window, remainingFraction: 0.75, resetTime: reset(offset),
  });
  return {
    configs: [
      model('Gemini 3.8 Flash (Medium)', 'MODEL_PLACEHOLDER_M319', 'gemini-3.8-flash-medium', 2 * HOUR_MS),
      model('Gemini 3.8 Flash (High)', 'MODEL_PLACEHOLDER_M318', 'gemini-3.8-flash-high', 2 * HOUR_MS),
      model('Claude Opus 5.5 (High)', 'MODEL_PLACEHOLDER_M402', 'claude-opus-5-5-high', 3 * DAY_MS),
      model('Claude Sonnet 5.5 (High)', 'MODEL_PLACEHOLDER_M405', 'claude-sonnet-5-5-high', 3 * DAY_MS),
      model('GPT-OSS 120B (Medium)', 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', 'gpt-oss-120b-medium', 3 * DAY_MS),
      model('Gemini 4 Argon (High)', 'MODEL_PLACEHOLDER_M417', 'gemini-4-argon-high', 5 * DAY_MS),
      model('Gemini 4 Argon (Medium)', 'MODEL_PLACEHOLDER_M418', 'gemini-4-argon-medium', 5 * DAY_MS),
      { label: 'Gemini 4 Carbon', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M670' }, disabled: true, quotaInfo: {} },
    ],
    response: { response: { groups: [
      { displayName: 'Gemini Models', buckets: [
        bucket('gemini-weekly', 'weekly', 6 * DAY_MS),
        bucket('gemini-5h', '5h', 2 * HOUR_MS),
      ] },
      { displayName: 'Claude and GPT models', buckets: [
        bucket('3p-weekly', 'weekly', 3 * DAY_MS),
        bucket('3p-5h', '5h', HOUR_MS),
      ] },
      { displayName: 'Gemini 4 Argon', buckets: [
        bucket('gemini-argon-wtu-weekly', 'weekly', 5 * DAY_MS),
      ] },
    ] } },
  };
}
