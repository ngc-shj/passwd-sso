# セキュリティレビュー: fix/team-rls-cross-tenant

日時: 2026-03-01
レビュー回数: 1回目（初回）

## レビュー対象の変更概要

1. チームAPIルートのRLSコンテキスト修正: `withUserTenantRls(session.user.id, ...)` → `withTeamTenantRls(teamId, ...)` / `withBypassRls(prisma, ...)`
2. クロステナント識別機能の追加（API・UI）
3. UIの改善（監査ログへのメール表示、パスワードカードのcreatedBy表示、サイドバー状態管理）

## セキュリティ観点の指摘

### S-1: `GET /api/teams` で `userTenantId` が `null` の場合、全チームが `isCrossTenant: true` になる

- **ファイル**: `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/route.ts` 行 20, 54
- **重要度**: 中
- **問題**: `resolveUserTenantIdFromClient` はテナント未所属ユーザーに対して `null` を返す。行 54 の `userTenantId !== m.team.tenant.id` の比較で、`null !== "tenant-uuid"` は常に `true` となるため、全チームが `isCrossTenant: true` としてクライアントに返される。また、テナント未所属ユーザーがチームメンバーとして存在するケース（招待経由で参加後にテナントから除外された場合など）では、実際にはクロステナントではないにもかかわらず外部テナントとして誤表示される。加えて、`resolveUserTenantIdFromClient` は複数テナント所属時に `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` を throw するが、この例外は `withBypassRls` の内部で発生するためキャッチされず、500エラーになる。
- **影響**: UI上の誤表示。セキュリティ上のデータ漏洩は発生しないが、ユーザーに不正確な情報を表示する。500エラーのケースでは一覧取得が失敗する。
- **推奨修正**:
  ```typescript
  // resolveUserTenantIdFromClient の結果が null の場合の処理を追加
  // また MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED を try-catch で処理
  let userTenantId: string | null;
  try {
    const result = await withBypassRls(prisma, async () => {
      const uid = await resolveUserTenantIdFromClient(prisma, session.user.id);
      // ... memberships query ...
      return { userTenantId: uid, memberships: data };
    });
    userTenantId = result.userTenantId;
    memberships = result.memberships;
  } catch (e) {
    if (e instanceof Error && e.message === "MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED") {
      return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
    }
    throw e;
  }
  // isCrossTenant の計算で null を考慮
  isCrossTenant: userTenantId != null && userTenantId !== m.team.tenant.id,
  ```

### S-2: 監査ログAPIとパスワード一覧APIでユーザーのメールアドレスが新たに公開される

- **ファイル**:
  - `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/[teamId]/audit-logs/route.ts` 行 83
  - `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/[teamId]/passwords/route.ts` 行 62-63
  - `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/[teamId]/passwords/[id]/route.ts` 行 72-76
- **重要度**: 低
- **問題**: 変更前は `user: { select: { id, name, image } }` だったが、変更後は `email: true` が追加されている。これにより、チームメンバー全員（VIEWERロールを含む）がcreatedBy/updatedByユーザーのメールアドレスを取得できる。監査ログは `TEAM_UPDATE` 権限（ADMIN/OWNER）を要求するため影響は限定的だが、パスワード一覧は `PASSWORD_READ`（VIEWER）で取得可能。
- **影響**: クロステナントメンバーのメールアドレスが同じチームの全メンバーに公開される。意図的な設計変更であれば問題ないが、メールアドレスは個人情報（PII）であるため、公開範囲の拡大には注意が必要。
- **推奨修正**: これが意図的な変更であることを確認する。もし必要最小限にする場合は、監査ログページのUI側でクロステナントユーザーにのみメールを表示するか、APIレスポンスでメール表示を制御する。現状のコードは条件なしで全ユーザーのメールを返す。

### S-3: `withBypassRls` でのテナント名取得（`GET /api/teams/[teamId]/members`）は安全

- **ファイル**: `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/[teamId]/members/route.ts` 行 44-50
- **重要度**: 情報
- **問題なし**: `withBypassRls` を使用して `tenantMember` テーブルからメンバーのテナント名を取得している。これは以下の理由で安全:
  1. `requireTeamMember` による認証・認可チェック後に実行される
  2. `userIds` は同じリクエスト内で `withTeamTenantRls` によりフィルタされた `members` から派生
  3. 取得するのはテナント名（`name`）のみで、テナントID等の内部情報は含まない
  4. UIでは `m.tenantName !== team.tenantName` の場合のみ表示される
- **評価**: テナント間データ漏洩のリスクなし。

### S-4: クロステナントルート（archived, trash, favorites, pending-key-distributions）の `withBypassRls` 使用は安全

- **ファイル**:
  - `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/archived/route.ts`
  - `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/trash/route.ts`
  - `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/favorites/route.ts`
  - `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/pending-key-distributions/route.ts`
- **重要度**: 情報
- **問題なし**: 全ルートで以下のパターンが守られている:
  1. 認証チェック（`session?.user?.id`）後に実行
  2. 第1クエリ: `userId: session.user.id` で自分のメンバーシップのみ取得
  3. 第2クエリ: 派生 `teamIds` でフィルタし、自分が所属するチームのデータのみ取得
  4. RBACチェック（`hasTeamPermission`）で権限を検証
- **評価**: 他ユーザーのデータにアクセスする経路はない。IDOR リスクなし。

### S-5: 招待承諾（`POST /api/teams/invitations/accept`）のRLSコンテキスト切り替えは安全

- **ファイル**: `/Users/noguchi/ghq/github.com/ngc-shj/passwd-sso/src/app/api/teams/invitations/accept/route.ts`
- **重要度**: 情報
- **問題なし**: 3つのRLSコンテキストが適切に使い分けられている:
  1. `withBypassRls`: 招待トークンのルックアップ（招待受理者はまだチームのテナントに属していないため正当）
  2. `withTeamTenantRls(invitation.teamId)`: チームメンバーシップの確認・作成（チームデータへの操作）
  3. `withUserTenantRls(session.user.id)`: ユーザー自身のECDH公開鍵の確認（ユーザーデータへの操作）
- **評価**: 各操作に最小権限のRLSコンテキストが適用されている。

### S-6: `[teamId]` 配下の全ルートで `withTeamTenantRls(teamId, ...)` への統一は正しい

- **ファイル**: `src/app/api/teams/[teamId]/**/*.ts`（全25ルートハンドラー）
- **重要度**: 情報
- **問題なし**: 変更前の `withUserTenantRls(session.user.id, ...)` はユーザーのテナントIDでRLSコンテキストを設定していたため、クロステナントメンバー（ユーザーのテナント != チームのテナント）がチームデータにアクセスできなかった。`withTeamTenantRls(teamId, ...)` に変更することで、チームのテナントIDでRLSが設定され、正当なクロステナントメンバーもデータにアクセスできるようになった。
- **認可チェック**: 全ルートで `requireTeamMember` / `requireTeamPermission` による認可チェックが `withTeamTenantRls` 内部で実行される（`team-auth.ts` 行 94-97）。未認可のユーザーがチームデータにアクセスすることは構造的に不可能。

### S-7: IDORリスクの評価

- **ファイル**: `src/app/api/teams/[teamId]/**/*.ts`
- **重要度**: 情報
- **問題なし**: `[teamId]` ルートは以下の多層防御を備えている:
  1. RLSコンテキスト: `withTeamTenantRls(teamId)` でDBレベルのテナント分離
  2. RBAC: `requireTeamPermission` / `requireTeamMember` でメンバーシップ検証
  3. クエリフィルタ: 全クエリに `teamId` フィルタが含まれ、他チームのデータにはアクセス不可
  4. 所有権チェック: `existing.teamId !== teamId` による二重チェック

## 対応サマリ

| 判定 | 件数 | 指摘ID |
|------|------|--------|
| 要修正 | 1 | S-1（isCrossTenant の null 比較 + 例外未処理） |
| 確認要 | 1 | S-2（メールアドレス公開範囲の意図確認） |
| 指摘なし | 5 | S-3, S-4, S-5, S-6, S-7 |
