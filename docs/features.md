# Feature Details

WhereMyTokens is a local-first Windows tray app for AI coding usage observability.

## Session Tracking

- Provider checkboxes for Claude Code, Codex, Antigravity, or any enabled combination.
- Live session detection from local provider files and running Antigravity local RPC.
- Session grouping by project and git branch.
- Context window warnings, tool usage summaries, and active/recent session focus.

## Quotas And Alerts

- Provider quota cards for Claude, Codex, Antigravity, and future provider adapters.
- Per-target quota display modes: Rich, Simple, or hidden.
- Quota Pace compares usage percentage with elapsed reset-window time.
- Optional draggable Windows taskbar mini quota display with fixed `5h` and `1w` rows, overflow counts, transparent background, and taskbar-background-aware text contrast.
- Windows toast notifications for configurable usage thresholds.
- Claude Code `statusLine` bridge support for live local context and fallback quota data.

## Analytics

- Today and all-time header totals for tokens, cost, calls, sessions, cache efficiency, and savings.
- Persistent local usage ledger for long-range totals and faster startup.
- Trend buckets with drill-downs for provider input/output, thinking, response, tools, cache-aware work tokens, billing tokens, and git net-line categories.
- Activity tabs for 7-day heatmap, 5-month calendar, hourly distribution, weekly comparison, and rhythm breakdown.
- Model usage cards and activity breakdowns for Claude output categories and Codex tool-event categories.

## Code Output

- Commit and net-line metrics from local git repositories tied to tracked sessions.
- Cost per 100 added lines for today and all-time views.
- Output growth chart across recent local days.
- Local git author email filtering so only your commits are counted.

## Customization

- Auto, light, and dark themes.
- USD or KRW display with configurable exchange rate.
- Tray label modes for usage percentage, token count, or cost.
- Floating Quota Pace widget with always-on-top support.
- Windows-only draggable self-contained taskbar mini display for compact `5H` / `1W` quota rows with overflow counts and transparent, sampled-background-aware rendering.
- Dashboard layout controls for hiding or reordering optional cards.
- Project hide and exclude controls.
- Optional start with Windows.
