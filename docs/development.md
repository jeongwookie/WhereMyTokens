# Development

## Requirements

- Windows 10 or 11.
- Node.js 18 or newer.
- Claude Code, Codex, or Antigravity installed if you want live local data during manual testing.

## Build And Run

```bash
git clone https://github.com/jeongwookie/WhereMyTokens.git
cd WhereMyTokens
npm install
npm run build
npm start
```

## Test

```bash
npm test
```

## Build Installer

```bash
npm run dist
```

Expected release artifacts:

| Artifact | Purpose |
|----------|---------|
| `release/WhereMyTokens-Setup.exe` | NSIS installer uploaded to GitHub Releases. |
| `release/WhereMyTokens-vX.Y.Z-win-x64.zip` | Portable Windows ZIP uploaded to GitHub Releases. |
| `release/win-unpacked/WhereMyTokens.exe` | Unpacked app for local smoke testing. |

Building the NSIS installer on Windows requires Developer Mode enabled in **Settings -> For Developers -> Developer Mode**.

## Architecture

WhereMyTokens is an Electron tray app. The renderer never reads local files or credentials directly; filesystem, provider API, tray, and settings work stays in the Electron main process and is exposed through the preload bridge.

| Layer | Responsibility |
|-------|----------------|
| Electron main | Discovers provider sessions, parses/fetches each usage source once, queries the canonical UsageIndex, manages tray/window state, and persists settings. |
| Preload bridge | Exposes the typed `window.wmt` IPC surface with `contextIsolation` boundaries. |
| React renderer | Shows the tray dashboard, settings, notifications, activity charts, and compact quota widget. |
| `statusLine` bridge | Receives Claude Code JSON on stdin and writes a local bridge snapshot for the main process. |
| Claude compatibility fetcher | Uses a fresh statusLine first; otherwise reads the existing Claude Code access token in the main process and sends a throttled, fixed-host quota request without refresh or credential writes. |

### Usage history

The [usage accounting contract](usage-accounting.md) defines the current schema 6 quantities, identities, migrations, and scan states. Provider discovery and scanners feed the same UsageIndex; the in-memory and SQLite adapters implement its storage contract. Session projections accelerate display and do not form another historical authority.

- Source checkpoints and contribution changes commit together. An unchanged source does not invoke its scanner; evicting hot detail does not remove the durable checkpoint or historical totals.
- Canonical buckets retain source, provider, and model attribution. Project exclusion filters sources before aggregation and remains reversible.
- Request detail lasts 8 days, hourly precision 35 days, daily precision 180 days, and monthly totals indefinitely. Compaction reduces time detail without changing retained totals or silently deleting history to meet a storage cap.
- Parser upgrades and source rewrites preserve committed history and reconstruct parser context at a protected boundary. They do not certify or replace historical totals. Initial indexing and upgrade backlogs remain visible; ordinary incremental updates become quiet after history indexing completes.
- A damaged database is preserved while recovery is attempted. The explicit destructive **Reset index** action is separate from refresh and reconstructs only currently available sources.
- Dated price revisions run once before collection starts, in a worker using retained request facts. Matching costs and receipts commit atomically after backup and non-cost validation; incomplete sources retain their old estimates. No raw logs are read. The separate lossless repricing CLI can replay to stored checkpoints for explicit maintenance, but neither operation resets usage history or advances checkpoints.

### Historical accounting maintenance

The automatic counter-origin revision runs in a worker serialized with normal scans. Its core is `usageIndex/accountingRevisions.ts`; synthetic raw-evidence, backup, rollback, protected-alias, concurrency, and restart tests live in `scripts/usage-accounting-revision.test.mjs`. The preview/apply CLI calls the same core, not a separate repair implementation. See the [accounting contract](usage-accounting.md#automatic-historical-accounting-revision) for the exact proof and preservation rules.

### Provider quotas

`ProviderQuotaSnapshot.entries` is the shared quota contract. An entry key identifies one limit and its alert/reset state; `target.id` identifies the related settings and display target. Only reported limits produce entries. Provider snapshots are selected as a whole rather than assembled from windows from different observations.

Known reset time supports a countdown; elapsed-window percentage additionally requires a known or explicitly inferred duration. Optional `usageBinding` controls local token/cost attribution independently. The canonical normalized periods are `5h`, `7d`, or null; other or unknown periods remain dashboard-visible without being forced into fixed-period tray/taskbar projections. The taskbar's two physical lines distribute the represented periods; `1w` is a display label for `7d`, not another protocol value.

Current provider acquisition and credential boundaries are described in [privacy and security](privacy-security.md). Historical OAuth or fixed-window implementation plans do not override that contract.

## Project Structure

```text
src/
  main/
    index.ts
    stateManager.ts
    providers/
    usageIndex/
    usageWindows.ts
    codexUsageFetcher.ts
    bridgeWatcher.ts
    gitStatsCollector.ts
    ipc.ts
    preload.ts
  bridge/
    bridge.ts
    claudeStatusLineFile.ts
  renderer/
    App.tsx
    views/
    components/
```
