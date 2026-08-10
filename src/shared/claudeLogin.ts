export type ClaudeLoginLaunchFailure = 'unsupported-platform' | 'claude-not-found' | 'launch-failed';

export type ClaudeLoginLaunchResult =
  | { ok: true }
  | { ok: false; reason: ClaudeLoginLaunchFailure };
