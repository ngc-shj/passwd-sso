# Unified Access Dashboard UI

## Objective

Unified Access 機能 (SA, JIT, MCP Gateway) のテナント管理 UI を実装する。既存のテナント設定ページ (`/dashboard/tenant`) に新しいタブを追加し、Service Account / MCP Client / Access Request を管理可能にする。

## Requirements

### Functional
- Service Account の CRUD (一覧/作成/編集/無効化/削除)
- SA Token の発行・一覧・revoke (plaintext は作成時のみ表示)
- MCP Client の CRUD (一覧/作成/編集/無効化/削除、clientSecret は作成時のみ表示)
- JIT Access Request の一覧 (ステータスフィルター) + 承認/拒否
- Unified Activity ダッシュボード (actorType フィルター付き監査ログ)

### Non-functional
- 既存テナント設定ページのタブ構造に統合
- 既存の shadcn/ui コンポーネント + i18n パターンに従う
- E2E 暗号化に影響なし (UI は暗号化済みデータのメタデータのみ表示)
- テナント権限チェック (`useTenantRole()`) を使用

## Technical Approach

### Architecture
- 既存の `src/app/[locale]/dashboard/tenant/page.tsx` に2つのタブを追加: "Unified Access" + "Activity"
- 各機能は独立した Card コンポーネントとして実装 (既存の `tenant-webhook-card.tsx` パターン)
- API 呼び出しは `fetchApi()` + `apiPath.*` ヘルパー

### Component Structure
```
src/components/settings/
├── service-account-card.tsx      # SA CRUD + token management
├── mcp-client-card.tsx           # MCP Client CRUD
├── access-request-card.tsx       # JIT request list + approve/deny
└── unified-activity-card.tsx     # actorType-filtered audit log
```

### Tab integration
既存 TabsList を `grid-cols-7` に拡張:
- 既存: members, security, provisioning, audit-log, webhooks
- 追加: unified-access, activity

## Implementation Steps

### Tab icons
- Unified Access: `Bot` (lucide-react) — AI agent / service account を象徴
- Activity: `Activity` (lucide-react) — 既存の audit-log とは別の統合ビュー

### Step 1: API Path constants + i18n keys
1. `src/lib/constants/api-path.ts` — 以下を追加:
   - `TENANT_MCP_CLIENTS: "/api/tenant/mcp-clients"`
   - `TENANT_ACCESS_REQUESTS: "/api/tenant/access-requests"`
   - `tenantMcpClients()`, `tenantMcpClientById(id)`
   - `tenantAccessRequests()`, `tenantAccessRequestApprove(id)`, `tenantAccessRequestDeny(id)`
2. `messages/en/Dashboard.json` — タブ名 + 説明文
3. `messages/ja/Dashboard.json` — 同上
4. `messages/en/UnifiedAccess.json` — SA/MCP/JIT/Activity の全 UI 文字列 (新規)
5. `messages/ja/UnifiedAccess.json` — 同上

### Step 2: Service Account Card
6. `src/components/settings/service-account-card.tsx`
   - SA 一覧テーブル (name, description, identityType, isActive, createdAt)
   - 作成ダイアログ (name, description)
   - 編集ダイアログ (name, description, isActive toggle)
   - 削除確認ダイアログ
   - トークンセクション (Collapsible per SA)
     - トークン一覧 (name, prefix, scope, expiresAt, lastUsedAt, revokedAt)
     - トークン作成ダイアログ (name, scope checkboxes, expiresAt)
     - 作成成功後: plaintext トークン表示 + CopyButton (一度きり)
     - トークン revoke 確認ダイアログ

### Step 3: MCP Client Card
7. `src/components/settings/mcp-client-card.tsx`
   - MCP Client 一覧テーブル (name, clientId, allowedScopes, isActive, createdAt)
   - 作成ダイアログ (name, redirectUris, allowedScopes checkboxes)
   - redirectUris バリデーション: `https://` or `http://localhost` のみ (RFC 8252)
   - 作成成功後: clientId + clientSecret 表示 + CopyButton (一度きり)
   - 編集ダイアログ (name, redirectUris, allowedScopes, isActive)
   - 削除確認ダイアログ
   - `allowedScopes` 表示: DB は CSV 文字列 → `split(",")` で配列変換して Badge 表示

### Step 4: Access Request Card
8. `src/components/settings/access-request-card.tsx`
   - Access Request 一覧テーブル (SA name, requestedScope, status, justification, createdAt)
   - ステータスフィルター (PENDING/APPROVED/DENIED/EXPIRED)
   - PENDING リクエスト: Approve/Deny ボタン
   - Approve 成功後: JIT token plaintext 表示 (一度きり、ダイアログ閉鎖で null クリア)
   - Approve 失敗ハンドリング:
     - 409 CONFLICT → "Already processed" toast
     - 409 SA_TOKEN_LIMIT_EXCEEDED → "Token limit reached. Revoke existing tokens first." toast
     - 409 SA_NOT_FOUND (SA inactive) → "Service account is inactive" toast
     - 400 INVALID_SCOPE (scope re-validation failed) → "Invalid scope" toast
   - Deny 確認ダイアログ
   - Note: バックエンド API は全件返却 (pagination 未対応)。MAX_SERVICE_ACCOUNTS_PER_TENANT=50 × JIT requests なので件数は限定的。将来的に cursor pagination 追加予定

### Step 5: Unified Activity Card
9. `src/components/settings/unified-activity-card.tsx`
   - 既存の `tenant-audit-log-card.tsx` を拡張したビュー
   - actorType フィルター (ALL/HUMAN/SERVICE_ACCOUNT/MCP_AGENT)
   - cursor-based pagination (既存の audit-log-card のロジックを再利用)

### Step 6: Tenant page integration
10. `src/app/[locale]/dashboard/tenant/page.tsx` — 2タブ追加 (Bot + Activity icons)
    - TabsList を `overflow-x-auto` でモバイル対応
    - 既存テストファイルへの影響確認 (タブ数変更)

### Step 7: Backend changes
11. `src/app/api/tenant/audit-logs/route.ts`:
    - `actorType` クエリパラメータ追加 (allowlist: `["HUMAN","SERVICE_ACCOUNT","MCP_AGENT","SYSTEM"]`)
    - レスポンスに `actorType`, `serviceAccountId`, `serviceAccount: { id, name }` を追加
    - `actorType` 未指定時は全件返却 (後方互換)
12. `src/app/api/tenant/mcp-clients/route.ts` — `withBypassRls` → `withTenantRls` に変更 (RLS defense-in-depth)
13. `src/app/api/tenant/mcp-clients/[id]/route.ts` — 同上 + DELETE の `where` に `tenantId` 追加 (TOCTOU 防止)
14. MCP Client 作成/更新スキーマの `redirectUris` に `https://` or `http://localhost` refine 追加 (route.ts + [id]/route.ts 両方)

## Testing Strategy

テスト命名: 既存の `tenant-webhook-card.test.tsx` の describe ブロック構造に倣う

### Unit tests (Vitest + @testing-library/react)
- 各 Card コンポーネントの render テスト:
  - `useTenantRole()` の 4 状態: loading → spinner, MEMBER → empty, ADMIN → content, OWNER → content
  - データあり/空の2状態
- ダイアログの開閉とフォームバリデーション:
  - SA name 必須/最大100文字
  - redirectUri の `https://` / `http://localhost` 制限
  - scope checkbox selection
- **plaintext クリア (セキュリティ要件):**
  - SA token 作成成功 → plaintext 表示 → ダイアログ閉鎖 → null (テキスト消失)
  - MCP clientSecret 作成成功 → 同上
  - JIT approve 成功 → token 表示 → ダイアログ閉鎖 → null
- API エラーハンドリング:
  - 409 CONFLICT → "Already processed" toast
  - 409 SA_TOKEN_LIMIT_EXCEEDED → "Token limit" toast
  - 422 limit exceeded → toast
  - 500 → generic error toast
- actorType フィルター API ルートテスト:
  - `actorType` 指定あり・なし・不正値の3ケース

### Integration
- テナント設定ページの全タブが正常にレンダリング
- 権限なしユーザーが UnifiedAccess タブ非表示

## Considerations & Constraints

### Permission model
- 全 SA/MCP/JIT 操作は `requireTenantPermission(SERVICE_ACCOUNT_MANAGE)` でバックエンド保護済み
- UI 側は `useTenantRole().isAdmin` で表示/非表示を制御
- OWNER + ADMIN ロールのみが Unified Access タブを操作可能

### Security
- plaintext トークン/secret は `useState` に保持し、ダイアログ閉鎖時に `null` にクリア
- API レスポンスの token/secret フィールドは作成レスポンスのみに含まれる (GET では返らない)
- ダイアログ内に「この値は再表示できません」の警告を明示表示
- XSS 防御: React の自動エスケープ + dangerouslySetInnerHTML 不使用
- API 失敗時: トークン作成が 500 で失敗した場合、DB にトークンは永続化されていないため不整合なし
- JIT approve の `fetchApi()` 呼び出しに `cache: 'no-store'` を明示 (トークン漏洩防止)
- redirectUris のスキーム制限: `https://` or `http://localhost` のみ (RFC 8252, OAuth 2.1)

### Pagination
- SA 一覧: `MAX_SERVICE_ACCOUNTS_PER_TENANT = 50` のためページネーション不要 (全件取得)
- MCP Client 一覧: `MAX_MCP_CLIENTS_PER_TENANT = 10` のためページネーション不要
- SA Token 一覧: `MAX_SA_TOKENS_PER_ACCOUNT = 5` のためページネーション不要
- Access Request 一覧: 全件取得 (上限 = SA数50 × リクエスト数、実用上十分少ない)
- Activity 一覧: cursor-based pagination (既存の `tenant-audit-log-card.tsx` の実装を再利用)

### Constraints
- タブバー: `flex overflow-x-auto` パターンに変更 (grid-cols-7 はモバイルで潰れるため)
- actorType フィルターは optional クエリパラメータ — 未指定時は全件返却 (後方互換)
- MCP Client の `redirectUris` は配列 — UI ではテキストエリア (1行1URI) で入力
- Input validation: SA name は `z.string().min(1).max(100)`、redirectUri は `z.string().url().refine(u => u.startsWith("https://") || u.startsWith("http://localhost"))` (RFC 8252)

### Out of scope
- SA/MCP Client の使用統計グラフ (将来)
- MCP Gateway のリアルタイムモニタリング (将来)
- SA の team-level 管理 UI (現状は tenant-level のみ)

## User Operation Scenarios

### Scenario 1: SA 作成 → トークン発行
1. テナント管理画面 → Unified Access タブ
2. "Create Service Account" → name: "ci-bot", description: "CI pipeline"
3. 作成されたSAの行を展開 → "Create Token"
4. name: "deploy-token", scope: passwords:read + tags:read, expires: 30日
5. 表示された `sa_xxx...` トークンをコピー
6. ダイアログを閉じる → トークンは二度と表示されない

### Scenario 2: JIT 承認
1. テナント管理画面 → Unified Access タブ → Access Requests セクション
2. PENDING フィルターでリクエスト一覧を確認
3. "Approve" → JIT トークンが表示される → コピー
4. 同じリクエストを再度 Approve → "Already processed" エラー

### Scenario 3: MCP Client 登録
1. テナント管理画面 → Unified Access タブ → MCP Clients セクション
2. "Register MCP Client" → name, redirect URIs (1行1URI), scope checkboxes
3. 作成成功 → clientId + clientSecret 表示 → コピー
4. 一覧に戻る → clientSecret は非表示
