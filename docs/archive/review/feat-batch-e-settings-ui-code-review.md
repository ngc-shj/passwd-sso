# コードレビュー: typed-dreaming-key

日時: 2026-03-04T20:45:00+09:00
レビュー回数: 2回目（全指摘解消）

## 前回からの変更

Round 2: F1, F2, T2, T3, T4, T5 の6件を修正。全3エージェントから「指摘なし」。

## 機能観点の指摘 (6件)

### F1 (Medium): filterMembers の重複呼び出し — settings/page.tsx
`filterMembers(members, memberSearch)` が同一レンダリング内で4回呼び出されている。変数にキャッシュすべき。
→ **対応する** (妥当)

### F2 (Medium): Transfer Ownership セクションの表示/非表示が検索に連動
検索結果が0件の場合、Transfer Ownership カード自体が消える。セクションの存在判定は検索に依存させず、内部リストのみフィルタすべき。
→ **対応する** (妥当)

### F3 (Low): secretCopied の i18n キー名が実態と乖離
→ **スキップ** — キー名の変更は既存の TeamWebhook.json のキー体系に影響し、表示テキスト自体は正確。リファクタは別PRで対応。

### F4 (Low): URL 入力のクライアントサイドバリデーション不足
→ **スキップ** — サーバー側で HTTPS 必須・SSRF 防御済み。クライアント側はUXヒントのみで十分。

### F5 (Low): 非Admin時の general タブ表示
→ **スキップ** — 既存コードの問題で本PRのスコープ外。

### F6 (Low): groupLabel map にないグループキーのフォールバック
→ **スキップ** — 現時点で AUDIT_ACTION_GROUPS_TEAM に存在しないグループ。将来の追加時に対応。

## セキュリティ観点の指摘 (2件)

### S1 (中): SSRF — DNS Rebinding
→ **スキップ** — 現在の防御（HTTPS必須、IPリテラルブロック、localhost/.local/.internal ブロック、redirect:error）は十分。DNS Rebinding はネットワークレベル対策。

### S2 (低): Webhook Secret のクライアント側メモリ残存
→ **スキップ** — 業界標準（GitHub/Stripe等）と同等の実装。

## テスト観点の指摘 (6件)

### T1 (低): テストの重複 (charlie 検索が2箇所)
→ **スキップ** — 意図は異なる（email検索 vs null name処理）。動作に問題なし。

### T2 (低): null email メンバーの name 検索テスト不足
→ **対応する** — Diana の name 検索テスト追加

### T3 (中): if ガードによる false positive リスク
→ **対応する** — if ガードを expect + 直接呼出しに置換

### T4 (中): DELETE 失敗時の toast テスト欠落
→ **対応する** — テストケース追加

### T5 (低): fetch 例外時のテスト欠落
→ **対応する** — ネットワークエラーテスト追加

### T6 (情報): GET レスポンス secret 除外テストの構造的限界
→ **スキップ** — ユニットテストの構造的限界として認識。コメント追加のみ。

## 対応状況

### F1: filterMembers の重複呼び出し
- 対応: `const filteredMembers = filterMembers(members, memberSearch)` を変数として定義し、4箇所の直接呼出しを `filteredMembers` に置換
- 修正ファイル: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx:104`

### F2: Transfer Ownership セクションの表示条件
- 対応: セクションの存在判定を `members.filter(...)` に戻し（検索非依存）、内部リストのみ `filteredMembers` でフィルタ
- 修正ファイル: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx:510`

### T2: null email メンバーの name 検索テスト
- 対応: `"handles members with null email (searches by name)"` テスト追加
- 修正ファイル: `src/lib/filter-members.test.ts:57-60`

### T3: if ガードの false positive リスク
- 対応: `if (checkboxes.length > 0)` と `if (createButtons.length > 0)` を `expect(...).toBeGreaterThan(0)` + 直接呼出しに置換（2テスト分）
- 修正ファイル: `src/components/team/team-webhook-card.test.tsx:303-316,388-398`

### T4: DELETE 失敗時の toast テスト
- 対応: `"shows toast error on delete failure"` テスト追加
- 修正ファイル: `src/components/team/team-webhook-card.test.tsx:451-478`

### T5: fetch 例外時のテスト
- 対応: `"handles fetch exception on initial load gracefully"` テスト追加
- 修正ファイル: `src/components/team/team-webhook-card.test.tsx:480-491`
