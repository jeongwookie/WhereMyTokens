# Privacy And Security

WhereMyTokens is local-first. There is no cloud sync and no telemetry.

## Data Sources

| Source | Purpose | Network |
|--------|---------|---------|
| `~/.claude/sessions/*.json` | Claude session metadata such as pid, cwd, and model. | No |
| `~/.claude/projects/**/*.jsonl` | Claude token counts, costs, context, and activity summaries. | No |
| `~/.claude/.credentials.json` | Claude OAuth material for Anthropic usage requests and token refresh. | Direct to Anthropic when Claude is enabled |
| `~/.codex/sessions/**/*.jsonl` | Recent Codex tokens, cached input, models, rate-limit events, and tool activity. | No |
| `~/.codex/archived_sessions/**/*.jsonl` | Archived Codex logs included in all-time totals. | No |
| `~/.codex/session-cleanup-archive/**/*.jsonl` | Codex cleanup archives included in all-time totals. | No |
| `~/.codex/auth.json` | ChatGPT/Codex OAuth material for live usage snapshots. | Direct to OpenAI/ChatGPT when Codex is enabled |
| Antigravity language server on `127.0.0.1` | Local cascade sessions, model quota percentages, reset times, and token metadata. | Loopback only |
| `%APPDATA%\WhereMyTokens` | App settings, local caches, ledgers, notification history, and bridge state. | No |
| Taskbar mini helper stdin | Optional summarized quota snapshot for fixed `5h` and `1w` rows plus current light/dark display theme fallback. | No |
| `%LOCALAPPDATA%\WhereMyTokens\TaskbarHelper\layout.json` | Optional taskbar-relative helper position. | No |

## Credential Handling

WhereMyTokens reads provider credentials from official local CLI files. It does not ask you to paste API keys, does not keep a separate credential backup, and redacts credential details from status output.

If Claude's local access token expires, the app may refresh it through Anthropic and atomically write the updated credentials back to `~/.claude/.credentials.json`.

## Provider Controls

Disabled providers are not scanned locally and do not make live usage requests.

Claude usage polling runs with backoff. Codex live usage uses HTTPS-only requests with timeout, response-size cap, cache, and backoff. Antigravity support uses loopback local RPC only; it does not read Google OAuth credentials, refresh tokens, cloud usage endpoints, credits, or offline `state.vscdb` data.

The optional Windows taskbar mini helper receives only summarized quota display data and the current light/dark display theme fallback from the Electron main process. It samples the visible taskbar background under itself to choose readable text contrast. It does not read provider credentials, provider logs, local provider files, or call provider APIs. It may save its taskbar-relative position locally so the display can be dragged away from other taskbar content. In this version it is limited to fixed `5h` and `1w` taskbar rows.

To disable the Claude Code bridge, open **Settings -> Claude Code Integration -> Disable**. The app removes only the WhereMyTokens-owned `statusLine` entry and leaves other custom `statusLine` settings intact.
