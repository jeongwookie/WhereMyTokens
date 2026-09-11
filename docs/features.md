# Feature Details

WhereMyTokens is a local-first Windows tray app for AI coding usage observability.

## Session Tracking

- Provider checkboxes for Claude Code, Codex, Antigravity, or any enabled combination.
- Live session detection from local provider files and running Antigravity local RPC.
- Session grouping by project and git branch.
- Context window warnings, tool usage summaries, and active/recent session focus.

## Quotas And Alerts

- Provider quota cards for Claude, Codex, Antigravity, and future provider adapters. Antigravity 2.x prefers provider-reported shared quota groups and retains per-model local RPC fallback for older servers.
- Per-target quota display modes: Rich, Simple, or hidden.
- Quota Pace compares provider usage percentage with elapsed reset-window time whenever reset and duration are both known. A known reset alone still shows its countdown; local token/cost attribution is independent.
- Optional draggable Windows taskbar mini quota display with two physical lines for provider-reported `5h` and `1w` Quota Entries. Two represented periods use one line each; a single period uses both lines with balanced entry distribution. The display also supports a configurable per-line block limit, compact measured hidden-target counts, content-fitted window bounds, source/status-colored target prefixes, transparent background, and taskbar-background-aware text contrast.
- Windows toast notifications for configurable usage thresholds.
- Claude Code `statusLine` bridge support for official 5h/7d quota data and locally reported model-scoped limits such as Fable, plus a throttled read-only access-token fallback when Claude Desktop is used without fresh Claude Code statusLine data.

## Analytics

- Today and all-time header totals for tokens, API-equivalent estimated cost, calls, sessions, cache efficiency, and savings.
- Explicit GPT-6 Astra Standard API pricing, including cached input and the documented long-context rates. Dated price revisions automatically update matching historical costs from complete retained detail, with a backup and completion receipt; incomplete history is preserved.
- Persistent source-attributed local usage index for long-range totals, incremental startup, and project-aware filtering. [Usage accounting](usage-accounting.md) documents cumulative deduplication, missing-metadata estimates, and history-preserving upgrades.
- Usage precision retention: request detail for 8 days, hourly buckets for 35 days, daily buckets for 180 days, and exact monthly authority indefinitely.
- Non-blocking first indexing with explicit scan progress and operational failures; approximation uncertainty does not require manual review. Normal refresh preserves existing history. The separate destructive `Reset index` action rebuilds only from currently available sources.
- Lossless cost repricing with a validated SQLite backup and transactionally enforced non-cost-state hash; unavailable ambiguous raw-model history is preserved rather than guessed or reset.
- Trend buckets with drill-downs for provider input/output, thinking, response, tools, cache-aware work tokens, billing tokens, and git net-line categories.
- Activity tabs for 7-day heatmap, 5-month calendar, hourly distribution, weekly comparison, and rhythm breakdown.
- Model usage cards and activity breakdowns for Claude output categories and Codex tool-event categories.

## Code Output

- Commit and net-line metrics from persistently tracked local git repositories, independent of recent session membership. Temporarily unavailable repositories retain their historical output, and project exclusions are reversible.
- Git output includes human activity under the existing local-author filter; selecting a model or provider does not attribute commits to that AI source.
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

## Historical statistics correction

On upgrade, a background check corrects proven Codex counter-origin overcounts after making a local backup. The result reports corrected and unverified sources separately. Details and a recheck action remain available under Settings → Data after the main-view notice is dismissed. Unavailable or incomplete history keeps its previous estimate; this is separate from Reset index.
