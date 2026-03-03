# クロステナント識別機能

## Context

`fix/team-rls-cross-tenant` ブランチで RLS コンテキスト修正を実施済み（`withUserTenantRls` → `withTeamTenantRls` / `withBypassRls`）。この修正により、異なるテナントのユーザーがチームに招待された場合も正常に動作するようになった。

次のステップとして、クロステナント関係を**UI上で識別可能**にする:
- **招待された側**: 参加チームがどのテナント（組織）に属するか識別できる
- **招待した側**: メンバー一覧で各メンバーがどのテナントに所属しているか識別できる
- **デバッグログ**: クロステナントアクセスをサーバーサイドで記録

Tenant モデルには `name` フィールドがあり、IdP のクレーム値（例: `example.com`）が格納されている。

## 再利用する既存コード

| ファイル | 再利用対象 |
|----------|-----------|
| `src/lib/tenant-context.ts` | `resolveUserTenantIdFromClient`, `resolveTeamTenantId` |
| `src/lib/tenant-rls.ts` | `withBypassRls` |
| `src/components/team/team-role-badge.tsx` | Badge UIパターン（参考） |
| `src/lib/logger.ts` | `getLogger`（引数なし） |

## 1. API: `GET /api/teams` にテナント情報追加

**ファイル**: `src/app/api/teams/route.ts`

現在のレスポンス: `{ id, name, slug, description, createdAt, role, memberCount }`

変更:
- 既存の `withBypassRls` ブロック内で `resolveUserTenantIdFromClient(prisma, session.user.id)` を呼び、同一トランザクション内でユーザーテナントIDを取得（追加トランザクション不要）
- Prismaクエリの `team` select に `tenant: { select: { id: true, name: true } }` を追加
- レスポンスに以下を追加:
  - `tenantName: string` — チームのテナント名
  - `isCrossTenant: boolean` — ユーザーのテナントとチームのテナントが異なるか

```ts
import { resolveUserTenantIdFromClient } from "@/lib/tenant-context";

const { userTenantId, memberships } = await withBypassRls(prisma, async () => {
  const uid = await resolveUserTenantIdFromClient(prisma, session.user.id);
  const data = await prisma.teamMember.findMany({
    where: { userId: session.user.id, deactivatedAt: null },
    include: {
      team: {
        select: {
          ...既存フィールド,
          tenant: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { team: { name: "asc" } },
  });
  return { userTenantId: uid, memberships: data };
});

// レスポンスに追加:
tenantName: m.team.tenant.name,
isCrossTenant: userTenantId !== m.team.tenant.id,
```

デバッグログ: クロステナントチームが存在する場合、レスポンス構築後にログ出力:

```ts
const logger = getLogger();
const crossTenantTeams = teams.filter(t => t.isCrossTenant);
if (crossTenantTeams.length > 0) {
  logger.info("Cross-tenant team memberships detected", {
    userId: session.user.id,
    crossTenantTeamIds: crossTenantTeams.map(t => t.id),
  });
}
```

## 2. API: `GET /api/teams/[teamId]` にテナント情報追加

**ファイル**: `src/app/api/teams/[teamId]/route.ts`

変更:
- Prismaクエリの select に `tenant: { select: { name: true } }` を追加
- レスポンスに `tenantName: team.tenant.name` を追加

```ts
select: {
  ...既存フィールド,
  tenant: { select: { name: true } },
}

// レスポンス:
return NextResponse.json({
  ...team,
  tenantName: team.tenant.name,
  role: membership.role,
  memberCount: team._count.members,
  passwordCount: team._count.passwords,
});
```

## 3. API: `GET /api/teams/[teamId]/members` にメンバーテナント追加

**ファイル**: `src/app/api/teams/[teamId]/members/route.ts`

現在のレスポンス: `{ id, userId, role, name, email, image, joinedAt }`

変更:
- 既存クエリ（`withTeamTenantRls`）の後に、`withBypassRls` で各メンバーの所属テナントをバッチ取得
- `TenantMember` → `Tenant.name` を結合

```ts
import { withBypassRls } from "@/lib/tenant-rls";

// 既存メンバークエリの後:
const userIds = members.map(m => m.userId);
const userTenants = await withBypassRls(prisma, async () =>
  prisma.tenantMember.findMany({
    where: { userId: { in: userIds }, deactivatedAt: null },
    select: { userId: true, tenant: { select: { name: true } } },
  }),
);
const tenantByUserId = new Map(userTenants.map(t => [t.userId, t.tenant.name]));

// レスポンスに追加:
members.map((m) => ({
  ...既存フィールド,
  tenantName: tenantByUserId.get(m.userId) ?? null,
}))
```

注:
- `TenantMember` はユーザーのテナント（RLSスコープ外の可能性あり）を参照するため `withBypassRls` が必要。
- `requireTeamMember` による認可チェック済みのため、メンバー一覧閲覧権限を持つユーザーのみがこのデータにアクセスする。
- `userIds` は直前の `withTeamTenantRls` クエリ結果から取得しており、当該チームのメンバーIDに限定されている。
- 現システムは1ユーザー1テナントを前提。`Map` 構築時に複数レコードが存在する場合は後勝ちとなるが、`resolveUserTenantId` が複数テナントを拒否するため実運用上は発生しない。

## 4. デバッグログ: クロステナントアクセス記録

**配置方針**: `getTeamMembership`（全チームAPI呼び出しの共通パス）には追加しない。追加クエリが全リクエストに影響するため。代わりに、テナント情報を既に取得済みの `GET /api/teams` ルートハンドラ内でログ出力する（セクション1参照）。

**ファイル**: `src/app/api/teams/route.ts`（セクション1のコードに含む）

```ts
import { getLogger } from "@/lib/logger";
const logger = getLogger();

// レスポンス構築後:
const crossTenantTeams = teams.filter(t => t.isCrossTenant);
if (crossTenantTeams.length > 0) {
  logger.info("Cross-tenant team memberships detected", {
    userId: session.user.id,
    crossTenantTeamIds: crossTenantTeams.map(t => t.id),
  });
}
```

注: `getLogger()` は引数なし（`src/lib/logger.ts` のAPI仕様）。

## 5. UI: チーム一覧・セレクターにテナント名表示

### 5A. SidebarTeamItem インターフェース拡張

**ファイル**: `src/hooks/use-sidebar-data.ts`

```ts
export interface SidebarTeamItem {
  id: string;
  name: string;
  slug: string;
  role: string;
  tenantName: string;      // 追加
  isCrossTenant: boolean;  // 追加
}
```

### 5B. VaultSelector にテナント名表示

**ファイル**: `src/components/layout/vault-selector.tsx`

- `VaultSelectorTeam` インターフェースに `tenantName?: string`, `isCrossTenant?: boolean` を追加
- `isCrossTenant` なチームのみ、名前の下にテナント名をサブテキストで表示

```tsx
<SelectItem key={team.id} value={team.id}>
  <div className="flex items-start gap-2">
    <Building2 className="h-4 w-4 mt-0.5 shrink-0" />
    <span className="flex flex-col items-start">
      <span>{team.name}</span>
      {team.isCrossTenant && (
        <span className="text-xs text-muted-foreground">{team.tenantName}</span>
      )}
    </span>
  </div>
</SelectItem>
```

### 5C. チーム管理ページにテナント列追加

**ファイル**: `src/app/[locale]/dashboard/teams/page.tsx`

クロステナントチームのカードにテナント名を表示（テナントが異なる場合のみ）。

## 6. UI: メンバー一覧にテナント名表示

**ファイル**: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx`

### 6A. Member インターフェース拡張
```ts
interface Member {
  ...既存フィールド,
  tenantName: string | null;  // 追加
}
```

### 6B. メンバー行にテナント名バッジ表示

チームのテナントと異なるメンバーのみ、メールアドレスの下にテナント名をバッジまたはサブテキストで表示:

```tsx
{m.tenantName && m.tenantName !== team.tenantName && (
  <p className="text-xs text-amber-600 dark:text-amber-400 truncate flex items-center gap-1">
    <Globe className="h-3 w-3" />
    {m.tenantName}
  </p>
)}
```

### 6C. TeamInfo インターフェース拡張
```ts
interface TeamInfo {
  ...既存フィールド,
  tenantName: string;  // 追加（比較用）
}
```

## 7. i18n 翻訳キー追加

**ファイル**: `messages/ja.json`, `messages/en.json`

`TeamSettings` 名前空間に追加:
```json
{
  "TeamSettings": {
    "externalTenant": "外部テナント",
    ...
  }
}
```

`Dashboard` 名前空間に追加:
```json
{
  "Dashboard": {
    "externalTenant": "外部テナント",
    ...
  }
}
```

注: テナント名はIdP由来の値（例: `example.com`）をそのまま表示するため、翻訳対象はラベルのみ。

## 8. テスト更新

### 8A. `src/app/api/teams/route.test.ts`

モックデータ変更:

- `mockPrismaTeamMember.findMany` の戻り値に `team.tenant: { id: "tenant-1", name: "Tenant A" }` を追加
- `mockResolveUserTenantId` を `resolveUserTenantIdFromClient` のモックに変更

テストケース:

1. 同一テナント: `userTenantId = "tenant-1"`, `team.tenant.id = "tenant-1"` → `isCrossTenant: false`, `tenantName: "Tenant A"`
2. クロステナント: `userTenantId = "tenant-1"`, `team.tenant.id = "tenant-2"` → `isCrossTenant: true`
3. ユーザーテナント未解決: `resolveUserTenantIdFromClient` が `null` 返却時の動作
4. マルチテナントエラー: `resolveUserTenantIdFromClient` が `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` をスローした場合の動作
5. `logger.info` がクロステナント検出時に呼ばれること
5. 同一テナントのみの場合は `logger.info` が呼ばれないこと

### 8B. `src/app/api/teams/[teamId]/route.test.ts`

モックデータ変更:

- `mockPrismaTeam.findUnique` の戻り値に `tenant: { name: "Tenant A" }` を追加

テストケース:

1. レスポンスに `tenantName` が含まれることを検証

### 8C. `src/app/api/teams/[teamId]/members/route.test.ts`

モック追加:

- `vi.hoisted()` に `mockPrismaTenantMember: { findMany: vi.fn() }` を追加
- `vi.mock("@/lib/prisma")` に `tenantMember: mockPrismaTenantMember` を追加
- `vi.mock("@/lib/tenant-rls")` に `mockWithBypassRls` を追加（パススルー実装）

テストケース:

1. 各メンバーの `tenantName` が正しい値（userId でマッピング）で返ること
2. クロステナントメンバー: `userId: "u-1"` → `tenantName: "External Org"`
3. 同一テナントメンバー: `userId: "u-2"` → `tenantName: "Tenant A"`（チームのテナントと同一でも値は返す）
4. テナント未所属メンバー: `tenantByUserId` にキーがない → `tenantName: null`
5. `withBypassRls` が `withTeamTenantRls` の後に呼ばれること（呼び出し順序検証）

## 変更対象ファイル一覧

| ファイル | 種別 |
|----------|------|
| `src/app/api/teams/route.ts` | 修正（GETにテナント情報 + デバッグログ追加） |
| `src/app/api/teams/[teamId]/route.ts` | 修正（GETにテナント名追加） |
| `src/app/api/teams/[teamId]/members/route.ts` | 修正（メンバーテナント追加） |
| `src/hooks/use-sidebar-data.ts` | 修正（インターフェース拡張） |
| `src/components/layout/vault-selector.tsx` | 修正（テナント名表示） |
| `src/app/[locale]/dashboard/teams/page.tsx` | 修正（テナント列追加） |
| `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx` | 修正（メンバーテナント表示） |
| `messages/ja.json` | 修正（翻訳キー追加） |
| `messages/en.json` | 修正（翻訳キー追加） |
| `src/app/api/teams/route.test.ts` | 修正（テナント情報 + ログテスト追加） |
| `src/app/api/teams/[teamId]/route.test.ts` | 修正（テナント名テスト追加） |
| `src/app/api/teams/[teamId]/members/route.test.ts` | 修正（メンバーテナントテスト追加） |

## 検証

1. `npm run lint && npx vitest run && npm run build` — エラーなし
2. `GET /api/teams` レスポンスに `tenantName` / `isCrossTenant` が含まれる
3. `GET /api/teams/[teamId]` レスポンスに `tenantName` が含まれる
4. `GET /api/teams/[teamId]/members` 各メンバーに `tenantName` が含まれる
5. VaultSelector でクロステナントチームにテナント名サブテキストが表示される
6. メンバー一覧でクロステナントメンバーにテナント名バッジが表示される
7. 同一テナントのチーム・メンバーにはテナント表示が出ない
8. サーバーログにクロステナントチーム所属が記録される（`GET /api/teams` 時）

## レビュー対応状況

### F-1: `GET /api/teams` で追加トランザクション
- 対応: `resolveUserTenantIdFromClient` を `withBypassRls` 内で使用するよう変更（セクション1）

### F-2: `getTeamMembership` 内の追加クエリが全アクセスに影響
- 対応: ログ配置を `getTeamMembership` から `GET /api/teams` ルートハンドラに移動（セクション4）

### F-3: `getLogger("team-auth")` — API不一致でビルドエラー
- 対応: `getLogger()` 引数なしに修正（セクション4）

### F-5: バッチ取得の複数レコード上書きリスク
- 対応: 単一テナント前提のコメントを追加（セクション3 注記）

### F-6: `SelectItem` レイアウト崩れ
- 対応: `div.flex` wrapper でアイコンとテキストを適切に配置（セクション5B）

### S-2: デバッグログの配置場所とレベル
- 対応: F-2と合わせてルートハンドラに移動。`logger.info` を維持（意図的なクロステナント検出記録のため）

### T-1,4: モックデータに `tenant` がない
- 対応: テスト計画に具体的なモックデータを記載（セクション8A, 8B）

### T-2,5: null tenant の境界値
- 対応: ユーザーテナント未解決ケースをテスト計画に追加（セクション8A）

### T-9-11: loggerモック・引数・偽陽性検証
- 対応: テスト計画に logger.info の引数検証と偽陽性防止テストを追加（セクション8A）

### スキップした指摘
- **F-4** (import漏れリスク): プラン上のコードブロックに明示済み
- **S-1** (VIEWER権限への開示制限): ユーザー要件は全メンバーへの双方向テナント識別
- **S-3** (開示範囲の文書化): コード上の注記で対応
- **T-3,6,7,8,12** (詳細テスト実装ノート): テスト計画の具体化で吸収
