export function isClaudeJsonlName(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.jsonl');
}

export function isClaudeAgentJsonlName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.startsWith('agent-') || lower.startsWith('agents-');
}

export function compareClaudeSessionJsonlNames(a: string, b: string): number {
  const agentRankA = isClaudeAgentJsonlName(a) ? 1 : 0;
  const agentRankB = isClaudeAgentJsonlName(b) ? 1 : 0;
  return agentRankA - agentRankB || a.localeCompare(b);
}
