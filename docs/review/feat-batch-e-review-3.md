# プランレビュー: typed-dreaming-key.md (Batch E)

日時: 2026-03-04T14:00:00+09:00
レビュー回数: 3回目

## 前回からの変更

2回目の指摘を受けて以下を追加:
- Group A: 重複登録ガード、select 要素 setter パターン、Popup→SW ルーティング明確化、autofill 実行前可視性検証
- Group B: Notification 件数ベース判定、shouldAutoCheck シグネチャ具体化、vault unlock useEffect 依存
- Group C: RLS 適用、Referrer-Policy + router.replace、targetUserId インデックス、APP_URL 必須
- Group D: ESM 設定、lock = process.exit、keytar、assertOrigin 互換性、import スロットリング
- 共通: チェックリスト必須/推奨区分、Batch F フォロー

## 機能観点の指摘

### A-4: 結合型 expiry フィールドへの書き込みフォーマット戦略が未定義
- **問題:** Step 3 で結合型 expiry の検出・分割は記載されているが、autofill 側 (Step 4) での書き込みフォーマット推測ロジックが未定義。
- **推奨:** form-detector が返す検出結果に分離型/結合型フラグを含め、autofill 側で placeholder/maxlength/pattern から推測してフォーマット変換。
- **判定: 採用** — Step 3 / Step 4 に追記。

### B-3: 件数ベース差分検出で breach 修正後に新規 breach を見逃す
- **問題:** ユーザーが漏洩パスワードを変更すると currentBreachCount が減少。新規 breach が発生しても lastNotifiedBreachCount 以下のままで通知されない。
- **推奨:** `lastKnownBreachCount` をチェック実行ごとに現在値で上書きする方式に変更。
- **判定: 採用** — Step 1 / Step 2 を修正。

### C-4: 2つの独立 rate limit の Redis キー設計が不明確
- **推奨:** `admin-reset:admin:{adminId}:{teamId}` (3/day) と `admin-reset:target:{targetUserId}` (1/day) の2つの独立 limiter。
- **判定: 採用** — Step 4 に追記。

### D-5: keytar のメンテナンス停滞による Node.js 互換性リスク
- **推奨:** `optionalDependencies` に配置し、import を try-catch でラップ。
- **判定: 採用** — Step 1 / Step 3 に追記。

### D-6: CLI の unlock 後の鍵保持メカニズム（プロセスモデル）が未定義
- **問題:** コマンドごとに独立プロセスか、長寿命プロセスかが不明確。
- **推奨:** 長寿命プロセス方式を明記。
- **判定: 採用** — Group D 前提セクションに「動作モデル」を追記。

## セキュリティ観点の指摘

### A-3(S): setSelectValue 最近傍フォールバックの誤入力リスク
- **推奨:** フォールバックを数値正規化後の完全一致に限定。不一致時は空のまま。
- **判定: 採用** — Step 4 を修正。

### C-2(S): リセットトークンの URL クエリパラメータ露出
- **推奨:** URL フラグメント方式 (`#token=xxx`) に変更。
- **判定: 採用** — Step 4 / Step 7 を修正。

### D-2(S): credentials フォールバックの TOCTOU 競合
- **推奨:** symlink 検証 + 排他的ファイル作成 (`'wx'` フラグ)。
- **判定: 採用** — Step 3 に追記。

### D-3(S): import 進捗ファイルの情報漏洩
- **推奨:** 記録内容をソースファイル SHA-256 + 処理済み行番号 + タイムスタンプに限定。
- **判定: 採用** — Step 5 の import コマンドに追記。

## テスト観点の指摘

### T-A3: autofill 実行側の可視性検証テストが未記載
- **推奨:** `display: none` / `visibility: hidden` の要素への書き込みスキップテスト。
- **判定: 採用** — Step 9 に追記。

### T-B3: use-watchtower.ts の自動 analyze トリガーに対するテスト戦略が不在
- **推奨:** hook ライフサイクルテスト (マウント時 analyze、encryptionKey 変化、cleanup)。
- **判定: 採用** — Step 8 に追記。

### T-C3: Execute API の confirmation 文字列のロケール考慮
- **推奨:** 英語固定方式を明記、テストで日本語文字列が 400 を返すこと。
- **判定: 採用** — Step 5 / Step 9 に追記。
