# コードレビュー: fix/team-rls-cross-tenant
日時: 2026-03-01T03:15:00+09:00
レビュー回数: 1回目

## 前回からの変更
初回レビュー

## 機能観点の指摘

### F-1: getTeamParent に userId が渡されている（バグ）
- **ファイル**: `src/app/api/teams/[teamId]/folders/route.ts:18-19`, `src/app/api/teams/[teamId]/folders/[id]/route.ts:19-20`
- **問題**: `getTeamParent(userId, folderId)` のシグネチャで第1引数が `userId` だが、`withTeamTenantRls(userId, ...)` に渡されている。`withTeamTenantRls` は `teamId` を期待する。
- **影響**: userId をチームIDとして解決しようとし、テナントが見つからずエラーになる。フォルダ操作（作成・更新・削除）が壊れる。
- **推奨修正**: シグネチャを `(teamId, folderId)` に変更し、呼び出し元で `teamId` を渡す。

### F-2: GET /api/teams の不要なエラーハンドリング
- **ファイル**: `src/app/api/teams/route.ts:51-60`
- **問題**: `withBypassRls` に変更後、`TENANT_NOT_RESOLVED` / `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` は投げられない。catch ブロックが dead code。
- **影響**: 動作には問題なし。コードの可読性低下のみ。
- **推奨修正**: catch ブロックを削除し、try-catch を除去。

### F-3: 変更漏れなし
- `[teamId]` 配下の全25ルートハンドラーで `withTeamTenantRls(teamId, ...)` に統一されている。
- クロスチームルート4本は全て `withBypassRls(prisma, ...)` に変更済み。
- `teams/route.ts` は GET=bypass, POST=userRLS で正しく使い分けている。

## セキュリティ観点の指摘

### S-1: withBypassRls の使用箇所は安全
- クロスチームルート（archived, trash, favorites, pending-key-distributions）は全て:
  - 認証チェック（`session?.user?.id`）後に実行
  - `userId: session.user.id` でフィルタし、自分のメンバーシップのみ取得
  - 派生 `teamIds` で2次クエリをフィルタ
- **評価**: テナント間データ漏洩のリスクなし。

### S-2: invitation accept の RLS コンテキスト切り替え
- `withBypassRls`: invitation token lookup（トークンはクロステナント認証情報）→ 安全
- `withTeamTenantRls(invitation.teamId)`: チームデータ操作 → 安全
- `withUserTenantRls(session.user.id)`: ユーザー自身のECDHキー確認 → 安全
- **評価**: 各操作に最小権限のRLSコンテキストが適用されている。

### S-3: IDOR リスク
- `[teamId]` ルートは `requireTeamPermission` / `requireTeamMember`（`team-auth.ts` 内で `withTeamTenantRls` 使用）でRBAC認可後にデータアクセス。
- クエリに `teamId` フィルタが含まれ、他チームのデータにはアクセス不可。
- **評価**: IDOR リスクなし。

### S-4: 指摘なし
セキュリティ上の重大な問題は見当たらない。

## テスト観点の指摘

### T-1: テストモックの一貫性
- `[teamId]` 配下の22テストファイル: `mockWithTeamTenantRls` + `_teamId: string` に統一 → OK
- クロスチーム4テストファイル: `mockWithBypassRls` + `_prisma: unknown` に統一 → OK
- `teams/route.test.ts`: GET=`mockWithBypassRls`, POST=`mockWithUserTenantRls` → OK
- `invitations/accept/route.test.ts`: 3種類のモック → OK
- **評価**: 一貫性あり。

### T-2: RLSコンテキスト呼び出しの検証不足
- **問題**: テストは `withTeamTenantRls` / `withBypassRls` を passthrough モックしているが、正しい引数（teamId / prisma）で呼ばれたことを検証していない。
- **影響**: F-1のようなバグ（userIdをteamIdとして渡す）をテストで検出できない。
- **推奨修正**: 重要なテストケースに `expect(mockWithTeamTenantRls).toHaveBeenCalledWith("team-1", expect.any(Function))` のようなアサーションを追加。

## 対応状況

### F-1: getTeamParent に userId が渡されている
- 対応: シグネチャを `(teamId, folderId)` に変更、呼び出し元で `teamId` を渡すよう修正
- 修正ファイル: `src/app/api/teams/[teamId]/folders/route.ts:18-19,114,128`, `src/app/api/teams/[teamId]/folders/[id]/route.ts:19-20,83,102,116`
