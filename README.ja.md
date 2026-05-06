<p align="center">
  <img src="assets/source-icon.png" width="88" alt="WhereMyTokens icon" />
</p>

<h1 align="center">WhereMyTokens</h1>

<p align="center">
  <strong>Codex の追跡に対応しました。</strong>
</p>

<p align="center">
  <img alt="Codex tracking" src="https://img.shields.io/badge/Codex_tracking-new-4f46e5?style=for-the-badge">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-supported-d97706?style=for-the-badge">
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
  <a href="https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.12.0/WhereMyTokens-Setup.exe"><strong>v1.12.0 をダウンロード</strong></a>
  ·
  <a href="#主な機能">主な機能</a>
  ·
  <a href="#screenshots">スクリーンショット</a>
</p>

<p align="center">
  Claude Code と Codex のトークン、コスト、セッション、キャッシュ、モデル別使用量、レート制限を一目で確認できるローカル優先の Windows トレイアプリです。
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
| **[v1.12.0](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.12.0)** | 5/6 | Floating Quota Pace ウィジェット、メインレイアウトのカスタマイズ、時間経過つき使用量バー、新しいスクリーンショット、ウィジェット/設定同期の安定化を追加 |
| **[v1.11.6](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.11.6)** | 4/27 | インストーラー起動時に English/한국어/日本語/简体中文/Español の言語選択を追加し、EULA 本文は英語のまま維持 |
| **[v1.11.5](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.11.5)** | 4/26 | 長時間実行時のポップアップセッション保持範囲を安定化し、changed file で scoped refresh が再拡大する経路を止め、トラブルシュート用の crash/memory 計測をゲート付きで追加 |
| **[v1.11.4](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.11.4)** | 4/25 | ポップアップのセッション一覧を recent + active な作業中心に安定化し、非表示トレイ時の更新コストを下げ、メインプロセス診断を強化 |
| **[v1.11.3](https://github.com/jeongwookie/WhereMyTokens/releases/tag/v1.11.3)** | 4/24 | バックグラウンドのアイドル更新を軽くし、ヘッダーメタデータを整理し、Code Output に現在のセッション repo 範囲を表示 |

[→ 全変更履歴](https://github.com/jeongwookie/WhereMyTokens/releases)

---

## ダウンロード

**[⬇ インストーラーをダウンロード (.exe)](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.12.0/WhereMyTokens-Setup.exe)** — 実行するだけで完了

**[⬇ ポータブル ZIP をダウンロード](https://github.com/jeongwookie/WhereMyTokens/releases/download/v1.12.0/WhereMyTokens-v1.12.0-win-x64.zip)** — インストール不要

ダウンロードまたはインストールにより、[エンドユーザーライセンス契約 (EULA)](EULA.txt) に同意したものとみなされます。

**オプション A — インストーラー** _(推奨)_
1. 上のリンクから `WhereMyTokens-Setup.exe` をダウンロード
2. インストーラーを実行してウィザードに従う
3. アプリが自動で開き、システムトレイに常駐します

**オプション B — ポータブル ZIP** _(インストール不要)_
1. リリースページから `WhereMyTokens-v1.12.0-win-x64.zip` をダウンロード
2. 任意の場所に展開
3. `WhereMyTokens.exe` を実行

---

## 主な機能

### セッション追跡
- **Claude + Codex provider モード** — Claude のみ、Codex のみ、または両方を 1 つのダッシュボードで追跡
- **リアルタイムセッション検出** — ターミナル、VS Code、Cursor、Windsurf など、リアルタイム状態：`active` / `waiting` / `idle` / `compacting`
- **Compact グループ化** — git プロジェクト → ブランチ別、繰り返し Claude/Codex セッションは provider/source/model/state で stack 表示
- **ブランチ row 制限** — 各ブランチは最初の 3 行だけ表示し、残りは "Show N more" で展開
- **コンテキストウィンドウ警告** — セッションごとのバー；70% で琥珀色、85% でオレンジ、95%+ で赤
- **ツール使用バー** — 比例色分けバー + ツールチップ（Bash、Edit、Read など）

### レート制限 & アラート
- **レート制限バー** — Claude 5h/1w は Anthropic API/statusLine、Codex 5h/1w はローカル Codex rate-limit ログイベントを使用
- **Quota Pace 表示** — 使用済み % と経過時間 % を比較し、黄色/赤でリセット前に消費ペースが速い状態を知らせます
- **Claude Code ブリッジ** — `statusLine` プラグインで API ポーリングなしのリアルタイムデータ受信
- **Windows トースト通知** — 使用量しきい値（50% / 80% / 90%）でアラート
- **Claude Extra Usage 予算** — Claude 月間クレジット使用量 / 上限 / 利用率

### 分析 & アクティビティ
- **ヘッダー統計** — today/all-time 切替: コスト、API 呼び出し、セッション、キャッシュ効率、節約額、コンパクトな Claude/Codex メタデータ、Claude の fallback/reset 状態を示す単一ステータス pill
- **起動にやさしい履歴同期** — 現在のセッションと最近の使用量を先に表示し、古い履歴は `Partial History` バナーとともにバックグラウンドで同期を続けます
- **アクティビティタブ** — 7 日間ヒートマップ、5 ヶ月カレンダー（GitHub スタイル）、時間帯別分布、4 週間比較
- **Rhythm タブ** — 時間帯別コスト分布（Morning/Afternoon/Evening/Night）、グラデーションバー、ピーク詳細統計、ローカルタイムゾーン
- **モデル別分析** — 上位モデルごとのトークン・コスト合計、グラデーションバー
- **Activity Breakdown** — Claude は output token、Codex は tool event を基準に 10 カテゴリ分析（Thinking、Edit/Write、Read、Search、Git など）

### Code Output & 生産性
- **Git ベース指標** — コミット数、純変更行数、**$/100 Added**（100 追加行あたりのコスト）
- **Today vs All-time** — 今日の追加行あたり実コストと全期間平均を比較
- **Output 成長グラフ** — 直近 7 日のローカル日付ごとに全期間累積の純増行数を表示
- **現在のセッション repo 範囲** — Code Output は現在追跡中のセッションに結び付いた repo 集計であることをラベル表示
- **ブランチ対応の全期間** — Code Output の全期間は、ローカルブランチ全体のコミットと行変更をローカル git author email 基準で集計
- **自動検出** — Claude プロジェクトは `~/.claude/projects/`、Codex セッションは `~/.codex/sessions/` から自動検出
- **自分のコミットのみ** — `git config user.email` でフィルタリング

### カスタマイズ
- **Auto/Light/Dark テーマ** — デフォルトはシステム設定に従う
- **コスト表示** — USD または KRW、為替レート設定可能
- **Floating usage widget** — 常に最前面に表示される小さな Quota Pace ウィンドウ；トレイメニュー、Settings、ウィジェットボタンから表示/非表示を切替
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
- **Tracking Provider** — Claude / Codex / Both
- **通貨** — USD または KRW
- **アラート** — 使用量しきい値の設定（50% / 80% / 90%）
- **テーマ** — Auto（システム設定に従う）/ Light / Dark
- **トレイラベル** — タスクバーに表示する情報を選択
- **Floating usage widget** — 小さな Quota Pace ウィンドウを有効化できます。あとからトレイアイコンの右クリックで表示/非表示を切り替えられます

---

## 起動とヘッダーステータス

起動直後は現在のセッションと最近の使用量を先に表示します。`Partial History` が見える場合は、古い履歴をバックグラウンドで同期している途中で、トレイアプリを速く開くための動作です。

ヘッダーのステータス pill は Claude/API の重要な状態を 1 か所にまとめます。代表的なラベルは `Local estimate`（ローカルのフォールバックデータを使用中）、`Reset unavailable`（使用量は取得できたが reset 時刻がない）、`Rate limited`、`API offline` です。pill にホバーすると最新の詳細を確認できます。

---

## Claude Code 連携（ブリッジ）

WhereMyTokens は公式の `statusLine` プラグインメカニズムを通じて、Claude Code からリアルタイムのレート制限データを受信できます — API ポーリング不要。

**仕組み：**
1. **Settings → Claude Code Integration → Setup** を実行
2. `~/.claude/settings.json` に WhereMyTokens を `statusLine` コマンドとして登録
3. Claude Code が実行されるたびに、セッションデータ（レート制限、コンテキスト %、モデル、コスト）を stdin 経由で送信
4. アプリが即座に更新 — ポーリングの遅延なし

ブリッジはコンテキストウィンドウ %、モデル、コストなどの補助データを提供します。レート制限のパーセンテージは常に Anthropic API を権威あるソースとして使用し、API が利用できない場合のみブリッジ値にフォールバックします。

---

## Codex 追跡

WhereMyTokens は Codex のローカル JSONL ログ（`~/.codex/sessions/**/*.jsonl`）も読み取れます。Settings で **Claude**、**Codex**、**Both** のいずれかを選択します。

**Codex 追跡に含まれるもの：**
- セッション状態、プロジェクト/ブランチのグループ化、VS Code や Codex Exec などの source 表示
- GPT/Codex モデルごとの使用量と API 換算コスト推定
- input、cached input、output トークン、キャッシュ節約額、全期間モデル別合計
- ローカルログに `rate_limits` イベントがある場合の Codex 5h/1w 使用率と reset 時刻
- Codex ログは tool ごとの output token ではなく tool call を提供するため、Activity Breakdown は tool event count として表示

**Codex キャッシュ計算式：** Codex ログは `input_tokens` と `cached_input_tokens` を提供します。WhereMyTokens は uncached input を `input_tokens - cached_input_tokens`、cached input を cache-read token として保存し、キャッシュ効率を次の式で表示します。

```text
cached_input_tokens / input_tokens
```

Claude のキャッシュ効率は次の式を使います。

```text
cache_read_input_tokens / (cache_read_input_tokens + cache_creation_input_tokens)
```

---

## レート制限の仕組み

Claude と Codex は別々の制限ソースと 5h/1w reset window を使用します。

| 優先度 | ソース | 説明 |
|--------|--------|------|
| Claude 第 1 | **Anthropic API** | `/api/oauth/usage` — ウェブダッシュボードと同じ権威あるデータ。3 分ごとに取得、429 時は指数バックオフ。 |
| Claude 第 2 | **ブリッジ（stdin）** | `statusLine` 経由で Claude Code からのリアルタイムデータ。API 不可時のフォールバック。 |
| Codex | **ローカル Codex ログ** | `~/.codex/sessions/**/*.jsonl` 内の `rate_limits` イベントのうち最新の観測値を使用。 |
| フォールバック | **最後の既知の値** | データ取得失敗時は最後の成功値を保持。リセット済みの古いデータは自動クリア。 |

ヘッダーのステータス pill は API/フォールバック状態を示します。`Local estimate`、`Reset unavailable`、`Rate limited`、`API offline` などのラベルが表示され、ホバーすると最新の詳細を確認できます。

---

## 数値の計算基準

すべてのトークン数は、利用可能な場合 **input + output + キャッシュ生成 + キャッシュ読み取り** を含みます。コストはアプリ内の価格表を使った API 換算推定値です。

Claude は input、output、cache creation、cache read を提供します。Codex は raw input、cached input、output を提供するため、WhereMyTokens は raw input を uncached input と cached input に分け、キャッシュ節約額とモデル別合計が二重計算されないようにします。

| 表示場所 | 範囲 | 含まれる内容 |
|---------|------|------------|
| ヘッダー (today) | 今日の深夜以降 | In/Out/Cache + 呼び出し数、セッション数、キャッシュ節約 |
| ヘッダー (all) | 全期間 | In/Out/Cache + 呼び出し数、セッション数、キャッシュ節約 |
| Plan Usage (Claude 5h / 1w) | Claude reset window | Claude トークン種別 + API/statusLine 制限 |
| Plan Usage (Codex 5h / 1w) | Codex reset window | Codex トークン種別 + ローカル rate-limit イベント |
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

## データ & プライバシー

WhereMyTokens はローカルファイルのみを読み取ります — クラウド同期なし、テレメトリなし。

| ファイル | 用途 |
|----------|------|
| `~/.claude/sessions/*.json` | セッションメタデータ（pid、cwd、モデル） |
| `~/.claude/projects/**/*.jsonl` | 会話ログ（トークン数、コスト） |
| `~/.claude/.credentials.json` | OAuth トークン — Anthropic から自分の使用量を取得するためのみ使用 |
| `~/.codex/sessions/**/*.jsonl` | Codex セッションログ（トークン数、cached input、モデル、rate-limit イベント、tool call） |
| `%APPDATA%\WhereMyTokens\live-session.json` | `statusLine` プラグインのブリッジデータ |

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
