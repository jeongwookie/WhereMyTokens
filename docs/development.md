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
| Electron main | Discovers provider sessions, parses usage sources, fetches provider usage, manages tray/window state, and persists settings. |
| Preload bridge | Exposes the typed `window.wmt` IPC surface with `contextIsolation` boundaries. |
| React renderer | Shows the tray dashboard, settings, notifications, activity charts, and compact quota widget. |
| `statusLine` bridge | Receives Claude Code JSON on stdin and writes a local bridge snapshot for the main process. |

## Project Structure

```text
src/
  main/
    index.ts
    stateManager.ts
    providers/
    usageWindows.ts
    rateLimitFetcher.ts
    codexUsageFetcher.ts
    bridgeWatcher.ts
    gitStatsCollector.ts
    ipc.ts
    preload.ts
  bridge/
    bridge.ts
  renderer/
    App.tsx
    views/
    components/
```
