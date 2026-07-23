<p align="center">
  <img src="assets/readme-icon.png" width="88" alt="WhereMyTokens icon" />
</p>

<h1 align="center">WhereMyTokens</h1>

<p align="center">
  <strong>Claude Code、Codex、Antigravity の使用状況を日本語 UI で確認できます。</strong>
</p>

<p align="center">
  <img alt="Codex tracking" src="https://img.shields.io/badge/Codex_tracking-supported-4f46e5?style=for-the-badge">
  <img alt="Antigravity" src="https://img.shields.io/badge/Antigravity-new-0f766e?style=for-the-badge">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-supported-d97706?style=for-the-badge">
  <img alt="日本語 UI" src="https://img.shields.io/badge/日本語_UI-搭載-db2777?style=for-the-badge">
  <img alt="Local only" src="https://img.shields.io/badge/Local_only-no_cloud_sync-0f766e?style=for-the-badge">
</p>

<p align="center">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%2F11-0078d4?style=for-the-badge">
  <img alt="Release" src="https://img.shields.io/github/v/release/jeongwookie/WhereMyTokens?style=for-the-badge">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.23.0/WhereMyTokens-Setup.exe"><strong>v1.23.0 をダウンロード</strong></a>
  ·
  <a href="https://github.com/jeongwookie/WhereMyTokens-mac">macOS 版</a>
  ·
  <a href="#主な機能">主な機能</a>
  ·
  <a href="#screenshots">スクリーンショット</a>
</p>

<p align="center">
  <strong>macOS 版も公開しました:</strong>
  <a href="https://github.com/jeongwookie/WhereMyTokens-mac">WhereMyTokens for macOS</a>
  は別の <code>mac-vX.Y.Z</code> release track と DMG/ZIP packaging で管理します。
</p>

<p align="center">
  <em>v1.23.0 は provider quota を動的 Quota Entry に統一し、報告されない limit を Unlimited として合成しません。</em>
</p>

<p align="center">
  Claude Code、Codex、Antigravity のトークン、コスト、セッション、キャッシュ、モデル別使用量、quota を一目で確認できるローカル優先の Windows トレイアプリです。
</p>

<a id="screenshots"></a>

<table>
  <tr>
    <th>ダーク概要</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-overview-dark.png" alt="WhereMyTokens ダーク概要" /></td>
  </tr>
  <tr>
    <th>ライト概要</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-overview-light.png" alt="WhereMyTokens ライト概要" /></td>
  </tr>
</table>

> Claude Code を毎日使う韓国人開発者が、自分のために作って使い続けているアプリです。

## 最新アップデート

| バージョン | 日付 | 主な変更 |
|-----------|------|--------|
| **[v1.23.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.23.0)** | 7/19 | dashboard、alert、tray、compact widget、taskbar helper が同じ動的 Quota Entry を使うよう整理し、報告されない limit は `Unlimited` に合成せず absent のまま保持 |
| **[v1.22.3](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.22.3)** | 7/18 | SQLite 使用履歴を compact projection として読み込み、大きな履歴でもダッシュボードのメモリ使用を大きく下げつつ、today/5h/weekly/モデル別 quota 計算を維持 |
| **[v1.22.2](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.22.2)** | 7/18 | tray-owned dashboard/widget window でタスクバーの点滅を抑え、Compact widget のボタンと hide 保存を修正し、大きな使用履歴のメモリ負荷を下げつつ Codex `Unlimited` 表示を維持 |
| **[v1.22.1](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.22.1)** | 7/17 | Codex が一時的に 5h/1w 制限 window を報告しない場合は `Unlimited` として表示し、Syncing のまま残らないよう改善 |
| **[v1.22.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.22.0)** | 7/17 | 日本語 UI を内蔵し、AppSettings に保存される言語選択と日本語向けダウンロード案内を追加。@restructure-git さんの PR #37 を参考に統合 |

[→ 全変更履歴](https://github.com/jeongwookie/WhereMyTokens/releases)

---

## ダウンロード

macOS ユーザーは別の公開リポジトリを使用してください:
**[WhereMyTokens for macOS](https://github.com/jeongwookie/WhereMyTokens-mac)**.

**[⬇ インストーラーをダウンロード (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.23.0/WhereMyTokens-Setup.exe)** — 実行するだけで完了

> **日本語 UI 内蔵:** Windows の表示言語が日本語なら自動で日本語 UI になります。あとから **Settings → 一般 → 言語** で「システム設定 / English / 日本語」を切り替えられます。日本語化は [@restructure-git](https://github.com/restructure-git) さんの翻訳とキー構造の提案（[PR #37](https://github.com/jeongwookie/WhereMyTokens/pull/37)）を参考に統合しました。ありがとうございます。

**[⬇ ポータブル ZIP をダウンロード](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.23.0/WhereMyTokens-v1.23.0-win-x64.zip)** — インストール不要

ダウンロードまたはインストールにより、[エンドユーザーライセンス契約 (EULA)](EULA.txt) に同意したものとみなされます。

**オプション A — インストーラー** _(推奨)_
1. 上のリンクから `WhereMyTokens-Setup.exe` をダウンロード
2. インストーラーを実行してウィザードに従う
3. アプリが自動で開き、システムトレイに常駐します

**オプション B — ポータブル ZIP** _(インストール不要)_
1. リリースページから `WhereMyTokens-v1.23.0-win-x64.zip` をダウンロード
2. 任意の場所に展開
3. `WhereMyTokens.exe` を実行

---

## 主な機能

### セッション追跡
- **Provider 選択** — Claude Code、Codex、Antigravity を 1 つのダッシュボードでオン/オフして追跡
- **リアルタイムセッション検出** — ターミナル、VS Code、Cursor、Windsurf など、リアルタイム状態：`active` / `waiting` / `idle` / `compacting`
- **Compact グループ化** — git プロジェクト → ブランチ別、繰り返し provider セッションは provider/source/model/state で stack 表示
- **ブランチ row 制限** — 各ブランチは最初の 3 行だけ表示し、残りは "Show N more" で展開
- **コンテキストウィンドウ警告** — セッションごとのバー；70% で琥珀色、85% でオレンジ、95%+ で赤
- **ツール使用バー** — 比例色分けバー + ツールチップ（Bash、Edit、Read など）

### レート制限 & アラート
- **Provider quota バー** — Claude、Codex、Antigravity、および今後の provider は、provider が報告した limit を `providerQuotas` の canonical Quota Entry として公開します。Claude は Anthropic usage の top-level 5h/7d account window と scoped `limits[]`、Codex は live usage snapshot と local-log fallback、reset-credit endpoint と auth-bound cache、Antigravity は IDE 実行中の 127.0.0.1 local RPC のモデル quota entry を使います。報告されない limit は `Unlimited` として合成せず、未存在として扱います
- **Target 別 quota 表示** — 各 canonical quota target は Settings で Rich、Simple、非表示にでき、Plan Usage、Floating widget、taskbar mini の表示順と表示対象に反映されます。Taskbar mini は正規化された 5h/7d entry を 2 本の physical line に配置し、line ごとに 1-3 個のブロック制限と非表示 target の `+N` 表示をサポートします。prefix の色は quota severity ではなく live/cache/log などのデータ source/status を表します。Codex Resets target は Plan Usage 専用です
- **Quota Pace 表示** — 使用済み % と経過時間 % を比較し、黄色/赤でリセット前に消費ペースが速い状態を知らせます
- **Claude Code ブリッジ** — `statusLine` プラグインで API ポーリングなしのリアルタイムデータ受信
- **Windows トースト通知** — 使用量しきい値（50% / 80% / 90%）でアラート
- **Claude Extra Usage 予算** — Claude 月間クレジット使用量 / 上限 / 利用率

### 分析 & アクティビティ
- **ヘッダー統計** — today/all-time 切替: コスト、API 呼び出し、セッション、キャッシュ効率、節約額、コンパクトな provider メタデータ、provider ごとの health/fallback 状態。`all` のセッション数は全使用履歴に基づきます
- **即時起動 snapshot** — 最後に正常表示された UI 状態をすぐに復元し、新しい scan はバックグラウンドで続行
- **起動にやさしい履歴同期** — 現在のセッションと最近の使用量を先に表示し、古い履歴は budgeted refresh scheduler 経由でバックグラウンド同期され、hotkey popup と UI の応答性を保ちます
- **永続 usage index** — Claude、Codex、Antigravity の使用量を source-attributed `usage-index.sqlite` に保存します。request 詳細は 8 日、hourly 精度は 35 日、daily 精度は 180 日、月別合計は永続保持します。初回 indexing は UI をブロックせず、coverage が未完了であることを表示します。**Reset index** はインデックス済み履歴を消去し、現在利用できる provider logs だけから再構築します
- **Trend カード** — 日/週/月の cost/token 履歴に git net-line output を重ね、bucket をクリックすると provider 別 input/output、thinking/response/tool 使用量、work/billing token、git net-line category を breakdown 表示します
- **アクティビティタブ** — 7 日間ヒートマップ、5 ヶ月カレンダー（GitHub スタイル）、時間帯別分布、4 週間比較
- **Rhythm タブ** — 時間帯別コスト分布（Morning/Afternoon/Evening/Night）、グラデーションバー、ピーク詳細統計、ローカルタイムゾーン
- **モデル別分析** — 上位モデルごとのトークン・コスト合計、グラデーションバー
- **Activity Breakdown** — Claude は output token、Codex は tool event を基準に 10 カテゴリ分析（Thinking、Edit/Write、Read、Search、Git など）
- **Codex reset credit** — 使用可能な reset credit count と最も近い有効期限を Plan Usage に表示し、reset endpoint 失敗時は stale/error badge と tooltip で状態を示します

### Code Output & 生産性
- **Git ベース指標** — コミット数、純変更行数、**$/100 Added**（100 追加行あたりのコスト）
- **Today vs All-time** — 今日の追加行あたり実コストと全期間平均を比較
- **Output 成長グラフ** — 直近 7 日のローカル日付ごとに全期間累積の純増行数を表示
- **現在のセッション repo 範囲** — Code Output は現在追跡中のセッションに結び付いた repo 集計であることをラベル表示
- **ブランチ対応の全期間** — Code Output の全期間は、ローカルブランチ全体のコミットと行変更をローカル git author email 基準で集計
- **自動検出** — Claude プロジェクトは `~/.claude/projects/` から agent 使用ログも含め、Codex セッションは `~/.codex/sessions/`、`~/.codex/archived_sessions/`、`~/.codex/session-cleanup-archive/` から自動検出し、Antigravity は実行中のローカル language server の cascade を local RPC で読み取ります
- **自分のコミットのみ** — `git config user.email` でフィルタリング

### カスタマイズ
- **Auto/Light/Dark テーマ** — デフォルトはシステム設定に従う
- **言語** — デフォルトはシステム設定に従い、English / 日本語に固定できます
- **コスト表示** — USD または KRW、為替レート設定可能
- **Floating usage widget** — 常に最前面に表示される小さな Quota Pace ウィンドウ；メインヘッダー、トレイメニュー、Settings、ウィジェットボタンから表示/非表示を切替。Waiting animation はデフォルトでオフで、Settings から再有効化できます
- **トレイラベル** — 使用量 %、トークン数、コストを直接表示
- **プロジェクト管理** — 非表示または追跡から完全除外
- **Windows 起動時に自動起動** — オプション

---

## クイックスタート

### 1. ダッシュボードを開く
トレイアイコンをクリック（またはグローバルショートカット `Ctrl+Shift+D`）。

### 2. Claude Code ブリッジを接続（オプション）
**Settings → Claude Code Integration → Setup** — API ポーリングなしでリアルタイムデータ受信。

### 3. 設定
- **Tracking providers** — Claude Code、Codex、Antigravity のチェックボックスを切り替え
- **通貨** — USD または KRW
- **アラート** — 使用量しきい値の設定（50% / 80% / 90%）
- **テーマ** — Auto（システム設定に従う）/ Light / Dark
- **言語** — システム設定 / English / 日本語
- **トレイラベル** — タスクバーに表示する情報を選択
- **Floating usage widget** — 小さな Quota Pace ウィンドウを有効化できます。あとからメインヘッダーのトグルやトレイメニューで表示/非表示を切り替えられます

---

## アーキテクチャ

WhereMyTokens は local-first の Electron トレイアプリです。renderer はローカルファイルや認証情報を直接読み取らず、ファイルシステム、provider API、トレイ、設定の処理は Electron main process に置き、preload bridge 経由でのみ renderer に渡します。

| レイヤー | 役割 |
|----------|------|
| Electron main | Provider セッションを検出し、各 usage source を一度だけ parse/fetch して canonical UsageIndex を query し、トレイ/ウィンドウ状態とアプリ設定を管理します。 |
| Preload bridge | `contextIsolation` 境界を保ちながら typed `window.wmt` IPC surface だけを公開。 |
| React renderer | トレイダッシュボード、設定、通知、アクティビティチャート、compact quota ウィジェットを表示。 |
| `statusLine` bridge | `src/bridge/bridge.ts` が Claude Code stdin JSON を受け取り、main process が監視するローカル bridge snapshot を書き込みます。 |

| データフロー | ソース | 宛先 | ネットワーク |
|--------------|--------|------|--------------|
| Claude セッション | `~/.claude/sessions/*.json`, `~/.claude/projects/**/*.jsonl` | main process scanner が UsageIndex に書き込み、session projection を公開 | なし |
| Claude ブリッジ | Claude Code `statusLine` stdin | `%APPDATA%\WhereMyTokens\live-session.json` | なし |
| Claude 使用量制限 | `~/.claude/.credentials.json` OAuth token | Anthropic `/api/oauth/usage` | あり、Anthropic へ直接 |
| Codex セッション | `~/.codex/sessions/**/*.jsonl`, `~/.codex/archived_sessions/**/*.jsonl`, `~/.codex/session-cleanup-archive/**/*.jsonl` | main process scanner が UsageIndex に書き込み、session projection を公開 | なし |
| Codex 使用量制限と reset credit | `~/.codex/auth.json` OAuth token | ChatGPT/Codex usage endpoint と reset-credit endpoint | あり、OpenAI/ChatGPT へ直接 |
| Antigravity セッション/quota | 実行中の Antigravity language server | 127.0.0.1 local RPC、その後 renderer state | なし |

Quota の優先順位は provider ごとに異なります。Claude は Anthropic API を第 1 ソースにし、`statusLine` bridge をフォールバックにします。Codex の 5h/7d quota entry は live usage を優先し、cache/JSONL ログ内のローカル `rate_limits` イベントへフォールバックできます。報告されない Codex limit は `Unlimited` として合成しません。Codex reset credit は reset-credit endpoint を優先し、auth-bound cache または live usage payload の count-only 値にだけフォールバックします。Antigravity は実行中の IDE の 127.0.0.1 local RPC だけを使い、最後の成功値は stale になるまでだけ保持します。

---

## セキュリティ & プライバシー

WhereMyTokens はローカルファイルを読み取り、有効な場合は自分のアカウントの provider 使用量 API だけを直接呼び出します。クラウド同期とテレメトリはありません。

| ローカルパス | 用途 |
|--------------|------|
| `~/.claude/sessions/*.json` | pid、cwd、モデルなどの Claude セッションメタデータ。 |
| `~/.claude/projects/**/*.jsonl` | トークン数、コスト、コンテキスト、活動サマリー計算用の Claude 会話ログ。 |
| `~/.claude/.credentials.json` | Anthropic 使用量取得と期限切れ access token refresh にだけ使う Claude OAuth 情報。 |
| `~/.codex/sessions/**/*.jsonl` | 現在の Codex セッションログ。トークン、cached input、モデル、rate-limit イベント、tool 活動計算に使用します。 |
| `~/.codex/archived_sessions/**/*.jsonl` | All-time 使用量に含める Codex アーカイブ済みセッションログ。 |
| `~/.codex/session-cleanup-archive/**/*.jsonl` | All-time 使用量に含める Codex cleanup アーカイブログ。 |
| `~/.codex/auth.json` | Codex 使用量 snapshot と reset-credit 取得にだけ使う ChatGPT OAuth 情報。アプリ storage へコピーしたりログ出力したりしません。reset-credit cache には count、有効期限、fetch status、source label、hashed auth marker、auth file modified time だけを保存します。 |
| Antigravity local RPC | 実行中の Antigravity IDE の language server からセッション、モデル quota、generator metadata を読み取ります。Google OAuth、refresh token、Google cloud usage endpoint、オフライン DB fallback は使いません。 |
| `%APPDATA%\WhereMyTokens\live-session.json` | Claude Code `statusLine` bridge が書き込むローカル bridge snapshot。 |
| Taskbar mini helper stdin | taskbar mini が有効な場合、main process は正規化された 5h/7d quota entry から作った 2 本の physical display line と resolved light/dark theme fallback を native helper に渡します。helper は contrast のため表示中のタスクバー背景をローカルでサンプリングしますが、pixel は保存も送信もしません。credentials、ログファイル、provider API を直接読み取ったり呼び出したりしません。 |
| `%LOCALAPPDATA%\WhereMyTokens\TaskbarHelper\layout.json` | taskbar mini のタスクバー相対位置だけを保存します。 |
| `%APPDATA%\WhereMyTokens\usage-index.sqlite` | incremental checkpoint、長期合計、trend bucket、heatmap に使うローカル usage index。 |
| Electron app data (`%APPDATA%\WhereMyTokens`) | アプリ設定、ローカルキャッシュ、通知履歴、bridge 状態。 |

認証情報の扱いは狭く限定されています。WhereMyTokens は公式 CLI のローカル credential ファイルを読み取り、API key の貼り付けを求めず、別の credential バックアップを保存しません。Claude access token が期限切れの場合は Anthropic で refresh し、更新された credentials を `~/.claude/.credentials.json` に原子的に書き戻すことがあります。

ネットワークアクセスは有効にした provider チェックボックスの usage endpoint とローカル loopback に限定されます。Claude usage polling は最大 5 分ごとに実行し、429 backoff を適用します。Codex live usage と reset-credit check は HTTPS-only request、timeout、レスポンスサイズ制限、cache、個別 backoff を適用します。Antigravity 追跡は 127.0.0.1 local RPC だけを使い、Google OAuth、refresh token、Google cloud usage endpoint、オフライン DB fallback は使いません。ローカル JSONL 解析、Antigravity local RPC、`statusLine` bridge はセッション内容を外部へ送信しません。

Claude Code bridge を無効化するには **Settings -> Claude Code Integration -> Disable** を押します。アプリは WhereMyTokens bridge command が所有する `statusLine` entry だけを削除し、他の custom `statusLine` を上書きまたは削除しません。手動では `~/.claude/settings.json` から WhereMyTokens の `statusLine` entry を削除し、Claude Code を再起動してください。

---

## 起動とヘッダーステータス

起動直後は現在のセッションと最近の使用量を先に表示します。`Partial History` が見える場合は、古い履歴を budgeted background slice で同期している途中で、トレイアプリと hotkey popup の応答性を保つための動作です。

ヘッダーの小さな PiP ボタンで Floating Quota Pace ウィジェットを直接オン/オフできます。ヘッダーのステータス pill は provider/API の重要な状態を 1 か所にまとめます。代表的なラベルは `Claude local`、`Claude partial`、`Claude refresh`、`Claude login`、`Claude limited`、`Claude offline`、`refresh failed` です。Quota Pace ウィジェットは `Claude OK`、`Codex OK`、`Antigravity OK` のように provider 別の health チップを表示し、pill やチップにホバーすると最新の詳細を確認できます。

---

## Provider 追跡詳細

### Claude Code ブリッジ

WhereMyTokens は Claude Code の公式 `statusLine` プラグインメカニズムを通じて、コンテキスト、モデル、コスト、フォールバック用レート制限データをリアルタイムで受信できます。**Settings -> Claude Code Integration -> Setup** で登録し、**Disable** で WhereMyTokens が所有する bridge entry を削除します。

### Codex 追跡

WhereMyTokens は Codex のローカル JSONL ログ（`~/.codex/sessions/**/*.jsonl`、`~/.codex/archived_sessions/**/*.jsonl`、`~/.codex/session-cleanup-archive/**/*.jsonl`）も読み取れます。Settings で追跡したい provider チェックボックスを有効にします。

**Codex 追跡に含まれるもの：**
- セッション状態、プロジェクト/ブランチのグループ化、VS Code や Codex Exec などの source 表示
- GPT/Codex モデルごとの使用量と API 換算コスト推定
- input、cached input、output トークン、キャッシュ節約額、全期間モデル別合計
- live Codex usage が使える場合に報告された Codex 5h/7d quota entry の使用率と reset 時刻、失敗時のキャッシュ/ローカル `rate_limits` フォールバック
- 使用可能な reset credit 数、最も近い有効期限、reset endpoint 失敗時の stale/error 状態
- Codex ログは tool ごとの output token ではなく tool call を提供するため、Activity Breakdown は tool event count として表示

### Antigravity 追跡

Antigravity 追跡は、実行中の Antigravity IDE の language server に 127.0.0.1 local RPC でのみ接続します。セッション cascade、モデル quota、generator metadata を読み取り providerQuotas と source-attributed UsageIndex に反映し、Google OAuth、refresh token、Google cloud usage endpoint、オフライン DB fallback は使いません。

Antigravity のモデル quota カードはデフォルトでは percent-only です。Settings の **Antigravity quota pace** を有効にすると、reset time から 5h/7d pacing を推定します。

**Prompt キャッシュ計算式：** Codex ログは `input_tokens` と `cached_input_tokens` を提供します。WhereMyTokens は uncached input を `input_tokens - cached_input_tokens`、cached input を cache-read token として保存します。Codex と Antigravity は cache read が prompt token に占める割合をキャッシュ効率として表示します。

```text
cache_read_tokens / (uncached_input_tokens + cache_creation_tokens + cache_read_tokens)
```

Codex ではこれは `cached_input_tokens / input_tokens` と同じです。Claude は cache write/read 効率を使います。

```text
cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens)
```

## 数値の計算基準

すべてのトークン数は、利用可能な場合 **input + output + キャッシュ生成 + キャッシュ読み取り** を含みます。コストはアプリ内の価格表を使った API 換算推定値です。

Claude は input、output、cache creation、cache read を提供します。Codex は raw input、cached input、output を提供するため、WhereMyTokens は raw input を uncached input と cached input に分け、キャッシュ節約額とモデル別合計が二重計算されないようにします。

| 表示場所 | 範囲 | 含まれる内容 |
|---------|------|------------|
| ヘッダー (today) | 今日の深夜以降 | In/Out/Cache + 呼び出し数、セッション数、キャッシュ節約 |
| ヘッダー (all) | 全期間 | In/Out/Cache + 呼び出し数、セッション数、キャッシュ節約 |
| Plan Usage (provider quotas) | Provider reset window | Provider トークン種別 + `providerQuotas[provider]` window、status、source、credit、target 別 Rich/Simple/None 表示モード |
| Model Usage | 全期間、provider 別の上位 4 モデル | すべてのトークン種別 |

> **注意：** `$` 値は推定値であり、実際の請求額ではありません。Claude Max/Pro サブスクリプションは月額固定料金であり、コスト表示はサブスクリプションから得られる使用価値を示します。

---

## アクティビティタブ

| タブ | 説明 |
|------|------|
| 7d | 7 日間ヒートマップ（曜日 × 時間グリッド）、時間軸 + 色凡例 |
| 5mo | 5 ヶ月カレンダーグリッド（GitHub スタイル、日付+トークンをホバー表示） |
| Hourly | 直近 30 日間の時間帯別トークン分布 |
| Weekly | 直近 4 週間の横棒グラフ |
| Rhythm | 時間帯別コスト分布 — Morning ☀️ / Afternoon 🔥 / Evening 🌆 / Night 🌙、グラデーションバー、ピーク詳細統計、ローカルタイムゾーン（30 日間） |

---

## Activity Breakdown

セッション行の **Details** ボタンをクリックすると、カテゴリ別の活動分析が展開されます。Claude セッションは output token の配分を表示し、Codex セッションは tool ごとの output token ではなく function/tool call ログがあるため tool event count を表示します。同時に開けるのは 1 つのみ。

| カテゴリ | 色 | ソース |
|---------|-----|--------|
| 💭 Thinking | ティール | 拡張思考ブロック |
| 💬 Response | スレート | テキストブロック — 最終回答 |
| 📄 Read | ブルー | `Read` ツール |
| ✏️ Edit / Write | バイオレット | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` |
| 🔍 Search | スカイ | `Grep`, `Glob`, `LS`, `TodoRead`, `TodoWrite` |
| 🌿 Git | グリーン | `Bash` — `git` コマンド |
| ⚙️ Build / Test | オレンジ | `Bash` — `npm`, `tsc`, `jest`, `cargo`, `python` など |
| 💻 Terminal | アンバー | その他の `Bash` コマンド; `mcp__*` ツール |
| 🤖 Subagents | ピンク | `Agent` ツール |
| 🌐 Web | パープル | `WebFetch`, `WebSearch` |

> **トークン配分：** 各ターンの output トークンをコンテンツブロック文字数比率で分配（`ブロック文字数 ÷ 総文字数 × output トークン数`）。値が 0 のカテゴリは非表示。

---

## ソースからインストール

### 動作要件

- Windows 10 / 11
- [Node.js](https://nodejs.org) 18+
- [Claude Code](https://claude.ai/code) インストール済みでログイン状態

### ビルド & 実行

```bash
git clone https://github.com/jeongwookie/WhereMyTokens.git
cd WhereMyTokens
npm install
npm run build
npm start
```

### インストーラーのビルド

```bash
npm run dist
# -> release/WhereMyTokens Setup x.x.x.exe  (NSIS インストーラー)
# -> release/WhereMyTokens x.x.x.exe         (ポータブル)
```

> **注意：** Windows で NSIS インストーラーをビルドするには開発者モードの有効化が必要です（設定 → 開発者向け → 開発者モード）。`release/win-unpacked/` のポータブル `.exe` は開発者モードなしでも動作します。

---

## デモ

<div align="center">

https://github.com/user-attachments/assets/98b6f8d7-6fc6-4c12-aef1-af6300db0728

</div>

---

## 免責事項

表示されるコストは **API 換算の推定値**であり、実際の請求額ではありません。Claude Max/Pro サブスクリプションは月額固定料金であり、コスト表示はサブスクリプションから得られる使用価値を示します。

---

## コントリビュート

Issue や Pull Request を歓迎します。変更したい内容がある場合は、まず Issue を開いてください。

---

## 謝辞

macOS 版である [duckbar](https://github.com/rofeels/duckbar) にインスパイアされました。

---

## ライセンス

MIT
