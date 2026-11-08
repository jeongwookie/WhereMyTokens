# Development

## Requirements

- Windows 10 or 11.
- Node.js 22.12 or newer (Electron 45 tooling requirement).
- .NET 10 SDK for the Windows taskbar helper.
- Claude Code, Codex, or Antigravity installed if you want live local data during manual testing.

## Build And Run

```bash
git clone https://github.com/jeongwookie/WhereMyTokens.git
cd WhereMyTokens
npm install
npx --no-install install-electron
npm run build
npm start
```

## Test

```bash
npm test
```

Credential fixtures must only use temporary directories created by the test itself. Never reuse an inherited `CODEX_HOME` for mutable fixtures. For untrusted contributions, inspect source and lifecycle scripts before installation, use `npm ci --ignore-scripts`, and run tests with disposable profile directories and synthetic credentials. Environment overrides are not a security sandbox; use an isolated Windows VM for untrusted runtime execution.

Windows taskbar layout and mouse-event regression checks (without showing or attaching a window):

```bash
dotnet run --project scripts/test-support/taskbar-layout/TaskbarLayoutTests.csproj
```

### Dependency Security

The integration branch uses Electron 45.2.3 and patched transitive packages, including fast-uri 3.1.9, shell-quote 1.12.0, follow-redirects 1.16.2, and undici 6.29.1/7.30.2. Electron is a development dependency in npm but is the shipped runtime and must always be audited.

As of 2026-11-06, `npm audit` reports no high or critical findings, and `npm audit --omit=dev` reports no findings. Ten moderate package-level findings remain in two development-only chains: Jimp/file-type (malformed ASF parsing) and electron-builder/minimatch (glob amplification). The icon script reads the repository's PNG, not user-supplied ASF files; packaging uses maintainer-controlled glob patterns. These findings are not a claim of zero risk. Do not process untrusted media or packaging configuration with these tools. Jimp 1.6.1 was evaluated but not adopted because its Zod dependency introduces a high-severity advisory. Recheck all advisories before each release.

References: [file-type](https://github.com/advisories/GHSA-5v7r-6r5c-r473), [minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249), [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

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

### Git statistics

Git statistics share a FIFO limit of two active Git commands across repositories and refresh callers, including buffered commands and streamed history. A command holds its slot until it finishes; queue time does not consume its execution timeout.

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

When both periods are represented, taskbar blocks use a shared target order before applying the column limit. A null block reserves that target's column when the line has no matching period. Hidden counts include only omitted quota entries, not empty cells. A single represented period still balances contiguous blocks across both lines. Antigravity summary targets use word initials such as `GM` and `G4A`; the native helper measures the actual displayed prefix using the current font.

The helper stores `RightInsetDip` and `BottomInsetDip` in 96-DPI logical units. Display and DPI notifications reapply the latest snapshot with current taskbar metrics and pixel-sized fonts. The previous absolute-pixel position format is rejected and starts at the default position. Native regression checks cover resolution changes, clipping and restoration, and repeated DPI transitions while the drawing surface remains at 96 DPI.

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
