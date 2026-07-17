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
  <a href="https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.21.0"><img alt="Release v1.21.0" src="https://img.shields.io/badge/release-v1.21.0-2563eb?style=for-the-badge"></a>
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
| Windows 10/11 | **[Installer (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.21.0/WhereMyTokens-Setup.exe)** | Normal installation, auto-start from the tray |
| Windows 10/11 | **[Portable ZIP](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.21.0/WhereMyTokens-v1.21.0-win-x64.zip)** | No installer, keep it anywhere |
| macOS Apple Silicon | **[macOS Edition](https://github.com/jeongwookie/WhereMyTokens-mac/releases/tag/mac-v1.0.0)** | Menu bar app with DMG/ZIP packaging |

Looking for the menu bar version? See the separate [WhereMyTokens for macOS repository](https://github.com/jeongwookie/WhereMyTokens-mac), which has its own `mac-vX.Y.Z` release track and DMG/ZIP downloads.

By downloading or installing, you agree to the [End-User License Agreement](EULA.txt).

## First Run

1. Install with `WhereMyTokens-Setup.exe`, or extract the portable ZIP and run `WhereMyTokens.exe`.
2. Open the dashboard from the Windows tray.
3. Enable the providers you use: Claude Code, Codex, Antigravity, or any combination.
4. Optional: enable **Claude Code Integration** to register the `statusLine` bridge for live Claude context and fallback quota data.

## What's New

| Version | Date | Highlights |
|---------|------|------------|
| **[v1.21.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.21.0)** | Jul 17 | Replace legacy usage ledgers with the source-attributed SQLite UsageIndex, add Reset index recovery, and tighten taskbar mini overflow hit bounds |
| **[v1.20.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.20.1)** | Jul 10 | Make taskbar mini quota rows configurable from 1-3 blocks, keep hidden-target `+N` cues, and separate source/status prefix tones from quota severity colors |
| **[v1.20.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.20.0)** | Jul 7 | Add Codex reset-credit availability in Plan Usage and an optional self-contained Windows taskbar mini quota display with draggable 5H/1W rows |
| **[v1.19.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.19.2)** | Jun 22 | Stabilize Trend breakdown imports for short Claude thinking blocks by widening the calibration guard |
| **[v1.19.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.19.1)** | Jun 22 | Fix Claude JSONL discovery so agent logs contribute to usage graphs without adding agent-only session rows |

[Full changelog](https://github.com/jeongwookie/WhereMyTokens/releases)

## Highlights

- `provider checkboxes` for Claude Code, Codex, Antigravity, or any combination.
- Provider adapters live under `src/main/providers/` so future providers can join the same quota/session/usage shape.
- Live Claude Code, Codex, and Antigravity quota cards with reset windows.
- Optional draggable Windows taskbar mini display for configurable 1-3 quota blocks per row, compact `+N` hidden-target cues, and transparent taskbar-background-aware rendering.
- Codex reset-credit availability can appear as a separate Plan Usage target, with Rich, Simple, or hidden display modes in Settings.
- Active and recent session tracking from local provider data.
- Today and all-time token, cost, cache, model, and call summaries.
- Activity heatmaps, rhythm charts, model usage, and tool breakdowns.
- Git output metrics for current session repos.
- Persistent totals use the source-attributed `usage-index.sqlite`. Request detail is retained for 8 days, hourly precision for 35 days, daily precision for 180 days, and monthly totals indefinitely. First indexing stays responsive and labels incomplete coverage; **Reset index** discards indexed history and rebuilds only from currently available provider logs.
- Local-first storage with no cloud sync or telemetry.

## Privacy

WhereMyTokens reads local provider files and only calls provider usage endpoints for enabled providers. It does not upload session logs, run cloud sync, or ask you to paste API keys.

Claude quota polling uses the Claude Code CLI credential file at `~/.claude/.credentials.json`; Claude Desktop or browser login does not automatically refresh that local CLI credential.

Codex live usage and reset-credit checks use `~/.codex/auth.json` only for direct OpenAI/ChatGPT requests when Codex is enabled. Reset-credit cache stores counts, expiry times, fetch status, source labels, a hashed auth marker, and the auth file modified time.

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
