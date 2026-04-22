<img src="assets/source-icon.png" width="80" align="right" />

# WhereMyTokens

**Windows system tray app for monitoring Claude Code and Codex token usage in real time.**

Built by a Korean developer who uses Claude Code daily — scratching my own itch.

Sits quietly in your taskbar and shows Claude Code and Codex usage — tokens, costs, session activity, cache, model usage, and rate limits — at a glance.

![Platform](https://img.shields.io/badge/platform-Windows_10%2F11-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Release](https://img.shields.io/github/v/release/jeongwookie/WhereMyTokens)

> [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh-CN.md) | [Español](README.es.md)

> ⭐ **Claude + Codex tracking** — choose Claude only, Codex only, or both together from Settings.

> 💾 **No cloud sync** — reads only local Claude/Codex files. Your data never leaves your machine.

<table>
  <tr>
    <th width="50%">Light Mode</th>
    <th width="50%">Dark Mode</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-light.png" alt="Light mode dashboard" /></td>
    <td><img src="assets/screenshot-dark.png" alt="Dark mode dashboard" /></td>
  </tr>
</table>

<table>
  <tr>
    <th width="33%">Rhythm & Peak Stats</th>
    <th width="33%">7-Day Heatmap</th>
    <th width="33%">Settings</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-rhythm.png" alt="Rhythm tab" /></td>
    <td><img src="assets/screenshot-heatmap.png" alt="7-day heatmap" /></td>
    <td><img src="assets/screenshot-settings.png" alt="Settings" /></td>
  </tr>
</table>

## What's New

| Version | Date | Highlights |
|---------|------|-----------|
| **[v1.10.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.10.0)** | Apr 22 | Claude + Codex tracking, Codex usage accounting, scoped stats, session UX/performance improvements |
| **[v1.9.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.9.2)** | Apr 20 | NSIS installer, improved session tracking accuracy and stability |
| **[v1.9.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.9.1)** | Apr 17 | Fix 7d heatmap hover tooltip; add zh-CN & es READMEs |
| **[v1.9.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.9.0)** | Apr 17 | Teal theme, system dark mode, incremental JSONL caching, idle 6h+ auto-hide |

[→ Full changelog](https://github.com/jeongwookie/WhereMyTokens/releases)

---

## Download

**[⬇ Download Installer (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.10.0/WhereMyTokens-Setup.exe)** — just run and done

**[⬇ Download Latest Release](https://github.com/jeongwookie/WhereMyTokens/releases/latest)** — all files

By downloading or installing, you agree to the [End-User License Agreement (EULA)](EULA.txt).

**Option A — Installer** _(recommended)_
1. Download `WhereMyTokens-Setup.exe` (link above)
2. Run the installer and follow the wizard
3. The app opens automatically and sits in your system tray

**Option B — Portable ZIP** _(no install required)_
1. Download `WhereMyTokens-v1.10.0-win-x64.zip` from the release page
2. Extract the zip anywhere
3. Run `WhereMyTokens.exe`

---

## Features

### Session Tracking
- **Claude + Codex provider modes** — track Claude only, Codex only, or both together in one dashboard
- **Live session detection** — Terminal, VS Code, Cursor, Windsurf, and more with real-time status: `active` / `waiting` / `idle` / `compacting`
- **Compact grouping** — sessions grouped by git project → branch, with repeated Claude/Codex sessions stacked by provider, source, model, and state
- **Branch row limit** — each branch shows the first 3 rows by default, with "Show N more" for the rest
- **Context window warnings** — per-session bar; amber at 70%, orange at 85%, red at 95%+
- **Tool usage bars** — proportional color bar + tool chips (Bash, Edit, Read, …)

### Rate Limits & Alerts
- **Rate limit bars** — Claude 5h/1w limits from Anthropic API/statusLine; Codex 5h/1w limits from local Codex rate-limit log events when available
- **Claude Code bridge** — register as a `statusLine` plugin for live rate limit data without API polling
- **Windows toast notifications** — at configurable usage thresholds (50% / 80% / 90%)
- **Claude Extra Usage budget** — Claude monthly credits used / limit / utilization %

### Analytics & Activity
- **Header stats** — today/all-time toggle: cost, API calls, sessions, cache efficiency, savings, token breakdown (In/Out/Cache)
- **Activity tabs** — 7-day heatmap, 5-month calendar (GitHub-style), hourly distribution, 4-week comparison
- **Rhythm tab** — time-of-day cost distribution (Morning/Afternoon/Evening/Night) with gradient bars, peak detail stats, local timezone
- **Model breakdown** — per-model token and cost totals with gradient bars
- **Activity Breakdown** — Claude output-token categories and Codex tool-event categories (Thinking, Edit/Write, Read, Search, Git, etc.)

### Code Output & Productivity
- **Git-based metrics** — commits, net lines changed, **$/100 Added** (cost per 100 added lines)
- **Today vs all-time** — today shows actual cost per added line with average for comparison
- **Auto-discovery** — Claude projects from `~/.claude/projects/` and Codex sessions from `~/.codex/sessions/`
- **Your commits only** — filtered by `git config user.email`

### Customization
- **Auto/Light/Dark theme** — follows system preference by default
- **Cost display** — USD or KRW with configurable exchange rate
- **Always-on-top widget** — stays visible; minimize via header button, tray icon, or global hotkey
- **Tray label** — show usage %, token count, or cost directly in the taskbar
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

## Codex tracking

WhereMyTokens can also read Codex's local JSONL logs from `~/.codex/sessions/**/*.jsonl`. In Settings, choose **Claude**, **Codex**, or **Both**.

**What Codex tracking includes:**
- Session status, project/branch grouping, source labels such as VS Code or Codex Exec
- Model usage and API-equivalent cost estimates for GPT/Codex models
- Input, cached input, output tokens, cache savings, and all-time model totals
- 5h/1w Codex limit percentages and reset times when `rate_limits` events are present in the local log
- Activity Breakdown based on tool events, because Codex logs expose tool calls rather than per-tool output-token attribution

**Codex cache math:** Codex logs report `input_tokens` and `cached_input_tokens`. WhereMyTokens stores uncached input as `input_tokens - cached_input_tokens`, stores cached input as cache-read tokens, and shows cache efficiency as:

```text
cached_input_tokens / input_tokens
```

This differs from Claude, where cache efficiency is:

```text
cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens)
```

---

## How rate limits work

Claude and Codex use separate limit sources and separate 5h/1w reset windows:

| Priority | Source | Description |
|----------|--------|-------------|
| Claude 1st | **Anthropic API** | `/api/oauth/usage` — authoritative % and reset times. Fetched every 3 min; exponential backoff on 429. |
| Claude 2nd | **Bridge (stdin)** | Live data from Claude Code via `statusLine`. Used as fallback when API is unavailable. |
| Codex | **Local Codex logs** | `rate_limits` events inside `~/.codex/sessions/**/*.jsonl`, using the newest observed event. |
| Fallback | **Last known value** | On data failure, the last successful value is kept. Stale data past its reset window is auto-cleared. |

The dot in the header shows API connectivity (green = connected, red = unreachable). Hover to see the last error message.

---

## How numbers work

All token counts include **input + output + cache creation + cache reads** where available. Cost is always an API-equivalent estimate using the app's local pricing table.

Claude reports input, output, cache creation, and cache reads. Codex reports raw input, cached input, and output; WhereMyTokens splits raw input into uncached input and cached input so cache savings and model totals are not double-counted.

| Display | Scope | What's counted |
|---------|-------|----------------|
| Header (today) | Since midnight | In/Out/Cache + calls, sessions, cache savings |
| Header (all) | All time | In/Out/Cache + calls, sessions, cache savings |
| Plan Usage (Claude 5h / 1w) | Claude reset window | Claude token types + API/statusLine limits |
| Plan Usage (Codex 5h / 1w) | Codex reset window | Codex token types + local rate-limit events |
| Model Usage | All time, per model and provider | All token types |

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

## Data & Privacy

WhereMyTokens reads only local files — no cloud sync, no telemetry.

| File | Purpose |
|------|---------|
| `~/.claude/sessions/*.json` | Session metadata (pid, cwd, model) |
| `~/.claude/projects/**/*.jsonl` | Conversation logs (token counts, costs) |
| `~/.claude/.credentials.json` | OAuth token — used only to fetch your own usage from Anthropic |
| `~/.codex/sessions/**/*.jsonl` | Codex session logs (token counts, cached input, models, rate-limit events, tool calls) |
| `%APPDATA%\WhereMyTokens\live-session.json` | Bridge data written by the `statusLine` plugin |

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

---

## Demo

<div align="center">

https://github.com/user-attachments/assets/98b6f8d7-6fc6-4c12-aef1-af6300db0728

</div>

---

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
