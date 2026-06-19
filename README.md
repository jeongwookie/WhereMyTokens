<p align="center">
  <img src="assets/readme-icon.png" width="88" alt="WhereMyTokens icon" />
</p>

<h1 align="center">WhereMyTokens</h1>

<p align="center">
  <strong>Claude Code, Codex, and Antigravity token usage, live in your Windows tray.</strong>
</p>

<p align="center">
  <img alt="Codex tracking supported" src="https://img.shields.io/badge/Codex_tracking-supported-4f46e5?style=for-the-badge">
  <img alt="Antigravity supported" src="https://img.shields.io/badge/Antigravity-supported-0f766e?style=for-the-badge">
  <img alt="Claude Code supported" src="https://img.shields.io/badge/Claude_Code-supported-d97706?style=for-the-badge">
  <img alt="Local only" src="https://img.shields.io/badge/Local_only-no_cloud_sync-0f766e?style=for-the-badge">
</p>

<p align="center">
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%2F11-0078d4?style=for-the-badge">
  <a href="https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.19.0"><img alt="Release v1.19.0" src="https://img.shields.io/badge/release-v1.19.0-2563eb?style=for-the-badge"></a>
  <img alt="MIT license" src="https://img.shields.io/badge/license-MIT-16a34a?style=for-the-badge">
</p>

<p align="center">
  <a href="README.ko.md">한국어</a> · <a href="README.ja.md">日本語</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="#download"><strong>Download</strong></a>
  ·
  <a href="#first-run">First Run</a>
  ·
  <a href="#screenshots">Screenshots</a>
  ·
  <a href="https://github.com/jeongwookie/WhereMyTokens-mac">macOS Edition</a>
</p>

WhereMyTokens is a local-first desktop app for monitoring AI coding usage: quota windows, token totals, cost estimates, cache efficiency, sessions, model usage, activity patterns, and git output.

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

> Built by a Korean developer who uses Claude Code daily, scratching my own itch.

## Download

| Platform | Download | Best For |
|----------|----------|----------|
| Windows 10/11 | **[Installer (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.19.0/WhereMyTokens-Setup.exe)** | Normal installation, auto-start from the tray |
| Windows 10/11 | **[Portable ZIP](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.19.0/WhereMyTokens-v1.19.0-win-x64.zip)** | No installer, keep it anywhere |
| macOS Apple Silicon | **[macOS Edition](https://github.com/jeongwookie/WhereMyTokens-mac/releases/tag/mac-v1.0.0)** | Menu bar app with DMG/ZIP packaging |

Looking for the menu bar version? See the separate [WhereMyTokens for macOS repository](https://github.com/jeongwookie/WhereMyTokens-mac), which has its own `mac-vX.Y.Z` release track and DMG/ZIP downloads.

By downloading or installing, you agree to the [End-User License Agreement](EULA.txt).

## First Run

1. Install with `WhereMyTokens-Setup.exe`, or extract the portable ZIP and run `WhereMyTokens.exe`.
2. Open the dashboard from the Windows tray.
3. Enable the providers you use: Claude Code, Codex, Antigravity, or any combination.
4. Optional for VS Code Remote WSL: enable **WSL tracking** in Settings -> Providers. It scans detected distro logs and maps session paths under the WSL home directory or mounted Windows drives.
5. Optional: enable **Claude Code Integration** to register the `statusLine` bridge for live Claude context and fallback quota data.

## What's New

| Version | Date | Highlights |
|---------|------|------------|
| **[v1.19.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.19.0)** | Jun 17 | Add clickable Trend breakdowns with provider input/output, thinking/response/tool usage, cache-aware work/billing tokens, and git net-line categories |
| **[v1.18.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.18.2)** | Jun 5 | Fix long Rich quota card titles so Plan Usage columns stay aligned |
| **[v1.18.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.18.1)** | Jun 4 | Stabilize Antigravity quota selection, startup warmup, account labels, and model token stats |
| **[v1.18.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.18.0)** | Jun 2 | Add local-only Antigravity provider support with RPC quota/session scanning |
| **[v1.17.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.17.0)** | Jun 2 | Refactor Plan Usage around provider quota snapshots and quota display groups |

[Full changelog](https://github.com/jeongwookie/WhereMyTokens/releases)

## Highlights

- `provider checkboxes` for Claude Code, Codex, Antigravity, or any combination.
- Provider adapters live under `src/main/providers/` so future providers can join the same quota/session/usage shape.
- Live Claude Code, Codex, and Antigravity quota cards with reset windows.
- Active and recent session tracking from local provider data.
- Today and all-time token, cost, cache, model, and call summaries.
- Activity heatmaps, rhythm charts, model usage, and tool breakdowns.
- Git output metrics for current session repos.
- Persistent totals use `usage-ledger.json`; **Rebuild ledger** in Settings can reset and replay local history.
- Local-first storage with no cloud sync or telemetry.

## Privacy

WhereMyTokens reads local provider files and only calls provider usage endpoints for enabled providers. It does not upload session logs, run cloud sync, or ask you to paste API keys.

Antigravity uses local RPC only. It does not use Google OAuth, refresh tokens, Google cloud usage endpoints, or offline database fallback.

See [Privacy and Security](docs/privacy-security.md) for the full data-source list.

## More

| Topic | Link |
|-------|------|
| Feature details | [docs/features.md](docs/features.md) |
| Privacy and security | [docs/privacy-security.md](docs/privacy-security.md) |
| Development and architecture | [docs/development.md](docs/development.md) |
| Release guide | [RELEASE.md](RELEASE.md) |

## License

MIT
