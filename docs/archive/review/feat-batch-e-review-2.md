# プランレビュー: typed-dreaming-key.md (Batch E)

日時: 2026-03-04T13:00:00+09:00
レビュー回数: 2回目

## 前回からの変更

1回目の指摘を受けて以下を追加:
- Group A: NO_PASSWORD ガードスキップ、inject ファイル切替、manifest 更新、CVV 消去、可視性検証、plain JS typeof ガード、LOGIN 非破壊テスト
- Group B: vaultUnlocked 事前条件、previousBreachIds サーバー管理、件数のみ送信(IDOR防止)、Redis rate limit
- Group C: セッション認証+token 二重チェック、actor/reason 引数、target 上限、リンク形式、TeamRole 明示
- Group D: OS キーチェーン、TTY 入力のみ、テストベクター、CLI 専用スコープ、統合テスト、CI 連携
- 共通: 新規エンドポイントチェックリスト

## 機能観点の指摘

### A-1: autofill-cc.js/autofill-identity.js の重複登録ガード
- **問題:** 既存 autofill.js は `__pssoAutofillHandler` でリスナー重複防止。新規 JS にも同等ガードが必要。
- **推奨:** Step 4 に各 .js 用ガードフラグ明記。
- **判定: 採用** — Step 4 に追記。

### A-2: Popup Fill → SW メッセージルーティング不明確
- **問題:** CC/Identity の Fill が AUTOFILL_FROM_CONTENT を使うか新メッセージ型を使うか未定。
- **推奨:** Step 5/7 にルーティング方針を明示。
- **判定: 採用** — 既存 AUTOFILL + entryType 分岐方式を採用。

### A-3: select 要素の setter パターン
- **問題:** HTMLSelectElement は HTMLInputElement と異なる native setter が必要。
- **推奨:** Step 4 に setSelectValue 実装方針を明記。
- **判定: 採用** — Step 4 に追記。

### B-1: previousBreachIds のサーバー復元方法が未確定
- **推奨:** 方式決定。
- **判定: 採用** — Notification レコードの件数ベース判定方式を採用。

### B-2: vault アンロック後の shouldAutoCheck 再評価タイミング
- **推奨:** useEffect 依存配列に encryptionKey を含める。
- **判定: 採用** — Step 2 に追記。

### C-1: AdminVaultReset の RLS 適用
- **推奨:** Step 4/5 に withTeamTenantRls を明記。
- **判定: 採用** — Step 4/5 に追記。

### C-2: Token URL のサーバーログ残留
- **推奨:** Referrer-Policy: no-referrer + router.replace で token 除去。
- **判定: 採用** — Step 7 に追記。

### C-3: AdminVaultReset の targetUserId インデックス
- **推奨:** @@index 追加。
- **判定: 採用** — Step 1 に追記。

### D-1: lock コマンド = process.exit
- **推奨:** プロセス終了で鍵除去が最も確実。
- **判定: 採用** — Step 5 修正。

### D-2: OS キーチェーンの依存パッケージ未記載
- **判定: 一部採用** — keytar 記載。フォールバック時は平文+警告表示で十分。

### D-3: clipboardy ESM + tsconfig module
- **推奨:** type: "module" + NodeNext を設定。
- **判定: 採用** — Step 1 に追記。

### D-4: import バッチ原子性
- **推奨:** --resume オプション or バッチ API。
- **判定: 採用** — 100ms スロットリング + 進捗ファイル記録方式。

### X-1: assertOrigin vs CLI (Origin ヘッダーなし)
- **問題:** CLI の fetch は Origin を送らない → assertOrigin で 403 になる。
- **推奨:** Bearer token 認証時は Origin チェックをスキップする分岐。
- **判定: 採用** — Group D Step 3 + 共通チェックリストに追記。

## セキュリティ観点の指摘

### A-1(S): CVV — NO_PASSWORD ブロック問題
- **判定: プラン既載** — Step 5 で NO_PASSWORD スキップ済み。追加対応不要。

### A-2(S): XSS — autofill-lib.ts の可視性ガード未適用
- **問題:** form-detector には可視性チェックがあるが autofill 実行側にはない。
- **判定: 採用** — Step 4 の autofill-cc-lib.ts / autofill-identity-lib.ts に可視性検証を追記。

### B-1(S): lastAnalyzedAt の localStorage 改ざん DoS
- **判定: スコープ外** — 既存挙動。/api/watchtower/start の Redis cooldown が真のソース。Batch E で変更不要。

### B-3(S): hibp/route.ts の独自 rate limit
- **判定: スコープ外** — 既存コードの最適化。Batch E スコープ外。

### C-1(S): APP_URL 必須要件
- **判定: 採用** — Step 5 に APP_URL 未設定時エラーを追記。

### C-3(S): TeamRole vs TenantRole
- **判定: プラン既載** — TeamRole 使用と明記済み。コードベースに TenantRole は存在しない。

### D-1(S): 既存 extension/token の assertOrigin 未適用
- **判定: 採用** — Step 3 に確認・対応を追記。

### D-4(S): Windows SIGINT/exit ハンドリング
- **判定: 採用** — Step 7 に SIGINT/exit イベント追加。

### X-1(S): チェックリスト適用基準の曖昧さ
- **判定: 採用** — チェックリストに必須/推奨の区分追加。

## テスト観点の指摘

### T-A1: EXT_ENTRY_TYPE 定数依存
- **判定: 暗黙的** — Step 順序で自明だが、テスト前提の一文追加。

### T-A2: navigator.language scope
- **判定: 採用** — 「新規ファイルのみ適用」と明確化。

### T-B1: previousBreachIds 保持場所
- **判定: 採用** — B-1 と同時に解決。Notification 件数方式。

### T-B2: shouldAutoCheck シグネチャ
- **判定: 採用** — 具体シグネチャを Step 1 に追記。

### T-C1: limiter mock パターン
- **判定: 採用** — vi.mock パターンを Step 9 に追記。

### T-C2: txArray 長アサーション
- **判定: 採用** — Step 2 に確認事項として追記。

### T-D1: test:cli スクリプト
- **判定: 採用** — root package.json に追加と明記。

### T-D2: fixtures 形式
- **判定: 採用** — JSON 形式 + 保存場所を明記。

### T-X1: extension vitest.config.ts フォロー
- **判定: 採用** — Batch F フォロー宣言を追記。
