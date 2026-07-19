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
- Quota Pace compares provider usage percentage with elapsed reset-window time whenever reset and duration are both known. A known reset alone still shows its countdown; local token/cost attribution is independent.
- Optional draggable Windows taskbar mini quota display with two physical lines for provider-reported `5h` and `1w` Quota Entries. Two represented periods use one line each; a single period uses both lines with balanced entry distribution. The display also supports a configurable per-line block limit, compact measured hidden-target counts, content-fitted window bounds, source/status-colored target prefixes, transparent background, and taskbar-background-aware text contrast.
- Windows toast notifications for configurable usage thresholds.
- Claude Code `statusLine` bridge support for live local context and fallback quota data.

## Analytics

- Today and all-time header totals for tokens, cost, calls, sessions, cache efficiency, and savings.
- Persistent source-attributed local usage index for long-range totals, incremental startup, and project-aware filtering.
- Usage precision retention: request detail for 8 days, hourly buckets for 35 days, daily buckets for 180 days, and exact monthly authority indefinitely.
- Non-blocking first indexing with explicit incomplete coverage, plus a destructive `Reset index` action that rebuilds only from currently available sources.
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
- Deterministic tray label modes for 5h usage percentage, 7d usage percentage, 5h token count, or 5h cost. Period percentage modes take the maximum matching-period utilization across enabled providers.
- Floating Quota Pace widget with always-on-top support.
- Windows-only draggable self-contained taskbar mini display with two compact physical quota lines, single-period balanced wrapping, a configurable block limit, dynamic visible-column sizing, measured hidden-target suffixes, content-fitted hit bounds, source/status-colored target prefixes, and transparent, sampled-background-aware rendering.
- Dashboard layout controls for hiding or reordering optional cards.
- Project hide and exclude controls backed by the same canonical usage query path.
- Optional start with Windows.
