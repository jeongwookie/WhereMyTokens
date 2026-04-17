<img src="assets/source-icon.png" width="80" align="right" />

# WhereMyTokens

**Claude Code のトークン使用量をリアルタイムで監視する Windows システムトレイアプリ。**

Claude Code を毎日使う韓国人開発者が、自分のために作って使い続けているアプリです。

タスクバーに常駐し、Claude Code の使用状況 — トークン数、コスト、セッション活動、レート制限 — を一目で確認できます。

![Platform](https://img.shields.io/badge/platform-Windows_10%2F11-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Release](https://img.shields.io/github/v/release/jeongwookie/WhereMyTokens)

> [English](README.md) | [한국어](README.ko.md) | [中文](README.zh-CN.md) | [Español](README.es.md)

> 💾 **クラウド同期なし** — ローカルの Claude ファイルのみを読み取ります。データは外部に送信されません。

<table>
  <tr>
    <th width="50%">ライトモード</th>
    <th width="50%">ダークモード</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-light.png" alt="Light mode" /></td>
    <td><img src="assets/screenshot-dark.png" alt="Dark mode" /></td>
  </tr>
</table>

<table>
  <tr>
    <th width="33%">Rhythm & ピーク統計</th>
    <th width="33%">7 日間ヒートマップ</th>
    <th width="33%">設定</th>
  </tr>
  <tr>
    <td><img src="assets/screenshot-rhythm.png" alt="Rhythm tab" /></td>
    <td><img src="assets/screenshot-heatmap.png" alt="7-day heatmap" /></td>
    <td><img src="assets/screenshot-settings.png" alt="Settings" /></td>
  </tr>
</table>

## ダウンロード

**[⬇ 最新リリースをダウンロード](https://github.com/jeongwookie/WhereMyTokens/releases/latest)**

1. `WhereMyTokens-v1.9.1-win-x64.zip` をダウンロード
2. 任意の場所に展開
3. `WhereMyTokens.exe` を実行

インストール不要 — アプリが自動で開き、システムトレイに常駐します。

---

## 主な機能

### セッション追跡
- **リアルタイムセッション検出** — ターミナル、VS Code、Cursor、Windsurf など、リアルタイム状態：`active` / `waiting` / `idle` / `compacting`
- **2 段階グループ化** — git プロジェクト → ブランチ別、プロジェクトごとのコミット・行数統計
- **Idle 自動非表示** — idle セッションは段階的に折りたたみ；6 時間以上は自動非表示（展開可能）
- **コンテキストウィンドウ警告** — セッションごとのバー；50% で琥珀色、80% でオレンジ、95%+ で赤
- **ツール使用バー** — 比例色分けバー + ツールチップ（Bash、Edit、Read など）

### レート制限 & アラート
- **レート制限バー** — Anthropic API 5 時間・週間使用量、プログレスバー、リセットカウンター、キャッシュ効率グレード
- **Claude Code ブリッジ** — `statusLine` プラグインで API ポーリングなしのリアルタイムデータ受信
- **Windows トースト通知** — 使用量しきい値（50% / 80% / 90%）でアラート
- **Extra Usage 予算** — 月間クレジット使用量 / 上限 / 利用率

### 分析 & アクティビティ
- **ヘッダー統計** — today/all-time トグル：コスト、API 呼び出し、セッション、キャッシュ効率、節約額、トークン内訳（In/Out/Cache）
- **アクティビティタブ** — 7 日間ヒートマップ、5 ヶ月カレンダー（GitHub スタイル）、時間帯別分布、4 週間比較
- **Rhythm タブ** — 時間帯別コスト分布（Morning/Afternoon/Evening/Night）、グラデーションバー、ピーク詳細統計、ローカルタイムゾーン
- **モデル別分析** — モデルごとのトークン・コスト合計、グラデーションバー
- **Activity Breakdown** — セッション別 output トークン 10 カテゴリ分析（Thinking、Edit/Write、Read、Search、Git など）

### Code Output & 生産性
- **Git ベース指標** — コミット数、純変更行数、**$/100 Lines**（100 行追加あたりのコスト）
- **Today vs All-time** — 今日の実際のコストと全期間平均を比較
- **自動検出** — `~/.claude/projects/` の履歴から Claude 使用全プロジェクトを含む
- **自分のコミットのみ** — `git config user.email` でフィルタリング

### カスタマイズ
- **Auto/Light/Dark テーマ** — デフォルトはシステム設定に従う
- **コスト表示** — USD または KRW、為替レート設定可能
- **常に最前面ウィジェット** — 他のウィンドウの上に固定；ヘッダーボタン、トレイアイコン、グローバルホットキーで最小化
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
- **通貨** — USD または KRW
- **アラート** — 使用量しきい値の設定（50% / 80% / 90%）
- **テーマ** — Auto（システム設定に従う）/ Light / Dark
- **トレイラベル** — タスクバーに表示する情報を選択

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

## レート制限の仕組み

優先順位順に 2 つのデータソースを使用：

| 優先度 | ソース | 説明 |
|--------|--------|------|
| 第 1 | **Anthropic API** | `/api/oauth/usage` — ウェブダッシュボードと同じ権威あるデータ。3 分ごとに取得、429 時は指数バックオフ。 |
| 第 2 | **ブリッジ（stdin）** | `statusLine` 経由で Claude Code からのリアルタイムデータ。API 不可時のフォールバック。 |
| フォールバック | **最後の既知の値** | API 失敗時は最後の成功値を保持。リセット済みの古いデータは自動クリア。 |

ヘッダーのドットは API 接続状態を示します（緑 = 接続中、赤 = 到達不可）。ドットにマウスを合わせるとエラーメッセージを確認できます。

---

## 数値の計算基準

すべてのトークン数は **input + output + キャッシュ生成 + キャッシュ読み取り** を含みます。コストは常に API 換算推定値。

| 表示場所 | 範囲 | 含まれる内容 |
|---------|------|------------|
| ヘッダー (today) | 今日の深夜以降 | In/Out/Cache + 呼び出し数、セッション数、キャッシュ節約 |
| ヘッダー (all) | 全期間 | In/Out/Cache + 呼び出し数、セッション数、キャッシュ節約 |
| Plan Usage (5h / 1w) | 現在の請求ウィンドウ | すべてのトークン種別 |
| Model Usage | 全期間、モデル別 | すべてのトークン種別 |

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

セッション行の **Breakdown** ボタンをクリックすると、カテゴリ別 output トークン内訳が展開されます。同時に開けるのは 1 つのみ。

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

## 謝辞

macOS 版である [duckbar](https://github.com/rofeels/duckbar) にインスパイアされました。

---

## ライセンス

MIT
