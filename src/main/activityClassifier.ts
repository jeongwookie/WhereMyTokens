import { ActivityBreakdown } from './jsonlTypes';
import {
  type BreakdownDelta,
  emptyToolOutput,
  type ToolCategory,
} from '../shared/breakdownTypes';
import {
  assertCalibInBand,
  compositionToDelta,
  signatureProxyThinkingChars,
  splitOutput,
  type OutputWeights,
} from './outputSplitter';

export function classifyToolUse(name: string, input: unknown): keyof ActivityBreakdown {
  switch (name) {
    case 'Read': return 'read';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'apply_patch':
      return 'editWrite';
    case 'Grep':
    case 'Glob':
    case 'LS':
    case 'TodoRead':
    case 'TodoWrite':
      return 'search';
    case 'Agent':
      return 'subagents';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Bash': {
      const cmd = ((input as Record<string, unknown>)?.command as string ?? '').trimStart();
      if (/^git\b/.test(cmd)) return 'git';
      if (/\b(npm|yarn|pnpm|bun|tsc|tsx|ts-node|cargo|python|pytest|jest|vitest|make|cmake|gradle|mvn|dotnet|go\s+build|go\s+test)\b/.test(cmd)) {
        return 'buildTest';
      }
      return 'terminal';
    }
    case 'shell_command': {
      let cmd = '';
      if (typeof input === 'string') {
        try {
          const parsed = JSON.parse(input) as Record<string, unknown>;
          cmd = (parsed.command as string ?? '').trimStart();
        } catch {
          cmd = input.trimStart();
        }
      } else {
        cmd = ((input as Record<string, unknown>)?.command as string ?? '').trimStart();
      }
      if (/^git\b/.test(cmd)) return 'git';
      if (/\b(npm|yarn|pnpm|bun|tsc|tsx|ts-node|cargo|python|pytest|jest|vitest|make|cmake|gradle|mvn|dotnet|go\s+build|go\s+test)\b/.test(cmd)) {
        return 'buildTest';
      }
      return 'terminal';
    }
    default:
      if (name.startsWith('mcp__')) return 'terminal';
      return 'terminal';
  }
}

export interface ClaudeContentBlock { type?: string; thinking?: string; text?: string; name?: string; input?: unknown; signature?: string; data?: string }

/**
 * SESSION shape (jsonlParser): split `outputTokens` across content blocks by character
 * proportion. Mirrors jsonlParser.ts:506-531 EXACTLY (byte-identical behavior).
 */
export function claudeBlockBreakdown(content: unknown[], outputTokens: number): Partial<Record<keyof ActivityBreakdown, number>> {
  const delta: Partial<Record<keyof ActivityBreakdown, number>> = {};
  if (!(outputTokens > 0) || !Array.isArray(content)) return delta;
  const blockData: Array<{ cat: keyof ActivityBreakdown; chars: number }> = [];
  for (const block of content) {
    const item = block as ClaudeContentBlock;
    let chars = 0;
    let cat: keyof ActivityBreakdown = 'response';
    if (item.type === 'thinking') { chars = (item.thinking ?? '').length; cat = 'thinking'; }
    else if (item.type === 'text') { chars = (item.text ?? '').length; cat = 'response'; }
    else if (item.type === 'tool_use' && typeof item.name === 'string') {
      chars = JSON.stringify(item.input ?? {}).length + item.name.length;
      cat = classifyToolUse(item.name, item.input);
    }
    if (chars > 0) blockData.push({ cat, chars });
  }
  const totalChars = blockData.reduce((sum, b) => sum + b.chars, 0);
  if (totalChars <= 0) return delta;
  for (const { cat, chars } of blockData) {
    delta[cat] = (delta[cat] ?? 0) + Math.round((chars / totalChars) * outputTokens);
  }
  return delta;
}

export function claudeBlockWeights(content: unknown[]): OutputWeights {
  const weights: OutputWeights = { thinkingChars: 0, responseChars: 0, toolChars: emptyToolOutput() };
  for (const block of Array.isArray(content) ? content : []) {
    const item = block as ClaudeContentBlock;
    if (item.type === 'thinking') {
      const text = item.thinking ?? '';
      const signature = item.signature ?? '';
      if (text.length > 0 && signature.length > 0) assertCalibInBand(signature.length, text.length);
      weights.thinkingChars += text.length > 0 ? text.length : signatureProxyThinkingChars(signature.length);
    } else if (item.type === 'redacted_thinking') {
      weights.thinkingChars += signatureProxyThinkingChars((item.data ?? '').length);
    } else if (item.type === 'text') {
      weights.responseChars += (item.text ?? '').length;
    } else if (item.type === 'tool_use') {
      if (typeof item.name !== 'string') throw new Error('dirty Claude content: tool_use block without string name');
      const category = classifyToolUse(item.name, item.input) as ToolCategory;
      weights.toolChars[category] += JSON.stringify(item.input ?? {}).length + item.name.length;
    }
  }
  return weights;
}

/**
 * LEDGER shape (usage-ledger ingest). output = thinking/response/toolOutput TOKENS;
 * tool keys = COUNTS of tool_use blocks per classifyToolUse category.
 */
export function claudeLedgerBreakdown(content: unknown[], outputTokens: number): BreakdownDelta {
  const blocks = Array.isArray(content) ? content : [];
  const out = compositionToDelta(splitOutput(claudeBlockWeights(content), outputTokens));
  for (const block of blocks) {
    const item = block as ClaudeContentBlock;
    if (item.type === 'tool_use') {
      if (typeof item.name !== 'string') throw new Error('dirty Claude content: tool_use block without string name');
      out[classifyToolUse(item.name, item.input)] += 1; // count, not token share
    }
  }
  return out;
}

/** Codex tool activity: a single function_call event is +1 to its classified category (unit: count). */
export function codexFunctionCallCategory(name: string, args: unknown): ToolCategory {
  return classifyToolUse(name, args) as ToolCategory;
}
