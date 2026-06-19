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
| `\\wsl.localhost\<distro>\home\<user>\.claude` and `\\wsl.localhost\<distro>\home\<user>\.codex` | Optional WSL tracking for Claude/Codex logs when enabled in Settings. The app discovers user distros with `wsl.exe --list --quiet` and reads `$HOME` with `wsl.exe --exec printenv HOME`. | No |
| Antigravity language server on `127.0.0.1` | Local cascade sessions, model quota percentages, reset times, and token metadata. | Loopback only |
| `%APPDATA%\WhereMyTokens` | App settings, local caches, ledgers, notification history, and bridge state. | No |

## Credential Handling

WhereMyTokens reads provider credentials from official local CLI files. It does not ask you to paste API keys, does not keep a separate credential backup, and redacts credential details from status output.

If Claude's local access token expires, the app may refresh it through Anthropic and atomically write the updated credentials back to `~/.claude/.credentials.json`.

## Provider Controls

Disabled providers are not scanned locally and do not make live usage requests.

WSL tracking is off by default. When enabled, it scans only detected user WSL distributions for Claude/Codex logs and maps session paths under the distro home directory or mounted Windows drives. Docker internal WSL distributions are ignored.

Claude usage polling runs with backoff. Codex live usage uses HTTPS-only requests with timeout, response-size cap, cache, and backoff. Antigravity support uses loopback local RPC only; it does not read Google OAuth credentials, refresh tokens, cloud usage endpoints, credits, or offline `state.vscdb` data.

To disable the Claude Code bridge, open **Settings -> Claude Code Integration -> Disable**. The app removes only the WhereMyTokens-owned `statusLine` entry and leaves other custom `statusLine` settings intact.
