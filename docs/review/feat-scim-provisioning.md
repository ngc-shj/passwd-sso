# コードレビュー: feat/scim-provisioning

日時: 2026-02-25T18:00:00+09:00
レビュー回数: 1回目

## 前回からの変更

初回レビュー

## 機能観点の指摘

### F-1 [Critical] externalId フィルタの AND/OR 結合時にマーカー解決が発動しない

**問題**: `filter-parser.ts` の `filterToPrismaWhere()` が `externalId eq "xxx"` に対して `_externalIdFilter` マーカーを返すが、`Users/route.ts` GET ハンドラはトップレベルの `where._externalIdFilter` のみチェックする。AND/OR で結合された場合（例: `externalId eq "xxx" and active eq true`）、マーカーが `AND` 配列の中に埋まり、解決ロジックが発動しない。

**影響**: 複合フィルタで externalId を指定した場合、空の `user.is.id:{}` が Prisma に渡され予期しない結果になる。

**推奨対応**: AST から `externalId` 条件を事前に抽出し、ScimExternalMapping 解決後に userId を注入してから Prisma WHERE を構築する。

### F-2 [High] `User.email` が nullable だが non-null assertion で参照

**問題**: `prisma/schema.prisma` で `email String? @unique` だが、SCIM の serializer 呼び出し箇所 (4ファイル) で `m.user.email!` と non-null assertion を使用。

**影響**: Auth.js 経由で email なしユーザーが作成された場合、SCIM レスポンスの `userName` が null になり RFC 7643 違反。

**推奨対応**: serializer 呼び出し前に `email` が null のメンバーをフィルタする。

### F-3 [High] UUID v5 Namespace に DNS namespace を流用

**問題**: `serializers.ts` の `SCIM_GROUP_NAMESPACE` が RFC 4122 の DNS namespace そのもの。

**影響**: 他システムとの UUID 衝突リスク（理論上）。コメントに「randomly generated」は不正確。

**推奨対応**: アプリケーション固有の namespace UUID をランダム生成してハードコード。

### F-4 [High] フィルタパーサーの and/or 混在時に演算子優先順位が不正確

**問題**: `filter-parser.ts` の `parseExpression` で `and` と `or` が同じ優先順位で左結合的に処理。RFC 7644 Section 3.4.2.2 では `and` が高優先。

**影響**: `a or b and c` が `(a or b) and c` とパースされ、RFC 非準拠。

**推奨対応**: MVP として and/or 混在を拒否（FilterParseError）するか、再帰下降パーサーで修正。

### F-5 [High] PUT /Users/[id] で name.formatted の更新が反映されない

**問題**: PUT ハンドラは `active` と `externalId` のみ処理し、`name.formatted` を無視。

**影響**: IdP が PUT でユーザー表示名を更新しても反映されない。

**推奨対応**: `name.formatted` 変更時に `User.name` を更新するか、明示的に 501 で拒否。

### F-6 [Medium] proxy.ts に SCIM v2 ルート除外のコメントがない

**推奨対応**: `handleApiAuth` 関数に SCIM v2 ルートが意図的に除外されている旨のコメント追加。

### F-7 [Medium] DELETE /Users/[id] の監査ログ metadata に userId が email として記録

**問題**: `metadata: { email: member.userId }` — userId (CUID) が email フィールドに記録。

**推奨対応**: member 取得時に `user` を include して `member.user.email` を記録。

### F-8 [Medium] GET /Users のデフォルト WHERE で非アクティブユーザーが返らない

**問題**: フィルタなし GET で `deactivatedAt: null` がデフォルト適用。RFC 7644 では全リソース返却が期待される。

**推奨対応**: フィルタなしの場合は `deactivatedAt` 条件を外し、全メンバーを返す。

### F-9 [Medium] Groups PATCH/PUT で存在しないメンバーのサイレント skip

**問題**: `member` が null の場合 `continue` でスキップ。RFC では 400 推奨。

**推奨対応**: 存在しない userId に対して 400 エラーを返す。

### F-10 [Medium] getScimBaseUrl が x-forwarded-proto/host を無検証で信頼

**問題**: 4ファイルに重複定義。攻撃者がヘッダー偽装可能。

**推奨対応**: 環境変数 `NEXTAUTH_URL` からベース URL 取得。関数を共通モジュールに統一。

### F-11 [Medium] SCIM トークン数の上限がない

**推奨対応**: 組織あたりの有効トークン上限（10個）チェック追加。

### F-12 [Low] ScimTokenManager の Cancel ボタンがハードコード英語

**推奨対応**: i18n 対応 (`t("cancel")`)。

### F-13 [Low] ResourceTypes の endpoint が相対パス

**推奨対応**: 実際の IdP テスト時に問題があれば対応。現状は RFC 準拠。→ スキップ

### F-14 [Low] Schemas レスポンスに schemas 属性が欠落

**推奨対応**: 各スキーマに `schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"]` 追加。

## セキュリティ観点の指摘

### S-1 [Low] SHA-256 vs HMAC（情報提供） → スキップ（SHA-256 + 256-bit random は十分安全）

### S-2 [Medium] SCIM トークン数上限なし → F-11 と重複

### S-3 [Medium] getScimBaseUrl がヘッダー信頼 → F-10 と重複

### S-4 [Low] UUID v5 DNS namespace → F-3 と重複

### S-5 [Medium] SCIM 経由 User 作成によるテーブル汚染

**問題**: 侵害トークンで任意メールの User レコードを大量生成可能。他 org でのアカウントリンクリスク。

**推奨対応**: 1 org あたりの SCIM 作成メンバー数上限を設ける。

### S-6 [Medium] Groups PUT/PATCH が非トランザクション

**問題**: 複数メンバーのロール変更が個別 update で、途中エラー時に不整合。

**推奨対応**: `$transaction` でループ全体を囲む。

### S-7 [Low] PUT /Users で scimManaged フラグが設定されない

**推奨対応**: PUT でも `scimManaged: true` を設定。

### S-8 [Low] 監査 userId の system:scim フォールバック

**問題**: `system:scim` が実在しないユーザー ID。外部キー制約で書き込みエラーの可能性。

**推奨対応**: 監査ログの userId が外部キーか確認し、問題があればシステムユーザーをシードで作成。

### S-9 [Low] Users POST で OrgMember.create の P2002 未ハンドル

**推奨対応**: catch で P2002 (orgMembers unique) を 409 にマッピング。

### S-10 [Low] Filter parser and/or 優先順位 → F-4 と重複

## テスト観点の指摘

### T-1 [High] validations.ts にテストファイルが存在しない

**推奨対応**: `src/lib/scim/validations.test.ts` を追加。userName, active デフォルト, schemas URN, Operations 空配列等。

### T-2 [Medium] rate-limit.ts にテストファイルが存在しない

**推奨対応**: `src/lib/scim/rate-limit.test.ts` を追加。キー `rl:scim:${orgId}` の検証。

### T-3 [Medium] normalizes email テストのアサーションが弱い

**推奨対応**: `expect(mockTransaction).toHaveBeenCalledTimes(1)` と `expect(res.status).toBe(201)` 追加。

### T-4 [Medium] PUT active:true (再アクティベーション) テストが不足

**推奨対応**: deactivated ユーザーへの PUT active:true で `deactivatedAt: null` を検証。

### T-5 [Medium] PATCH externalId の挙動テストが不足

**推奨対応**: patch-parser.test.ts に externalId パスの操作テスト追加。

### T-6 [Low] 429 レート制限テストが不均一

**推奨対応**: Users/route.test.ts, Groups/[id]/route.test.ts に代表的な 429 テスト追加。

### T-7 [Low] expiresInDays 上限境界テスト不足

**推奨対応**: `expiresInDays: 3651` → 400, `expiresInDays: 0` → 400 テスト追加。

### T-8 [Low] $transaction モックのボイラープレート → スキップ（リファクタリング、バグではない）

### T-9 [Low] co/sw filter-to-prisma 変換テスト不足

**推奨対応**: `filterToPrismaWhere` に co, sw テスト追加。

### T-10 [Low] Groups PATCH で複数 Operations 同時処理テスト不足

**推奨対応**: Operations 配列に add + remove 複合テスト追加。

### T-11 [Low] scim-tokens/[tokenId] DELETE の 403 テスト不足

**推奨対応**: SCIM_MANAGE 権限なしの 403 テスト追加。

## 対応状況

（修正後に追記）
