<img src="assets/source-icon.png" width="80" align="right" />

# WhereMyTokens

**Windows system tray app for monitoring Claude Code token usage in real time.**

Sits quietly in your taskbar and shows Claude Code usage — tokens, costs, session activity, and rate limits — at a glance.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[한국어](README.ko.md) · [日本語](README.ja.md)

---

## Features

- **Live session tracking** — detects running Claude Code sessions (Terminal, VS Code, Cursor, Windsurf, etc.) with real-time status: `active` / `waiting` / `idle` / `compacting`
- **Rate limit bars** — 5h and 1w usage from Anthropic's API, with progress bars and time-to-reset counters
- **Claude Code bridge** — register WhereMyTokens as a Claude Code `statusLine` plugin for live rate limit data without API polling
- **Context window warnings** — per-session compact warnings at 50% / 80% / 95%+ inline in the session list
- **Tool usage bars** — proportional color bar + top-3 tool names (Bash, Edit, Read, …) per session
- **Activity heatmaps** — 7-day heatmap (day × hour) and 5-month calendar grid (GitHub-style); hourly distribution; 4-week comparison chart
- **Model breakdown** — per-model token and cost totals across all time
- **Cost display** — USD or KRW, subscription equivalent value vs. actual API cost
- **Alerts** — Windows toast notifications at configurable usage thresholds (50% / 80% / 90%)
- **Project management** — hide projects from the UI, or fully exclude them from tracking
- **Extra Usage budget** — monthly extra usage card showing credits used / limit and utilization % (shown when extra usage is enabled on your account)
- **Always-on-top widget** — stays visible over other windows; minimize with the `−` button in the header or via the tray icon; global hotkey to toggle
- **Tray label** — show usage %, token count, or cost directly in the taskbar

---

## Screenshots

<table align="center">
  <tr>
    <td align="center" width="230">
      <img src="assets/screenshot-main.png" width="190" alt="Sessions, plan usage bars, 7-day heatmap, and model breakdown" /><br/>
      <sub><b>Sessions · Plan Usage · 7-day Heatmap</b></sub>
    </td>
    <td align="center" width="230">
      <img src="assets/screenshot-hourly.png" width="190" alt="Hourly token usage bar chart for the last 30 days" /><br/>
      <sub><b>Hourly Token Usage (last 30 days)</b></sub>
    </td>
    <td align="center" width="230">
      <img src="assets/screenshot-help.png" width="190" alt="Help view — Numbers, Activity, and Data Sources explained" /><br/>
      <sub><b>Help — Numbers, Activity &amp; Data Sources</b></sub>
    </td>
  </tr>
</table>

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

1. Download `WhereMyTokens-v1.3.4-win-x64.zip` from [Releases](https://github.com/jeongwookie/WhereMyTokens/releases)
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
| 7d | 7-day heatmap (day-of-week × hour grid) |
| 5mo | 5-month calendar grid (GitHub-style weeks × weekdays, hover for date + tokens) |
| Hourly | Hourly token distribution across the last 30 days |
| Weekly | Last 4 weeks horizontal bar chart |

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
      SessionRow.tsx       Session row (context bar + tool bar)
      TokenStatsCard.tsx   Usage stats + rate limit bar
      ActivityChart.tsx    Heatmaps + charts
      ModelBreakdown.tsx   Per-model totals
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
