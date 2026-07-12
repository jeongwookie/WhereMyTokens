# 日本語化(i18n)作業 引き継ぎメモ

対象: https://github.com/jeongwookie/WhereMyTokens のフォーク
(https://github.com/restructure-git/WhereMyTokens)、`D:\WhereMyTokens-ja`
ブランチ: `feature/i18n-ja`（チェックポイントコミット済み: `1d66b74`）

## ゴール

Electron + React + TypeScript製のWindowsトレイアプリ「WhereMyTokens」
（Claude Code / Codex の使用量・5時間レート制限を表示するダッシュボード）に、
`react-i18next` を使った日本語UIを追加する。英語UIはデフォルトのまま残し、
設定画面で言語切替できるようにする。

ライセンス上の制約は問題なし: ソースはMIT。EULAはコンパイル済みバイナリの
無断商用配布・改名なしの再配布のみ制限しており、個人利用のフォーク・翻訳は
明示的に歓迎されている（詳細は `EULA.txt` 第4条参照）。配布する場合は
"WhereMyTokens" の名称/アイコンをそのまま使って公式版と誤認させないこと。

## 現状（できていること）

- `npm install` 済み、`i18next` / `react-i18next` 追加済み
- `src/renderer/i18n/index.ts` で i18next 初期化、`localStorage`
  キー `wmt-language` で言語永続化する設計
- `src/renderer/index.tsx` で i18n初期化をレンダー前にimport
- 以下 **19/27ファイル** に `useTranslation()` / `t('key')` を導入済み:
  `App.tsx`, `components/ActivityBreakdown.tsx`, `ActivityChart.tsx`,
  `CodeOutputCard.tsx`, `ExtraUsageCard.tsx`, `ModelBreakdown.tsx`,
  `RenderErrorBoundary.tsx`, `SessionRow.tsx`, `TokenStatsCard.tsx`,
  `TrendBreakdownCard.tsx`, `TrendCard.tsx`, `index.html`, `index.tsx`,
  `limitDisplay.ts`, `views/CompactWidgetView.tsx`, `HelpView.tsx`,
  `MainView.tsx`, `NotificationsView.tsx`, `SettingsView.tsx`
- 残り8ファイル（`ThemeContext.tsx`, `breakdownViewModel.ts`,
  `mainSections.ts`, `quotaDisplayModels.ts`, `trendSelection.ts`,
  `theme.ts`, `types.ts`, `components/ViewHeader.tsx`）は確認済みで
  ユーザー向け文字列を含まないため対応不要

## 既知の破損（最優先で直すべき問題）

作業を並列サブエージェントに分担させた際、複数エージェントが同時に
`src/renderer/i18n/locales/en.json` / `ja.json` に書き込み、
お互いの内容を上書きし合うレース状態が発生した。

結果として:
- コード側は **461個** の異なる `t('...')` キーを参照している
- しかし `en.json` / `ja.json` には **25個** のキーしか残っていない
- 差分 **441個のキーが両ファイルから欠落**している

→ このままビルド・起動すると、大部分のUIに翻訳ではなく生のキー文字列
（例: `settingsView.languageLabel`）がそのまま表示される。

### 直し方

リポジトリ直下に監査スクリプトを置いてある:

```
node scratchpad-audit.js
```

- `src/renderer` 配下（`i18n`ディレクトリ除く）の全 `.ts`/`.tsx` を
  スキャンして実際に使われている `t('...')` キーを列挙
- `en.json` / `ja.json` それぞれで不足しているキーを算出
- 欠落キー一覧を `scratchpad-missing-keys.json` に出力
  （各キーがどのファイルで使われているかも記録済み）

**やるべきこと**: `scratchpad-missing-keys.json` を元に、`en.json` に
英語の原文（各コンポーネントのJSXを見て元の文言を復元）、`ja.json` に
自然な日本語訳（です/ます調、token/session/Codex/Claude/Sonnet/Opus等の
専門用語は英語のまま）を追加してキーを完全一致させる。ネストしたJSON
構造（`common.*`, `app.*`, `settingsView.*` 等）は既存の命名パターンに
揃える。

終わったら `node scratchpad-audit.js` を再実行し、
`MISSING from en.json: 0` / `MISSING from ja.json: 0` になることを確認。

## その後にやること

1. `SettingsView.tsx` の言語切替UI（自動/English/日本語）が実際に
   `i18n.changeLanguage()` を呼んでいるか、Electron起動時のデフォルト
   ロケール判定（`app.getLocale()`）が意図通りか目視確認
2. `npx tsc --noEmit -p tsconfig.json` でTypeScriptの型エラーがないか確認
3. `npm run build:renderer` でレンダラーバンドルが正常にビルドできるか確認
4. `npm start`（`npm run build && electron .`）で実機起動し、
   設定画面から日本語に切り替えて全画面（Main/Settings/Notifications/Help/
   CompactWidget）を目視で確認。翻訳漏れ・不自然な訳・レイアウト崩れが
   ないかチェック
5. 問題なければ `feature/i18n-ja` ブランチをコミット整理
   （WIPコミットを意味のある単位に分割/squashしてもよい）

## ビルド関連の注意

- `npm start` は `npm run build && electron .` で、`tsc` + カスタム
  `scripts/build-renderer.mjs` のみを使う。**.NET SDK不要**（動作確認だけならOK）
- `npm run dist`（配布用インストーラ生成）は `build:taskbar-helper` を
  経由し `dotnet publish` が必要（taskbar-helper/ はC#プロジェクト、
  今回のi18n作業では触っていない）。配布ビルドを作る場合のみ.NET SDKが必要
- 一時ファイル `scratchpad-audit.js` / `scratchpad-missing-keys.json` は
  作業用。最終的なPR/コミットに含めるかは任意（残しても実害はない）
