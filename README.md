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
  <img alt="Japanese UI included" src="https://img.shields.io/badge/Japanese_UI-included-db2777?style=for-the-badge">
  <img alt="Local only" src="https://img.shields.io/badge/Local_only-no_cloud_sync-0f766e?style=for-the-badge">
</p>

<p align="center">
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%2F11-0078d4?style=for-the-badge">
  <a href="https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.24.2"><img alt="Release v1.24.2" src="https://img.shields.io/badge/release-v1.24.2-2563eb?style=for-the-badge"></a>
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

WhereMyTokens is a local-first desktop app for monitoring AI coding usage: quota windows, token totals, API-equivalent cost estimates, cache efficiency, sessions, model usage, activity patterns, and git output.

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
| Windows 10/11 | **[Installer (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.24.2/WhereMyTokens-Setup.exe)** | Normal installation, auto-start from the tray |
| Windows 10/11 — 日本語 UI | **[Japanese UI installer](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.24.2/WhereMyTokens-Setup.exe)** | Same installer; Japanese Windows opens in Japanese automatically, or choose Settings → General → Language |
| Windows 10/11 | **[Portable ZIP](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.24.2/WhereMyTokens-v1.24.2-win-x64.zip)** | No installer, keep it anywhere |
| macOS Apple Silicon | **[macOS Edition](https://github.com/jeongwookie/WhereMyTokens-mac/releases/tag/mac-v1.1.1)** | Menu bar app with DMG/ZIP packaging |

Looking for the menu bar version? See the separate [WhereMyTokens for macOS repository](https://github.com/jeongwookie/WhereMyTokens-mac), which has its own `mac-vX.Y.Z` release track and DMG/ZIP downloads.

By downloading or installing, you agree to the [End-User License Agreement](EULA.txt).

Japanese UI is built into the Windows app. It follows your system language by default on Japanese Windows, and you can override it from Settings → General → Language. Thanks to [@restructure-git](https://github.com/restructure-git) for the translation and key-structure groundwork in [PR #37](https://github.com/jeongwookie/WhereMyTokens/pull/37).

## First Run

1. Install with `WhereMyTokens-Setup.exe`, or extract the portable ZIP and run `WhereMyTokens.exe`.
2. Open the dashboard from the Windows tray.
3. Enable the providers you use: Claude Code, Codex, Antigravity, or any combination.
4. Enable **Claude Code Integration** to register the official `statusLine` bridge for live Claude quota data.

## What's New

| Version | Date | Highlights |
|---------|------|------------|
| **[v1.24.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.24.2)** | Aug 10 | Add actionable Claude login recovery with a one-time Windows notification, the official CLI login flow, credential-change auto-retry, and stale-quota preservation without refreshing or writing credentials |
| **[v1.24.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.24.1)** | Aug 10 | Restore Claude quota when Claude Desktop is active and existing Claude Code credentials are available, even without fresh statusLine data; keep official statusLine first and remove all token refresh/write behavior |
| **[v1.24.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.24.0)** | Aug 10 | Move Claude quota tracking to the official local `statusLine` feed, remove direct Claude OAuth credential access and usage polling, preserve custom status lines, and add minimized atomic snapshots with reset-aware caching |
| **[v1.23.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.23.2)** | Aug 8 | Correct model-specific API-equivalent pricing across Claude and GPT-5.6 price changes, and add lossless SQLite cost repricing with validated backups, checkpoint-bounded replay, concurrent-change protection, and privacy-safe CLI output |
| **[v1.23.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.23.1)** | Jul 27 | Restore Fable scoped quota visibility and Codex Resets display settings, proactively refresh expiring Claude OAuth tokens, and pin UsageIndex test clocks for stable release validation |

[Full changelog](https://github.com/jeongwookie/WhereMyTokens/releases)

## Highlights

- `provider checkboxes` for Claude Code, Codex, Antigravity, or any combination.
- Provider adapters live under `src/main/providers/` and translate provider-reported limits into one canonical Quota Entry shape, separate from local token/cost usage.
- Dynamic Claude Code, Codex, and Antigravity quota cards preserve provider scope, reset time, known-or-unknown duration, and explicit unlimited state. Antigravity 2.x uses the provider-reported `Gemini Models` and `Claude and GPT models` shared groups, with legacy per-model local RPC fallback. Missing limits are absent rather than synthesized as `Unlimited`.
- Claude account limits prefer the official Claude Code `statusLine` 5h/7d fields. When Claude Code is not producing statusLine updates, a read-only compatibility fallback can query the same account windows using the existing Claude Code access token. A model-scoped target such as Fable appears only when one of those provider-reported sources includes it; WhereMyTokens does not infer missing limits.
- When Claude Code login expires or is rejected, WhereMyTokens shows one Windows notification and an in-app action that opens the official `claude auth login` flow. It watches for the credential change and retries automatically, without refreshing tokens or writing credentials itself.
- Optional draggable Windows taskbar mini display uses two physical lines for normalized 5h/7d entries. Two represented periods use one line each; a single represented period can use both lines, with configurable 1-3 blocks per line and compact `+N` hidden-target cues.
- Built-in Japanese UI with a Settings → General → Language selector.
- Codex reset-credit availability can appear as a separate Plan Usage target, with Rich, Simple, or hidden display modes in Settings.
- Active and recent session tracking from local provider data.
- Today and all-time token, cost, cache, model, and call summaries.
- Activity heatmaps, rhythm charts, model usage, and tool breakdowns.
- Git output metrics for current session repos.
- Persistent totals use the source-attributed `usage-index.sqlite`. Request detail is retained for 8 days, hourly precision for 35 days, daily precision for 180 days, and monthly totals indefinitely. First indexing stays responsive and labels incomplete coverage; **Reset index** discards indexed history and rebuilds only from currently available provider logs.
- Local-first storage with no cloud sync or telemetry.

## Privacy

WhereMyTokens reads local provider files and calls only the enabled providers that require a live usage request. It does not upload session logs, run cloud sync, or ask you to paste API keys.

Claude quota monitoring prefers the local Claude Code `statusLine`. When no fresh statusLine quota exists and Claude Code credentials are available, the Desktop compatibility fallback loads `~/.claude/.credentials.json`, extracts the existing access token plus plan metadata, and sends only the access token to the fixed HTTPS host `api.anthropic.com` for a quota request. It ignores the refresh-token property, never refreshes credentials, and never writes the credential file. One request may occur on app launch; during the same run, requests are limited to once per 15 minutes, apply timeout/response-size limits and 429 backoff, and do not retry a rejected access token unless it changes. Cached compatibility quota is bound to a one-way token marker and expires at the earlier of its reported reset time and a 30-minute cap.

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
