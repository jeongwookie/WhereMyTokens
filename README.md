<p align="center">
  <img src="assets/source-icon.png" width="88" alt="WhereMyTokens icon" />
</p>

<h1 align="center">WhereMyTokens</h1>

<p align="center">
  <strong>Claude Code + Codex token usage, live in your Windows tray.</strong>
</p>

<p align="center">
  <img alt="Codex tracking" src="https://img.shields.io/badge/Codex_tracking-new-4f46e5?style=for-the-badge">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-supported-d97706?style=for-the-badge">
  <img alt="Local only" src="https://img.shields.io/badge/Local_only-no_cloud_sync-0f766e?style=for-the-badge">
</p>

<p align="center">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%2F11-0078d4?style=for-the-badge">
  <img alt="Release" src="https://img.shields.io/github/v/release/jeongwookie/WhereMyTokens?style=for-the-badge">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge">
</p>

<p align="center">
  <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.16.0/WhereMyTokens-Setup.exe"><strong>Download v1.16.0</strong></a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#screenshots">Screenshots</a>
</p>

<p align="center">
  A local-first Windows tray app for monitoring Claude Code and Codex tokens, costs, sessions, cache, model usage, and rate limits at a glance.
</p>

<a id="screenshots"></a>

<table>
  <tr>
    <th>Dark Overview</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-overview-dark.png" alt="WhereMyTokens dark overview collage" /></td>
  </tr>
  <tr>
    <th>Light Overview</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-overview-light.png" alt="WhereMyTokens light overview collage" /></td>
  </tr>
</table>

> Built by a Korean developer who uses Claude Code daily — scratching my own itch.

## What's New

| Version | Date | Highlights |
|---------|------|-----------|
| **[v1.16.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.16.0)** | May 26 | Add the persistent usage ledger, instant startup snapshots, and the Trend card for cost/token history with git net-line output |
| **[v1.15.3](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.15.3)** | May 25 | Route refresh work through a scheduler so startup, watcher, history, and manual refreshes stay serialized and the tray UI remains responsive |
| **[v1.15.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.15.2)** | May 21 | Include archived Codex logs and Claude agent logs in all-time usage, and show all-time session counts from full usage history |
| **[v1.15.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.15.1)** | May 21 | Keep hotkey popups responsive without losing full-session history, and keep tray helper windows out of the taskbar |
| **[v1.15.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.15.0)** | May 14 | Add a Settings toggle that keeps compact-widget waiting animations off by default while preserving syncing animation |

[→ Full changelog](https://github.com/jeongwookie/WhereMyTokens/releases)

---

## Download

**[⬇ Download Installer (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.16.0/WhereMyTokens-Setup.exe)** - just run and done

**[⬇ Download Portable ZIP](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.16.0/WhereMyTokens-v1.16.0-win-x64.zip)** - no install required

By downloading or installing, you agree to the [End-User License Agreement (EULA)](EULA.txt).

**Option A — Installer** _(recommended)_
1. Download `WhereMyTokens-Setup.exe` (link above)
2. Run the installer and follow the wizard
3. The app opens automatically and sits in your system tray

**Option B — Portable ZIP** _(no install required)_
1. Download `WhereMyTokens-v1.16.0-win-x64.zip` from the release page
2. Extract the zip anywhere
3. Run `WhereMyTokens.exe`

---

## Features

### Session Tracking
- **Claude + Codex provider modes** — track Claude only, Codex only, or both together in one dashboard
- **Live session detection** — Terminal, VS Code, Cursor, Windsurf, and more with real-time status: `active` / `waiting` / `idle` / `compacting`
- **Recent + active popup scope** — keep the tray popup focused on active sessions and recently touched work instead of reopening the full local archive on every refresh
- **Compact grouping** — sessions grouped by git project → branch, with repeated Claude/Codex sessions stacked by provider, source, model, and state
- **Branch row limit** — each branch shows the first 3 rows by default, with "Show N more" for the rest
- **Context window warnings** — per-session bar; amber at 70%, orange at 85%, red at 95%+
- **Tool usage bars** — proportional color bar + tool chips (Bash, Edit, Read, …)

### Rate Limits & Alerts
- **Rate limit bars** — Claude 5h/1w limits from Anthropic API/statusLine fallback, with passive OAuth refresh recovery when the local access token expires; Codex 5h/1w limits from live Codex usage, cache, then local rate-limit log events
- **Quota Pace view** — compares used quota % with elapsed window %; yellow/red means your burn rate is ahead of the reset window
- **Claude Code bridge** — register as a `statusLine` plugin for live rate limit data without API polling
- **Windows toast notifications** — at configurable usage thresholds (50% / 80% / 90%)
- **Claude Extra Usage budget** — Claude monthly credits used / limit / utilization %

### Analytics & Activity
- **Header stats** - today/all-time toggle: cost, API calls, sessions, cache efficiency, savings, compact Claude/Codex metadata, and provider health/fallback status. In `all`, session count comes from full usage history, not just currently visible rows
- **Instant startup snapshots** — the tray popup restores the last good UI state immediately while fresh scans continue in the background
- **Startup-friendly history sync** — current sessions and recent usage appear first; older history continues through a budgeted refresh scheduler with a `Partial History` banner so hotkeys and popup interactions stay responsive
- **Persistent usage ledger** — rolls local JSONL usage into a local aggregate ledger so older totals survive JSONL cache eviction, refresh faster after warmup, and can be repaired from Settings if needed
- **Trend card** — daily, weekly, or monthly cost/token trend overlaid with git net-line output, with partial data shown without false zero-value dips
- **Activity tabs** — 7-day heatmap, 5-month calendar (GitHub-style), hourly distribution, 4-week comparison
- **Rhythm tab** — time-of-day cost distribution (Morning/Afternoon/Evening/Night) with gradient bars, peak detail stats, local timezone
- **Model breakdown** — top per-model token and cost totals with gradient bars
- **Activity Breakdown** — Claude output-token categories and Codex tool-event categories (Thinking, Edit/Write, Read, Search, Git, etc.)

### Code Output & Productivity
- **Git-based metrics** — commits, net lines changed, **$/100 Added** (cost per 100 added lines)
- **Today vs all-time** - today shows actual cost per added line with average for comparison
- **Output growth chart** - shows cumulative net line growth from an all-time baseline across the latest 7 local days
- **Current session repo scope** - Code Output now labels that git totals are scoped to repos tied to your current tracked sessions
- **Branch-aware all-time** - all-time Code Output counts commits and line changes across local branches, using your local git author email
- **Auto-discovery** — Claude projects from `~/.claude/projects/` including agent usage logs, plus Codex sessions from `~/.codex/sessions/`, `~/.codex/archived_sessions/`, and `~/.codex/session-cleanup-archive/`
- **Your commits only** — filtered by `git config user.email`

### Customization
- **Auto/Light/Dark theme** — follows system preference by default
- **Cost display** — USD or KRW with configurable exchange rate
- **Floating usage widget** — compact Quota Pace window with always-on-top support; show/hide it from the main header, tray menu, Settings, or widget controls. Waiting animations are off by default and can be re-enabled in Settings
- **Tray label** — show usage %, token count, or cost directly in the taskbar
- **Dashboard layout** — reorder cards and hide cards you do not need
- **Project management** — hide or fully exclude projects from tracking
- **Start with Windows** — optional auto-launch at login

---

## Quick Start

### 1. Open the dashboard
Click the tray icon (or press the global shortcut `Ctrl+Shift+D`).

### 2. Connect Claude Code bridge (optional)
**Settings → Claude Code Integration → Setup** — enables live rate limit data without API polling.

### 3. Configure
- **Tracking Provider** — Claude / Codex / Both
- **Currency** — USD or KRW
- **Alerts** — set usage thresholds (50% / 80% / 90%)
- **Theme** — Auto (follows system) / Light / Dark
- **Tray label** — choose what to display in the taskbar
- **Main Layout** — reorder dashboard cards or hide optional cards
- **Data -> Rebuild ledger** — reset and replay the aggregate usage ledger from local history if you need to repair totals
- **Floating usage widget** — enable the compact Quota Pace window; use the main header toggle or tray menu to show or hide it later

---

## Architecture

WhereMyTokens is a local-first Electron tray app. The renderer never reads local files or credentials directly; all filesystem, provider API, tray, and settings work stays in the Electron main process and is exposed through the preload bridge.

| Layer | Responsibility |
|-------|----------------|
| Electron main | Discovers Claude/Codex sessions, parses JSONL logs, fetches provider usage, manages tray/window state, and persists app settings. |
| Preload bridge | Exposes the typed `window.wmt` IPC surface while keeping `contextIsolation` boundaries intact. |
| React renderer | Shows the tray dashboard, settings, notifications, activity charts, and the compact quota widget. |
| `statusLine` bridge | `src/bridge/bridge.ts` receives Claude Code JSON on stdin and writes a local bridge snapshot for the main process to watch. |

| Data flow | Source | Destination | Network |
|-----------|--------|-------------|---------|
| Claude sessions | `~/.claude/sessions/*.json`, `~/.claude/projects/**/*.jsonl` | Main-process parser/cache, then renderer state | No |
| Claude bridge | Claude Code `statusLine` stdin | `%APPDATA%\WhereMyTokens\live-session.json` | No |
| Claude usage limits | `~/.claude/.credentials.json` OAuth token | Anthropic `/api/oauth/usage` | Yes, direct to Anthropic |
| Codex sessions | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl`, `~/.codex/session-cleanup-archive/**/*.jsonl` | Main-process parser/cache, then renderer state | No |
| Codex usage limits | `~/.codex/auth.json` OAuth token | ChatGPT/Codex usage endpoint | Yes, direct to OpenAI/ChatGPT |
| Aggregate usage ledger | Local JSONL usage summaries | `%APPDATA%\WhereMyTokens\usage-ledger.json` | No |
| Git output ledger | Local git scans | `%APPDATA%\WhereMyTokens\git-output-ledger.json` | No |

Rate-limit precedence is provider-specific: Claude uses the Anthropic API first, then the `statusLine` bridge as fallback; Codex uses live usage first, then local `rate_limits` events from JSONL logs; both providers keep the last known value only until it becomes stale.

---

## Security & Privacy

WhereMyTokens reads local files and, when enabled, makes direct provider usage requests for your own account. There is no cloud sync and no telemetry.

| Local path | Purpose |
|------------|---------|
| `~/.claude/sessions/*.json` | Claude session metadata such as pid, cwd, and model. |
| `~/.claude/projects/**/*.jsonl` | Claude conversation logs used for token counts, costs, context, and activity summaries. |
| `~/.claude/.credentials.json` | Claude OAuth material used only for Anthropic usage requests and expired access-token refresh. |
| `~/.codex/sessions/**/*.jsonl` | Recent Codex session logs used for tokens, cached input, models, rate-limit events, and tool activity. |
| `~/.codex/archived_sessions/**/*.jsonl` | Archived Codex session logs included in all-time usage totals. |
| `~/.codex/session-cleanup-archive/**/*.jsonl` | Codex session-cleanup archives included in all-time usage totals. |
| `~/.codex/auth.json` | ChatGPT OAuth material used only for Codex usage snapshots; it is not logged or copied into app storage. |
| `%APPDATA%\WhereMyTokens\live-session.json` | Local bridge snapshot written by the Claude Code `statusLine` bridge. |
| `%APPDATA%\WhereMyTokens\usage-ledger.json` | Aggregated local usage ledger for long-range totals, trend buckets, and heatmaps. |
| `%APPDATA%\WhereMyTokens\git-output-ledger.json` | Aggregated daily git output snapshots used by Code Output and Trend. |
| Electron app data (`%APPDATA%\WhereMyTokens`) | App settings, local caches, notification history, and bridge state. |

Credential handling is intentionally narrow: WhereMyTokens reads provider credentials from the official local CLI files, does not ask you to paste API keys, does not store a separate credential backup, and redacts credential details from status output. If Claude's local access token expires, the app may refresh it through Anthropic and atomically write the updated credentials back to `~/.claude/.credentials.json`.

Network access is limited to provider usage endpoints for enabled provider modes. Claude usage polling runs at most every 5 minutes with 429 backoff. Codex live usage uses HTTPS-only requests with timeout, response-size cap, cache, and backoff. Local JSONL parsing and the `statusLine` bridge do not send session contents anywhere.

To disable the Claude Code bridge, open **Settings -> Claude Code Integration -> Disable**. The app removes the `statusLine` entry only when it owns the WhereMyTokens bridge command; it will not overwrite or delete another custom `statusLine`. Manual removal is also possible by deleting the WhereMyTokens `statusLine` entry from `~/.claude/settings.json`, then restarting Claude Code.

---

## Startup & Header States

At startup the dashboard shows current sessions and recent usage first. If you see `Partial History`, older history is still syncing in budgeted background slices so the tray app can open quickly and hotkey popups stay responsive.

The small PiP button in the header toggles the floating Quota Pace widget. The header status pill summarizes the most important provider/API state in one place. Common labels are `Claude local`, `Claude partial`, `Claude refresh`, `Claude login`, `Claude limited`, `Claude offline`, and `refresh failed`. The Quota Pace widget shows provider-specific health chips such as `Claude OK` and `Codex OK`; hover any pill for the latest detail.

---

## Provider Tracking Details

### Claude Code bridge

WhereMyTokens can receive live context, model, cost, and fallback rate-limit data through Claude Code's official `statusLine` plugin mechanism. Use **Settings -> Claude Code Integration -> Setup** to register the bridge, or **Disable** to remove the WhereMyTokens-owned bridge entry.

### Codex tracking

WhereMyTokens can also read Codex's local JSONL logs from `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl`, and `~/.codex/session-cleanup-archive/**/*.jsonl`. In Settings, choose **Claude**, **Codex**, or **Both**.

**What Codex tracking includes:**
- Session status, project/branch grouping, source labels such as VS Code or Codex Exec
- Model usage and API-equivalent cost estimates for GPT/Codex models
- Input, cached input, output tokens, cache savings, and all-time model totals
- 5h/1w Codex limit percentages and reset times from live Codex usage when available, with cache/local `rate_limits` fallback
- Activity Breakdown based on tool events, because Codex logs expose tool calls rather than per-tool output-token attribution

**Codex cache math:** Codex logs report `input_tokens` and `cached_input_tokens`. WhereMyTokens stores uncached input as `input_tokens - cached_input_tokens`, stores cached input as cache-read tokens, and shows cache efficiency as:

```text
cached_input_tokens / input_tokens
```

This differs from Claude, where cache efficiency is:

```text
cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens)
```

## How numbers work

All token counts include **input + output + cache creation + cache reads** where available. Cost is always an API-equivalent estimate using the app's local pricing table.

Claude reports input, output, cache creation, and cache reads. Codex reports raw input, cached input, and output; WhereMyTokens splits raw input into uncached input and cached input so cache savings and model totals are not double-counted.

| Display | Scope | What's counted |
|---------|-------|----------------|
| Header (today) | Since midnight | In/Out/Cache + calls, sessions, cache savings |
| Header (all) | All time | In/Out/Cache + calls, sessions, cache savings |
| Plan Usage (Claude 5h / 1w) | Claude reset window | Claude token types + API/statusLine limits |
| Plan Usage (Codex 5h / 1w) | Codex reset window | Codex token types + live/cache/log limit source |
| Model Usage | All time, top 4 models by provider | All token types |

> **Note:** `$` values are estimates — not your actual bill. Claude Max/Pro subscriptions are flat monthly fees. The cost display shows how much usage value you are getting.

---

## Activity tabs

| Tab | Description |
|-----|-------------|
| 7d | 7-day heatmap (day-of-week × hour grid) with time axis and color legend |
| 5mo | 5-month calendar grid (GitHub-style, hover for date + tokens) |
| Hourly | Hourly token distribution across the last 30 days |
| Weekly | Last 4 weeks horizontal bar chart |
| Rhythm | Time-of-day cost distribution — Morning ☀️ / Afternoon 🔥 / Evening 🌆 / Night 🌙 with gradient bars, peak detail stats (tokens, cost, requests %), and local timezone (30-day) |

---

## Activity Breakdown

Click the **Details** button on any session row to expand activity by category. Claude sessions show output-token attribution. Codex sessions show tool-event counts, because Codex logs expose function/tool calls rather than output tokens per tool.

| Category | Color | Source |
|----------|-------|--------|
| 💭 Thinking | Teal | Extended thinking blocks |
| 💬 Response | Slate | Text blocks — the final answer |
| 📄 Read | Blue | `Read` tool |
| ✏️ Edit / Write | Violet | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` |
| 🔍 Search | Sky | `Grep`, `Glob`, `LS`, `TodoRead`, `TodoWrite` |
| 🌿 Git | Green | `Bash` — `git` commands |
| ⚙️ Build / Test | Orange | `Bash` — `npm`, `tsc`, `jest`, `cargo`, `python`, etc. |
| 💻 Terminal | Amber | Other `Bash` commands; `mcp__*` tools |
| 🤖 Subagents | Pink | `Agent` tool |
| 🌐 Web | Purple | `WebFetch`, `WebSearch` |

> **Token attribution:** each turn's output tokens are split across content blocks by character proportion (`block_chars ÷ total_chars × output_tokens`). Zero-value categories are hidden.

---

## Install from Source

### Requirements

- Windows 10 / 11
- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://claude.ai/code) installed and logged in

### Build & Run

```bash
git clone https://github.com/jeongwookie/WhereMyTokens.git
cd WhereMyTokens
npm install
npm run build
npm start
```

### Build installer

```bash
npm run dist
# -> release/WhereMyTokens Setup x.x.x.exe  (NSIS installer)
# -> release/WhereMyTokens x.x.x.exe         (portable)
```

> **Note:** Building the NSIS installer on Windows requires Developer Mode enabled (Settings → For Developers → Developer Mode). The portable `.exe` in `release/win-unpacked/` works without it.

---

## Project structure

```
src/
  main/
    index.ts              Electron main, tray, popup window
    stateManager.ts       Polling, state assembly, bridge integration
    jsonlParser.ts        Parses conversation JSONL files (with incremental cache)
    jsonlCache.ts         mtime-based JSONL parse cache
    sessionDiscovery.ts   Reads ~/.claude/sessions/*.json
    usageWindows.ts       5h/1w window aggregation + heatmaps
    rateLimitFetcher.ts   Anthropic API usage fetch (with backoff)
    codexUsageFetcher.ts  Codex usage fetch (safe headers, backoff, cache)
    bridgeWatcher.ts      Watches live-session.json from statusLine bridge
    gitStatsCollector.ts  Git branch, commit, and line stats
    ipc.ts                IPC handlers, settings, integration setup
    preload.ts            contextBridge (window.wmt)
  bridge/
    bridge.ts             statusLine plugin: stdin → live-session.json
  renderer/
    App.tsx               Root with theme provider + system dark mode detection
    theme.ts              Light/Dark palettes + CSS custom properties
    views/                MainView, SettingsView, NotificationsView, HelpView
    components/           SessionRow, TokenStatsCard, ActivityChart, CodeOutputCard, ...
```

## Disclaimer

Costs shown are **API-equivalent estimates**, not actual billing. Claude Max/Pro subscriptions are flat monthly fees. The cost display shows how much usage value you are getting out of your subscription.

---

## Contributing

Issues and pull requests are welcome. Please open an issue first to discuss what you'd like to change.

---

## Acknowledgements

Inspired by [duckbar](https://github.com/rofeels/duckbar) — the macOS counterpart.

---

## License

MIT
