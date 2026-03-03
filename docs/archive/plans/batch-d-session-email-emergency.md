# Group B: セッション管理 + メール通知基盤 + 緊急アクセス通知

## Context

passwd-sso にはメール通知基盤がなく、セッション管理UIも不在。
これにより、漏洩検出・緊急アクセスリクエスト等の重要イベントをユーザーに通知できず、
不正セッションの確認・取消もできない。

本プランで以下を実装する:
- **N-1**: メール送信基盤 (Resend / SMTP 両対応、抽象化)
- **S-5**: 並行セッション管理 (一覧・取消 UI + API)
- **N-4**: 緊急アクセスのメール通知 (N-1 上に構築)

実装順: N-1 → S-5 → N-4

---

## Phase 1: N-1 — メール通知基盤

### 1.1 依存パッケージ追加

```
npm install resend nodemailer
npm install -D @types/nodemailer
```

### 1.2 環境変数 — `.env.example` に追記

```bash
# --- Email (optional) ---
# Provider: "resend" | "smtp". Leave empty to disable email sending.
# EMAIL_PROVIDER=
# EMAIL_FROM=noreply@example.com
# Resend provider (EMAIL_PROVIDER=resend)
# RESEND_API_KEY=
# SMTP provider (EMAIL_PROVIDER=smtp)
# For development with Mailpit (docker-compose.override.yml):
#   SMTP_HOST=localhost  SMTP_PORT=1025  EMAIL_FROM=noreply@localhost
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASS=
```

### 1.3 メールサービス — 新規 `src/lib/email/`

| ファイル | 内容 |
|---------|------|
| `types.ts` | `EmailMessage` 型 + `EmailProvider` インターフェース |
| `resend-provider.ts` | Resend SDK ラッパー |
| `smtp-provider.ts` | nodemailer ラッパー |
| `index.ts` | `sendEmail()` — プロバイダ自動選択、未設定時は無音スキップ、エラーはログのみ (fire-and-forget) |

**設計ポイント:**
- プロバイダ選択は **静的 if/else 分岐** で実装 (動的 require 禁止 — コードインジェクション防止)
  ```typescript
  if (type === "resend") { ... }
  else if (type === "smtp") { ... }
  else { logger.warn(...); provider = null; }
  ```
- エラーログは `getLogger()` (既存 `src/lib/logger.ts`) で **構造化出力**: `{ to, subject, err }` を含む
- 不明な `EMAIL_PROVIDER` 値は起動時に warn ログ出力

### 1.4 メールテンプレート — `src/lib/email/templates/`

| ファイル | 内容 |
|---------|------|
| `layout.ts` | 共通 HTML ラッパー (ヘッダ: アプリ名、フッタ: 自動送信メッセージ注記) |
| `emergency-access.ts` | Phase 3 で使用する 6 テンプレート関数 (Phase 1 ではファイルのみ作成) |

### 1.5 開発用メールサーバー — `docker-compose.override.yml`

Mailpit (MailHog の後継、アクティブメンテ) を追加:
```yaml
  mailpit:
    image: axllent/mailpit:latest
    ports:
      - "1025:1025"   # SMTP
      - "8025:8025"   # Web UI
```

### 1.6 テスト

- `src/lib/email/index.test.ts` — EMAIL_PROVIDER 未設定時の無音スキップ、設定時の send 呼出し、エラー時の **pino ロガーモック** 検証
  - 環境変数テスト: `vi.stubEnv()` / `vi.unstubAllEnvs()` パターン使用
- `src/lib/email/resend-provider.test.ts` — Resend SDK の send 呼出し検証
- `src/lib/email/smtp-provider.test.ts` — nodemailer の sendMail 呼出し検証

---

## Phase 2: S-5 — 並行セッション管理

### 2.1 Prisma スキーマ変更 — `prisma/schema.prisma`

Session モデルを拡張:
```prisma
model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique @map("session_token")
  userId       String   @map("user_id")
  expires      DateTime
  createdAt    DateTime @default(now()) @map("created_at")
  lastActiveAt DateTime @default(now()) @map("last_active_at")
  ipAddress    String?  @map("ip_address") @db.VarChar(45)
  userAgent    String?  @map("user_agent") @db.VarChar(512)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId])
  @@map("sessions")
}
```

AuditAction enum に追加: `SESSION_REVOKE`, `SESSION_REVOKE_ALL`

マイグレーション: `npm run db:migrate`

**連鎖更新箇所 (satisfies 型チェック対応):**
1. `prisma/schema.prisma` — `AuditAction` enum に `SESSION_REVOKE`, `SESSION_REVOKE_ALL` 追加
2. `src/lib/constants/audit.ts` — `AUDIT_ACTION` オブジェクト + `AUDIT_ACTION_VALUES` 配列 + `AUDIT_ACTION_GROUPS_PERSONAL[AUTH]` に追加
3. `messages/{en,ja}/AuditLog.json` — 対応キー追加
4. `src/__tests__/i18n/audit-log-keys.test.ts` が自動的に通ることを確認

### 2.2 セッションメタデータ捕捉 — AsyncLocalStorage パターン

既存の `requestContext` (AsyncLocalStorage, `src/lib/logger.ts`) と同じパターンで、
Auth.js のセッション作成時にリクエストの IP/UA を安全に渡す。

**新規: `src/lib/session-meta.ts`**
```typescript
import { AsyncLocalStorage } from "node:async_hooks";
export interface SessionMeta { ip: string | null; userAgent: string | null }
export const sessionMetaStorage = new AsyncLocalStorage<SessionMeta>();
```

**変更: `src/app/api/auth/[...nextauth]/route.ts`**

`withSessionMeta` ラッパーを追加し、AsyncLocalStorage にメタデータを格納:
```typescript
import { sessionMetaStorage } from "@/lib/session-meta";
import { extractRequestMeta } from "@/lib/audit";

function withSessionMeta(handler: RouteHandler): RouteHandler {
  return async (request: NextRequest, ...rest) => {
    const meta = extractRequestMeta(request);
    return sessionMetaStorage.run(meta, () => handler(request, ...rest));
  };
}

export const GET = withRequestLog(withSessionMeta(handlers.GET));
export const POST = withRequestLog(withSessionMeta(handlers.POST));
```

**新規: `src/lib/auth-adapter.ts`**

PrismaAdapter をラップし、`createSession` と `updateSession` をオーバーライド:
- `createSession`: `sessionMetaStorage.getStore()` から IP/UA を取得して保存。**Store が undefined の場合は null をセット** (フォールバック)
- `updateSession`: `lastActiveAt` を更新

**フォールバック機構 (signIn イベント):**

AsyncLocalStorage のコンテキストが伝播しないケース (SAML Jackson 経由等) に備え、
`src/auth.ts` の `events.signIn` で最新セッションの IP/UA が null の場合にバックフィル:
```typescript
events: {
  async signIn({ user }) {
    if (user.id) {
      logAudit({ ... });
      // Backfill if AsyncLocalStorage context was lost
      const latest = await prisma.session.findFirst({
        where: { userId: user.id, ipAddress: null },
        orderBy: { createdAt: "desc" },
      });
      if (latest) {
        // IP/UA is not available here, but createdAt is set
        // This ensures the session record exists even without metadata
      }
    }
  },
}
```

**変更: `src/auth.ts`**

`PrismaAdapter(prisma)` → `createCustomAdapter()` に差し替え

### 2.3 API エンドポイント

**`GET /api/sessions`** — 新規 `src/app/api/sessions/route.ts`
- 現在のユーザーの有効セッション一覧を返す
- Cookie から現セッショントークンを取得し `isCurrent` フラグを付与
- `sessionToken` は応答に含めない

**`DELETE /api/sessions`** — 同ファイル
- 現在のセッション以外をすべて削除
- **レートリミット適用**: `createRateLimiter({ windowMs: 60_000, max: 5 })` (既存パターン)
- 監査ログ: `SESSION_REVOKE_ALL`

**`DELETE /api/sessions/[id]`** — 新規 `src/app/api/sessions/[id]/route.ts`
- 指定セッションを削除
- **削除クエリに `userId` 条件を含める**: `prisma.session.deleteMany({ where: { id, userId } })` — 他ユーザーのセッションは削除件数 0 → 404
- 現在のセッションの取消は `CANNOT_REVOKE_CURRENT_SESSION` エラー
- **レートリミット適用**
- 監査ログ: `SESSION_REVOKE`

**Cookie 名判定ヘルパー (環境依存を明示的に処理):**
```typescript
function getSessionToken(req: NextRequest): string | null {
  const isProduction = process.env.NODE_ENV === "production";
  return isProduction
    ? req.cookies.get("__Secure-authjs.session-token")?.value ?? null
    : req.cookies.get("authjs.session-token")?.value ?? null;
}
```

### 2.4 定数・エラーコード追加

| ファイル | 追加内容 |
|---------|---------|
| `src/lib/constants/audit.ts` | `SESSION_REVOKE`, `SESSION_REVOKE_ALL` + GROUPS_PERSONAL[AUTH] + VALUES |
| `src/lib/constants/audit-target.ts` | `SESSION: "Session"` |
| `src/lib/api-error-codes.ts` | `SESSION_NOT_FOUND`, `CANNOT_REVOKE_CURRENT_SESSION` + `API_ERROR_I18N` マップ |

### 2.5 i18n

新規ネームスペース `"Sessions"`:
- `messages/en/Sessions.json` / `messages/ja/Sessions.json`
- `src/i18n/messages.ts` の NAMESPACES 配列に追加
- `src/i18n/namespace-groups.ts` の NS_DASHBOARD_CORE に追加

`messages/{en,ja}/ApiErrors.json` にセッションエラーキー追加。
`messages/{en,ja}/AuditLog.json` に SESSION_REVOKE / SESSION_REVOKE_ALL アクションラベル追加。
`messages/{en,ja}/Dashboard.json` に `"settings": "Settings" / "設定"` 追加。

### 2.6 UI

**新規: `src/app/[locale]/dashboard/settings/page.tsx`**
- Settings ページ。SessionsCard コンポーネントを表示。

**新規: `src/components/sessions/sessions-card.tsx`**
- `GET /api/sessions` でセッション一覧取得
- `ua-parser-js` (client-side) で UA 文字列からブラウザ名・OS・デバイスタイプを解析
- lucide アイコン: Monitor (desktop), Smartphone (mobile), Tablet
- 各セッション: ブラウザ/OS、IP (参考値として表示)、最終アクティブ (相対時間)、"現在" バッジ
- 「取り消し」ボタン (AlertDialog で確認後 DELETE)
- 「他のすべてを取り消し」ボタン
- sonner toast でフィードバック

**依存追加:**
```
npm install ua-parser-js
npm install -D @types/ua-parser-js
```
注: ua-parser-js v2 を使用。package-lock.json の integrity hash 固定 + npm audit を CI で実行。

### 2.7 サイドバーリンク — `src/components/layout/sidebar-section-security.tsx`

`UtilitiesSection` に個人 Vault 用の Settings リンクを追加:
```tsx
{!selectedOrg && (
  <Button variant="ghost" className="w-full justify-start gap-2" asChild>
    <Link href="/dashboard/settings" onClick={onNavigate}>
      <Monitor className="h-4 w-4" />
      {t("settings")}
    </Link>
  </Button>
)}
```

### 2.8 テスト

- `src/app/api/sessions/route.test.ts` — GET (一覧、isCurrent) + DELETE (全取消、監査、レートリミット)
  - Cookie テスト: `createRequest` の headers に `Cookie: authjs.session-token=xxx` を設定
- `src/app/api/sessions/[id]/route.test.ts` — DELETE (個別取消、404 (userId 不一致)、現在セッション拒否)
- `src/lib/auth-adapter.test.ts` — createSession メタデータ (AsyncLocalStorage.run() 内で呼出し)、updateSession lastActiveAt、Store undefined 時の null フォールバック
- `src/components/sessions/sessions-card.test.tsx` — `// @vitest-environment jsdom` ディレクティブ必須。レンダリング、取消操作
- `src/components/layout/sidebar-section-security.test.tsx` — Settings リンクの表示条件テスト追加

---

## Phase 3: N-4 — 緊急アクセスメール通知

### 3.1 テンプレート — `src/lib/email/templates/emergency-access.ts`

6 テンプレート関数 (すべて `{ subject, html, text }` を返す):

| 関数 | トリガー | 宛先 |
|------|---------|------|
| `emergencyInviteEmail` | グラント作成 | granteeEmail |
| `emergencyGrantAcceptedEmail` | 承諾 | owner |
| `emergencyGrantDeclinedEmail` | 辞退/拒否 | owner |
| `emergencyAccessRequestedEmail` | アクセス要求 | owner (待機期間情報付き) |
| `emergencyAccessApprovedEmail` | 承認/有効化 | grantee |
| `emergencyAccessRevokedEmail` | 取消 | grantee |

**テンプレートは ja/en 両対応。** 各関数は `locale` 引数を受け取り、テンプレート内で言語を切り替える。
招待メールにはトークン付き直リンクを含めず、「アプリにログインして確認してください」案内を記載。

### 3.2 ルートへの統合

各ルートの DB 更新 + 監査ログの後に `sendEmail()` を追加 (fire-and-forget)。
**順序: DB 更新 → logAudit() → sendEmail()** (メール失敗がアクション全体の失敗にならない)

| ルートファイル | テンプレート | 宛先 |
|-------------|-----------|------|
| `src/app/api/emergency-access/route.ts` (POST) | invite | granteeEmail |
| `src/app/api/emergency-access/accept/route.ts` | accepted | owner |
| `src/app/api/emergency-access/reject/route.ts` | declined | owner |
| `src/app/api/emergency-access/[id]/accept/route.ts` | accepted | owner |
| `src/app/api/emergency-access/[id]/decline/route.ts` | declined | owner |
| `src/app/api/emergency-access/[id]/request/route.ts` | requested | owner |
| `src/app/api/emergency-access/[id]/approve/route.ts` | approved | grantee |
| `src/app/api/emergency-access/[id]/revoke/route.ts` | revoked | grantee |

Prisma クエリに **最小スコープの select** を追加してメール宛先取得:
```typescript
include: { owner: { select: { name: true, email: true } } }
// または
include: { grantee: { select: { name: true, email: true } } }
```

### 3.3 テスト

- `src/lib/email/templates/emergency-access.test.ts` — 各テンプレートの HTML 出力検証 (ja/en 両ロケール)。ロケールは引数で明示渡し (環境依存なし)。
- 既存の 8 テスト (`src/app/api/emergency-access/` 配下) に以下を追加:
  - `vi.hoisted()` ブロックに `mockSendEmail: vi.fn()` 追加
  - `vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }))` 追加
  - モックオブジェクトに `owner: { name, email }` / `grantee: { name, email }` プロパティ追加
  - `sendEmail` 呼出しアサーション (to, subject の検証)

---

## 変更ファイルサマリ

### 新規ファイル (~20)

| カテゴリ | ファイル |
|---------|---------|
| Email | `src/lib/email/types.ts`, `index.ts`, `resend-provider.ts`, `smtp-provider.ts` |
| Templates | `src/lib/email/templates/layout.ts`, `emergency-access.ts` |
| Session | `src/lib/session-meta.ts`, `src/lib/auth-adapter.ts` |
| API | `src/app/api/sessions/route.ts`, `src/app/api/sessions/[id]/route.ts` |
| UI | `src/app/[locale]/dashboard/settings/page.tsx`, `src/components/sessions/sessions-card.tsx` |
| i18n | `messages/{en,ja}/Sessions.json` |
| Tests | 各 `.test.ts` (~10 ファイル) |

### 変更ファイル (~20)

| ファイル | 変更内容 |
|---------|---------|
| `package.json` | resend, nodemailer, ua-parser-js 追加 |
| `.env.example` | EMAIL_* 変数追加 |
| `docker-compose.override.yml` | Mailpit サービス追加 |
| `prisma/schema.prisma` | Session 拡張 + AuditAction 追加 |
| `src/auth.ts` | カスタムアダプター使用 + signIn フォールバック |
| `src/app/api/auth/[...nextauth]/route.ts` | withSessionMeta ラッパー追加 |
| `src/lib/constants/audit.ts` | SESSION_REVOKE 等 + VALUES + GROUPS 追加 |
| `src/lib/constants/audit-target.ts` | SESSION 追加 |
| `src/lib/api-error-codes.ts` | セッションエラーコード + I18N マップ追加 |
| `src/i18n/messages.ts` | Sessions ネームスペース追加 |
| `src/i18n/namespace-groups.ts` | NS_DASHBOARD_CORE に追加 |
| `src/components/layout/sidebar-section-security.tsx` | Settings リンク追加 |
| `messages/{en,ja}/Dashboard.json` | settings キー追加 |
| `messages/{en,ja}/ApiErrors.json` | セッションエラーキー追加 |
| `messages/{en,ja}/AuditLog.json` | SESSION_REVOKE ラベル追加 |
| `vitest.config.ts` | `coverage.include` に `src/lib/email/**` と `src/lib/auth-adapter.ts` 追加 |
| 8 EA ルートファイル | sendEmail 呼出し + select 追加 |
| 8 EA テストファイル | sendEmail モック + モックオブジェクト拡張 |

---

## Verification

1. `npx prisma migrate dev` — マイグレーション成功
2. `npm run build` — TypeScript コンパイル成功
3. `npx vitest run` — 全テスト pass (audit-log-keys テスト含む)
4. `npm run lint` — ESLint pass
5. 手動確認:
   - `EMAIL_PROVIDER` 未設定でアプリ起動 → エラーなし
   - Docker mailpit + `EMAIL_PROVIDER=smtp` → 緊急アクセス作成時にメール送信確認 (ja/en)
   - `/dashboard/settings` でセッション一覧表示、取消操作
