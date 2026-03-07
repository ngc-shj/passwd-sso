# コードレビュー: feat/split-i18n-namespaces

日時: 2026-02-22
総ループ回数: 2回

## ループ 1: 初回レビュー

### 機能観点の指摘

| ID | 深刻度 | 概要 | 対応 |
|----|--------|------|------|
| R1 | 低 | `s/layout.tsx` で `NS_PUBLIC_SHARE` 定数が使われていない（ハードコードリスト） | 採用: `NS_PUBLIC_SHARE` を使用するよう修正 |
| R2 | 情報 | `loadAllMessages` の37回 dynamic import（パフォーマンス懸念） | 不採用: サーバーコンポーネントで全名前空間が必要。Phase 3 検討事項 |

### セキュリティ観点の指摘

| ID | 深刻度 | 概要 | 対応 |
|----|--------|------|------|
| S1 | 低 | `loadNamespaces` のエラーメッセージに入力値が含まれる | 不採用: 引数は全てハードコード定数のみ。外部入力が渡される経路なし |

### テスト観点の指摘

| ID | 深刻度 | 概要 | 対応 |
|----|--------|------|------|
| T1 | 高 | `loadAllMessages` / `loadNamespaces` のユニットテストなし | 採用: `src/i18n/messages.test.ts` 新規作成 |
| T2 | 中 | `namespace-groups.test.ts` に重複チェックなし | 採用: 全グループの重複チェック追加 |
| T3 | 中 | `NS_RECOVERY` / `NS_VAULT_RESET` の NAMESPACES 所属チェックなし | 採用: 全グループの所属チェック追加 |
| T4 | 中 | `s/layout.tsx` のハードコードリストと `NS_PUBLIC_SHARE` の乖離リスク | R1 で対応 |
| T5 | 低 | `pick-messages.test.ts` に浅いコピー参照テストなし | 不採用: 自明な動作。過剰テスト |
| T6 | 低 | `messages-consistency.test.ts` の差分が名前空間単位で特定困難 | 採用: 名前空間ごとのキー比較に改善 |
| T7 | 中 | レイアウト統合テストなし | 不採用: ソース静的解析は脆い。ビルド＋手動確認で十分 |
| T8 | 低 | `NS_GLOBAL` / `NS_VAULT` 単体の NAMESPACES 所属チェックなし | T3 に統合: 全グループチェック |
| T9 | 低 | `readNamespace` テストヘルパーのエラーメッセージ改善 | 不採用: スタックトレースで十分特定可能 |

## 対応状況

### R1 `s/layout.tsx` で `NS_PUBLIC_SHARE` 定数を使用
- 対応: インライン配列 `["Common", "Share", "CopyButton"]` を `NS_PUBLIC_SHARE` に置換
- 修正ファイル: `src/app/s/layout.tsx:6,16`

### T1 `loadAllMessages` / `loadNamespaces` ユニットテスト追加
- 対応: 5テストケース新規作成（全キー返却、無効ロケールフォールバック、指定NS読み込み、無効NS例外、空配列）
- 修正ファイル: `src/i18n/messages.test.ts` (新規)

### T2+T3+T8 全グループの重複・所属チェック追加
- 対応: 7テストケース追加（NS_GLOBAL/NS_VAULT/NS_RECOVERY/NS_VAULT_RESET の NAMESPACES 所属 + NS_DASHBOARD_ALL/NS_RECOVERY/NS_VAULT_RESET の重複チェック）
- 修正ファイル: `src/i18n/namespace-groups.test.ts`

### T6 名前空間単位のキー比較に改善

- 対応: `keeps key sets aligned between locales` → `keeps key sets aligned between locales per namespace` に変更、差分時に名前空間名を表示
- 修正ファイル: `src/i18n/messages-consistency.test.ts`

---

## ループ 2: 再レビュー

### 機能観点: 指摘なし

前回 R1 適切に修正済み。R2 の不採用判断も妥当。新規指摘なし。

### セキュリティ観点: 指摘なし

S1 の不採用判断は妥当。R1 修正により公開ルートのセキュリティが改善（全翻訳 → 3NS に限定）。新規指摘なし。

### テスト観点: 指摘なし

前回 T1-T9 全て適切に対応/判断済み。不採用判断（T5, T7, T9）も妥当。新規指摘なし。

---

## レビュー完了

最終状態: 機能 0件 / セキュリティ 0件 / テスト 0件
レビューファイル: docs/temp/feat-split-i18n-namespaces.md
