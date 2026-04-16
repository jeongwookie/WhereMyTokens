<img src="assets/source-icon.png" width="80" align="right" />

# WhereMyTokens

**Windows system tray app for monitoring Claude Code token usage in real time.**

Built by a Korean developer who uses Claude Code daily — scratching my own itch.

Sits quietly in your taskbar and shows Claude Code usage — tokens, costs, session activity, and rate limits — at a glance.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[한국어](README.ko.md) · [日本語](README.ja.md)

<div align="center">

https://github.com/user-attachments/assets/98b6f8d7-6fc6-4c12-aef1-af6300db0728

</div>

---

## Features

- **Live session tracking** — detects running Claude Code sessions (Terminal, VS Code, Cursor, Windsurf, etc.) with real-time status: `active` / `waiting` / `idle` / `compacting`
- **2-level session grouping** — sessions grouped by git project → branch, with per-project commit stats and line counts; idle sessions progressively collapse (top-3 tools → context bar only → single-line summary)
- **Rate limit bars** — 5h and 1w usage from Anthropic's API, with progress bars, time-to-reset counters, and cache efficiency grades (Excellent/Good/Fair/Poor)
- **Claude Code bridge** — register WhereMyTokens as a Claude Code `statusLine` plugin for live rate limit data without API polling
- **Code Output** — git-based productivity metrics: commits, net lines changed, and **Claude ROI** (cost per 1K lines added) with today/all-time toggle; today shows an efficiency label (Excellent/Good/Normal/Low/Exploring) vs your all-time average; auto-discovers every project you've ever used Claude on via `~/.claude/projects/` history — no active session required; only your commits are counted (filtered by `git config user.email`)
- **Context window warnings** — per-session context bar; amber at 50%, orange at 80%, red at 95%+, with "⚠ near limit" / "⚠ at limit" labels
- **Tool usage bars** — proportional color bar + tool chips (Bash, Edit, Read, …) per session
- **Activity Breakdown** — click the **Breakdown** button on any session row to expand a per-category token breakdown: Read, Edit/Write, Search, Git, Build/Test, Terminal, Subagents, Thinking, and Response; shows what Claude actually spent tokens on; one panel open at a time
- **Activity tabs** — 7-day heatmap, 5-month calendar (GitHub-style), hourly distribution, 4-week comparison, and **Rhythm** (time-of-day coding patterns with per-period gradient bars)
- **Model breakdown** — per-model token and cost totals across all time, with gradient bars
- **Cost display** — USD or KRW, subscription equivalent value vs. actual API cost
- **Alerts** — Windows toast notifications at configurable usage thresholds (50% / 80% / 90%)
- **Project management** — hide projects from the UI, or fully exclude them from tracking
- **Extra Usage budget** — monthly extra usage card showing credits used / limit and utilization % (shown when extra usage is enabled on your account)
- **Always-on-top widget** — stays visible over other windows; minimize with the `−` button in the header or via the tray icon; global hotkey to toggle
- **Tray label** — show usage %, token count, or cost directly in the taskbar
- **Dark theme by default** — modern dark UI with JetBrains Mono for numeric displays

---

## Claude Code Integration (Bridge)

WhereMyTokens can receive live rate limit data from Claude Code via the official `statusLine` plugin mechanism — no API polling required.

**How it works:**
1. Open **Settings → Claude Code Integration → Setup**
2. This registers WhereMyTokens as a `statusLine` command in `~/.claude/settings.json`
3. Each time Claude Code runs, it pipes session data (rate limits, context %, model, cost) to WhereMyTokens via stdin
4. The app updates immediately — no polling delay

The bridge provides supplementary context data (context window %, model, cost). Rate limit percentages always use the Anthropic API as the authoritative source; bridge values serve as a fallback when the API is unavailable.

---

## Requirements

- Windows 10 / 11
- [Node.js](https://nodejs.org) 18+ (dev / source builds only)
- [Claude Code](https://claude.ai/code) installed and logged in

---

## Install

### Option A — Pre-built executable

1. Download `WhereMyTokens-v1.7.2-win-x64.zip` from [Releases](https://github.com/jeongwookie/WhereMyTokens/releases)
2. Extract the zip
3. Run `WhereMyTokens.exe`

WhereMyTokens opens automatically on first launch and minimizes to your system tray.

### Option B — From source

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

> **Note:** Building the NSIS installer on Windows requires Developer Mode enabled  
> (Settings -> For Developers -> Developer Mode).  
> The portable `.exe` in `release/win-unpacked/` works without it.

---

## Usage

1. Click the tray icon to open the dashboard
2. Click **Settings** to configure:
   - **Claude Code Integration** — connect for live rate limit data
   - Currency (USD / KRW)
   - Global shortcut
   - Alert thresholds
   - Launch at login
   - Tray label style

### Session list

Each row shows:
- Project name, model tag, worktree branch (if applicable)
- Session state badge and last activity time
- **Context bar** — always visible per session; turns amber at 50%, orange at 80%, red at 95%+
- **Tool bar** — proportional color bar + top-3 tool names with call counts
- **Breakdown button** — expands a per-category token breakdown panel (Read / Edit/Write / Search / Git / Build/Test / Terminal / Subagents / Thinking / Response) — one panel open at a time

Use **All / Active** to filter sessions. Hover a project header to:
- `x` — hide from the UI (still tracked)
- `⊘` — exclude from tracking entirely (no JSONL parsing, no session display)

Hidden projects can be restored via the toggle at the bottom of the session list. Excluded projects must be re-enabled from the same area.

---

## How rate limits work

Two data sources, used in priority order:

| Priority | Source | Description |
|----------|--------|-------------|
| 1st | **Anthropic API** | `/api/oauth/usage` — authoritative % and reset times, same source as the web dashboard. Fetched every 3 min; exponential backoff on 429. |
| 2nd | **Bridge (stdin)** | Live data from Claude Code via `statusLine`. Used as fallback when API data is unavailable. |
| Fallback | **Last known value** | On API failure, the last successful value is kept. Cached values are validated on startup — stale data past its reset window is automatically cleared. |

The dot in the header shows API connectivity (green = connected, red = unreachable). Hover the dot to see the last error message. A `(cached)` label appears on rate limit bars when the API is temporarily unavailable but a previous value exists. Rate limit bars show `—` when the API has not yet returned a successful value (e.g., on first launch or after a 429).

---

## How numbers work

All token counts (`tok`) include **input + output + cache creation + cache reads** — every token type Anthropic charges for. Cost (`$`) is always the API-equivalent estimate for the same token mix.

| Display | Scope | tok | $ |
|---------|-------|-----|---|
| Header | Today since midnight | All token types | API-equivalent |
| Plan Usage (5h / 1w) | Current billing window | All token types | API-equivalent |
| Model Usage | **All time**, per model | All token types | API-equivalent |

> **Note:** `$` values are estimates — not your actual bill. Claude Max/Pro subscriptions are flat monthly fees.

---

## Activity tabs

| Tab | Description |
|-----|-------------|
| 7d | 7-day heatmap (day-of-week × hour grid) with time axis and color legend |
| 5mo | 5-month calendar grid (GitHub-style weeks × weekdays, hover for date + tokens) |
| Hourly | Hourly token distribution across the last 30 days |
| Weekly | Last 4 weeks horizontal bar chart |
| Rhythm | Time-of-day coding patterns — Morning ☀️ / Afternoon 🔥 / Evening 🌆 / Night 🌙 with gradient bars (7-day, local timezone) |

---

## Activity Breakdown

Click the **Breakdown** button on any session row to expand a per-category breakdown of output tokens for that session. Only one panel can be open at a time — clicking another session auto-closes the previous.

| Category | Color | Source |
|----------|-------|--------|
| 💭 Thinking | Purple | Extended thinking blocks in the response |
| 💬 Response | Gray | Text blocks — the final answer text |
| 📄 Read | Blue | `Read` tool calls |
| ✏️ Edit / Write | Green | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` |
| 🔍 Search | Cyan | `Grep`, `Glob`, `LS`, `TodoRead`, `TodoWrite` |
| 🌿 Git | Lavender | `Bash` — commands starting with `git` |
| ⚙️ Build / Test | Orange | `Bash` — `npm`, `tsc`, `jest`, `cargo`, `python`, `go build`, etc. |
| 💻 Terminal | Amber | Other `Bash` commands; `mcp__*` tools |
| 🤖 Subagents | Pink | `Agent` tool |
| 🌐 Web | Sky | `WebFetch`, `WebSearch` |

> **Token attribution:** each assistant turn's output token count is distributed across its content blocks proportionally by character length — `block_chars ÷ total_chars × output_tokens`. Categories with zero tokens are hidden.

---

## Data & Privacy

WhereMyTokens reads only local files:

| File | Purpose |
|------|---------|
| `~/.claude/sessions/*.json` | Session metadata (pid, cwd, model) |
| `~/.claude/projects/**/*.jsonl` | Conversation logs (token counts, costs) |
| `~/.claude/.credentials.json` | OAuth token — used only to fetch your own usage from Anthropic |
| `%APPDATA%\WhereMyTokens\live-session.json` | Bridge data written by the `statusLine` plugin |

No data is sent anywhere except the Anthropic API call to fetch your own usage stats.

---

## Development

```bash
npm run build      # generate icons + compile (main + renderer)
npm start          # build and launch
npm run dev        # watch mode
npm run dist       # build + package installer
```

### Project structure

```
assets/
  source-icon.png       Source icon (replace to change app icon)
  icon.ico              Generated multi-size ICO (gitignored, built automatically)
scripts/
  make-icons.mjs        Icon pipeline: white bg removal + ICO generation
  build-renderer.mjs    esbuild renderer bundle
src/
  main/
    index.ts              Electron main, tray, popup window
    stateManager.ts       Polling, state assembly, bridge integration
    gitStatsCollector.ts  Git branch, commit, and line stats (with TTL cache)
    sessionDiscovery.ts   Reads ~/.claude/sessions/*.json
    jsonlParser.ts        Parses conversation JSONL files
    usageWindows.ts       5h/1w window aggregation + heatmaps
    rateLimitFetcher.ts   Anthropic API usage fetch (with backoff)
    bridgeWatcher.ts      Watches live-session.json from statusLine bridge
    ipc.ts                IPC handlers, integration setup
    preload.ts            contextBridge (window.wmt)
    usageAlertManager.ts  Threshold alerts
  bridge/
    bridge.ts             statusLine plugin: stdin -> live-session.json
  renderer/
    views/
      MainView.tsx         Main dashboard
      SettingsView.tsx     Settings
      NotificationsView.tsx
      HelpView.tsx
    components/
      SessionRow.tsx       Session row with idle collapse (context bar + tool chips)
      TokenStatsCard.tsx   Usage stats + rate limit bar + cache efficiency grade
      ActivityChart.tsx    Heatmaps, charts, and Rhythm tab
      CodeOutputCard.tsx   Git-based productivity metrics (commits, lines, Claude ROI $/1K lines)
      ModelBreakdown.tsx   Per-model totals with gradient bars
      ExtraUsageCard.tsx   Extra Usage monthly budget card
```

---

## Disclaimer

Costs shown are **API-equivalent estimates**, not actual billing. Claude Max/Pro subscriptions are flat monthly fees. The cost display shows how much usage value you are getting out of your subscription — not what Anthropic charges you.

---

## Acknowledgements

Inspired by [duckbar](https://github.com/rofeels/duckbar) — the macOS counterpart.

---

## License

MIT
