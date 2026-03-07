# プランレビュー: typed-dreaming-key.md (Batch E)

日時: 2026-03-04T12:00:00+09:00
レビュー回数: 1回目

## 前回からの変更

初回レビュー

## 機能観点の指摘

### A-1: `performAutofillForEntry` の `NO_PASSWORD` ガードが CC/Identity を拒否する
- **問題:** background/index.ts の `performAutofillForEntry` は `if (!password && !totpCode)` で早期リターン。CC/Identity には password がない。
- **影響:** CC/Identity autofill が常に `NO_PASSWORD` エラーで失敗。機能ブロッカー。
- **推奨:** entryType で分岐し、CC/Identity パスでは NO_PASSWORD ガードをスキップ。

### A-2: CRXJS content script の `executeScript` inject ファイル切り替えが未記載
- **問題:** 既存 index.ts は `files: ["src/content/autofill.js"]` をハードコード。CC/Identity 用 JS パスの動的切り替えと manifest `web_accessible_resources` 追加が必要。
- **影響:** CC/Identity autofill 時に誤った JS が inject される。
- **推奨:** entryType 分岐で inject ファイルパスを切り替え、manifest にも追加。

### A-3: Direct fallback (`injectDirectAutofill`) が CC/Identity に非対応
- **問題:** inline fallback は username/password/AWS 専用。CC/Identity のフォールバックが未設計。
- **影響:** MV3 Service Worker 再起動後等で CC/Identity autofill が無効。
- **推奨:** CC/Identity 用 direct fallback を別途定義するか、LOGIN 専用と割り切り明示。

### A-4: Suggestion Dropdown の entryType フィルタポリシーが未決定
- **問題:** CC/Identity をフォーカスベースのドロップダウンで自動表示するかのポリシーが未定義。
- **影響:** 全サイトで CC が表示される or 全サイトで非表示になる。
- **推奨:** Popup Fill ボタン経由のみに限定し、フォーカスベースでは表示しない設計を検討。

### B-1: マルチデバイスでの重複 auto-check
- **問題:** localStorage は端末ごと。複数端末で同時に 24h 経過判定し重複 API 呼び出し。
- **影響:** Rate limit で片方弾かれるが、設計次第で重複通知。
- **推奨:** Rate limit を userId ベースで Redis に持ち、サーバー側排他制御。

### B-2: breach 差分検出のデータ保持方式が未定義
- **問題:** previousBreachIds の保持場所・形式が曖昧。
- **推奨:** エントリ ID レベルで差分を取る方式を明示。

### B-3: vault ロック時の auto-check 動作が未定義
- **問題:** vault 未ロック状態では HIBP チェック不可。
- **推奨:** shouldAutoCheck の事前条件に vault unlock を明示。

### B-4: `WATCHTOWER_ALERT` は既存スキーマに存在する可能性
- **問題:** NotificationType に既に定義済みならスキーマ変更不要。
- **推奨:** 既存定義を確認し、Step 6 を修正。

### C-1: executeVaultReset 共通化でのフィールド乖離リスク
- **問題:** リファクタリング漏れで self-reset と admin-reset の対象フィールドが乖離。
- **推奨:** 完全移植を確認するテストを書く。

### C-2: AuditAction enum 追加は Prisma マイグレーション必須
- **問題:** 新規 enum 値 vs 既存値 + metadata での区別、どちらを採用するか未決定。
- **推奨:** 明示的に決定しプランに記載。

### C-3: Execute API の認証設計の漏れ
- **問題:** token 単独で vault 削除可能な設計は危険。
- **推奨:** セッション認証必須 + token 検証の二重チェック。

### C-4: Team vault の分離が不明確
- **問題:** admin reset で TeamMemberKey も削除するかが未記載。
- **推奨:** 既存 vault/reset と同じ対象を明示。

### D-1: Extension token の CLI 向けスコープ設計不足
- **問題:** CLI に必要なスコープが既存に存在するか未確認。
- **推奨:** 必要スコープを洗い出し、CLI 専用スコープ追加を検討。

### D-2: Node.js crypto.subtle の互換性確認
- **問題:** ブラウザとの微差が存在。PBKDF2 600k iterations はテスト環境で遅い。
- **推奨:** 動作確認テストを Step 2 と同時に追加。

### D-3: Clipboard auto-clear の実装詳細
- **問題:** clipboardy (ESM) の依存と auto-clear タイマー管理が未設計。
- **推奨:** パッケージ選定と実装方法を明示。

### D-4: export/import フォーマット互換性
- **問題:** Web UI の export-crypto.ts と異なるフォーマットで出力するリスク。
- **推奨:** 既存フォーマット準拠を明記し、round-trip テストを含める。

## セキュリティ観点の指摘

### A-1(S): CVV のメモリ残留リスク
- **問題:** Service Worker が Payload 内の CVV をオートフィル完了後もメモリに保持。
- **推奨:** オートフィル完了直後に Payload プロパティを上書き消去。

### A-2(S): Content Script の XSS 経由フォーム操作リスク
- **問題:** 悪意あるページが偽 autocomplete 属性を持つ hidden input を配置し、機密データが書き込まれる。
- **推奨:** autofill 前に対象要素の可視性 (offsetParent, getBoundingClientRect) を検証。

### A-3(S): CRXJS plain JS 制約違反のリスク
- **問題:** autofill-cc.js が plain JS 制約を守らない場合 Chrome で SyntaxError。
- **推奨:** -lib.ts と .js の分離徹底、.js 内でランタイム型検証、CI で読み込みテスト。

### B-1(S): localStorage へのブリーチ状態保存
- **問題:** previousBreachIds (breach済みエントリID一覧) が XSS で漏洩。
- **推奨:** previousBreachIds はサーバー DB に保存し、localStorage には格納しない。

### B-2(S): Alert API のリクエストボディ (breachedEntryIds) が IDOR 脆弱性
- **問題:** クライアントが他ユーザーのエントリ ID を偽装して通知生成可能。
- **推奨:** クライアント送信の ID を DB で所有者検証、または通知件数のみ送信しサーバーで計算。

### B-3(S): HIBP プロキシの in-memory rate limit がマルチインスタンスで無効
- **問題:** Redis 障害時に各インスタンスが独立カウンター → HIBP への過剰リクエスト。
- **推奨:** lastBreachCheckAt をサーバー DB に保存し、サーバー側で 24h チェック制御。

### C-1(S): Execute API のトークン配送経路
- **問題:** トークンをメール本文に直接記載するとメール経路での盗聴リスク。
- **推奨:** リセット承認リンク形式で送付、HTTPS 専用、assertOrigin 適用。

### C-2(S): Rate limit の粒度 — ターゲット単位の制限なし
- **問題:** 同一ターゲットに対して複数チーム経由で token 発行可能。
- **推奨:** target userId 単位の発行上限も設ける。

### C-3(S): ロール階層チェックの明示
- **問題:** ADMIN 同士の reset 可否が不明瞭。
- **推奨:** ビジネスルールをコードコメントに明記。

### C-4(S): executeVaultReset 共有関数の confused deputy 問題
- **問題:** 将来の開発者が権限チェックなしで呼び出すリスク。
- **推奨:** actor/reason を引数必須にし、内部で audit log を記録。

### D-1(S): Extension トークン発行の CSRF リスク
- **問題:** CLI 用トークン発行 API に assertOrigin チェックが未適用の場合。
- **推奨:** CLI 専用スコープ定義 + assertOrigin 追加 + Audit log に purpose 記録。

### D-2(S): config.json のシークレット保存
- **問題:** Bearer token を config.json に保存するとバックアップ等で漏洩。
- **推奨:** OS キーチェーン保存を推奨、config.json は非機密のみ。

### D-3(S): パスフレーズのプロセス間可視性
- **問題:** process.argv / 環境変数経由だと ps aux で漏洩。
- **推奨:** TTY 対話入力のみ、--passphrase フラグは実装しない。

### D-4(S): Clipboard auto-clear の競合
- **問題:** SIGTERM や連続コピーでクリアが機能しない。
- **推奨:** コピー内容のハッシュ比較 + SIGTERM ハンドラ + タイマーシングルトン管理。

### D-5(S): CryptoKey のプロセスメモリ保護
- **問題:** GC 制御不可、コアダンプに鍵が含まれる。
- **推奨:** lock 時 null 化 + セッション最大存続時間 + コアダンプ無効化検討。

### X-1(S): 新規エンドポイントへのセキュリティ制御適用漏れ
- **問題:** assertOrigin, withRequestLog, logAudit, Rate limiter, Zod validation の適用漏れリスク。
- **推奨:** 破壊的 API チェックリストを PR テンプレートに明記。

## テスト観点の指摘

### A-1(T): background.test.ts の GET_MATCHES_FOR_URL テストに CC/Identity entry 混在ケースが未定義
- **推奨:** entryType: "CREDIT_CARD" / "IDENTITY" の entry を混在させたテストケース追加。

### A-2(T): navigator.language オーバーライドの漏れ
- **推奨:** cc-form-detector.test.ts / identity-form-detector.test.ts に locale 固定処理を追加。

### A-3(T): LOGIN autofill の非破壊確認テスト
- **推奨:** CC フィールドと認証フィールドが混在する DOM で performAutofill(LOGIN) を呼び、cc 入力欄が空であることを検証。

### B-1(T): shouldAutoCheck / detectNewBreaches の pure function 前提崩壊リスク
- **推奨:** now を引数に取るシグネチャ、detectNewBreaches の状態保持場所を先に決定。

### B-2(T): watchtower/alert/route.test.ts の mock 構成 (email mock) 未記載
- **推奨:** vi.mock("@/lib/email") を vi.hoisted() パターンで追加。

### B-3(T): OFF 時の停止テストケース未定義
- **推奨:** enabled: false → false, enabled: true + 25h → true, enabled: true + 1h → false。

### C-1(T): RBAC レイヤー (TenantRole vs TeamRole) の特定不明確
- **推奨:** Admin Vault Reset が参照するロール体系を明記。

### C-2(T): vault-reset.ts 共有関数のリファクタリング有無
- **推奨:** 既存 route.ts をこの shared function を呼ぶ形にリファクタリングすることを明記。

### C-3(T): rate limit テストのクリーンアップ
- **推奨:** beforeEach で limiter 再初期化。

### C-4(T): 期限切れトークンテストに vi.useFakeTimers() が必要
- **推奨:** vi.useFakeTimers() + vi.advanceTimersByTimeAsync() + afterEach vi.useRealTimers()。

### D-1(T): crypto.test.ts の「同一出力検証」方法論未定義
- **推奨:** 固定テストベクター (salt/iv/passphrase) → fixtures → CLI 復号検証。

### D-2(T): CLI テストが CI (npm test) から外れる
- **推奨:** ルート package.json に test:all スクリプト追加、または Vitest workspace 設定。

### D-3(T): コマンド間の状態受け渡し統合テスト未定義
- **推奨:** cli/src/__tests__/integration/ に login→unlock→list→get のシナリオテスト。

### X-1(T): extension/vitest.config.ts に setupFiles / coverage 未設定
- **推奨:** 共通 setup (vi.clearAllMocks) と coverage include を追加。

### X-2(T): Email テンプレートテストの既存パターン参照
- **推奨:** emergency-access.test.ts の ja/en 両方検証パターンを踏襲と明記。
