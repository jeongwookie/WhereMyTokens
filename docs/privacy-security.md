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
| `~/.codex/auth.json` | ChatGPT/Codex OAuth material for live usage snapshots and reset-credit availability checks. | Direct to OpenAI/ChatGPT when Codex is enabled |
| `~/.codex/config.toml` | Codex ChatGPT base URL setting. Custom/non-OpenAI hosts are detected locally and not used for token-bearing requests. | No |
| `~/.codex/.codex-global-state.json` | Codex account metadata such as service tier for header labels. Read only when Codex is enabled. | No |
| Antigravity language server on `127.0.0.1` | Local cascade sessions, model quota percentages, reset times, and token metadata. | Loopback only |
| `%APPDATA%\WhereMyTokens` | App settings, local caches, ledgers, notification history, bridge state, and auth-bound Codex reset-credit cache. | No |

## Credential Handling

WhereMyTokens reads provider credentials from official local CLI files. It does not ask you to paste API keys, does not keep a separate credential backup, and redacts credential details from status output.

If Claude's local access token expires, the app may refresh it through Anthropic and atomically write the updated credentials back to `~/.claude/.credentials.json`.

## Provider Controls

Disabled providers are not scanned locally and do not make live usage requests.

Claude usage polling runs with backoff. Codex live usage and reset-credit checks use HTTPS-only requests with timeout, response-size cap, cache, and separate backoff. Codex custom `chatgpt_base_url` proxies are not monitored, and WhereMyTokens does not send Codex auth tokens to non-OpenAI hosts. Codex reset-credit cache stores only availability counts, expiry timestamps, fetch status, source labels, a hashed auth marker, and the auth file modified time so it is discarded after login changes. Antigravity support uses loopback local RPC only; it does not read Google OAuth credentials, refresh tokens, cloud usage endpoints, credits, or offline `state.vscdb` data.

To disable the Claude Code bridge, open **Settings -> Claude Code Integration -> Disable**. The app removes only the WhereMyTokens-owned `statusLine` entry and leaves other custom `statusLine` settings intact.
