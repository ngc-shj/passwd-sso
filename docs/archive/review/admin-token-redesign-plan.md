# Admin token redesign — per-operator signed token

Status: **Phase 1 plan draft — under triangulate review**
Tracks: pre3 from `docs/archive/review/csrf-admin-token-cache-review.md`
Source prompt: `docs/archive/review/admin-token-redesign-pre3-prompt.md`

## 1. Project context

- **Type**: web app + service (Next.js 16 App Router + service-side admin/maintenance routes + operator shell scripts).
- **Test infrastructure**: unit (vitest, Prisma fully mocked) + integration (real Postgres via `npm run test:integration`) + CI/CD (GitHub Actions, release-please for versioning).
- This plan is allowed to mandate Critical/Major test/CI work because the project has the infrastructure for it.

## 2. Objective

Replace the **shared** `ADMIN_API_TOKEN` (single 64-hex secret used by every operator running `scripts/*.sh` against the 7 admin/maintenance routes) with **per-operator, DB-backed, scope-bearing tokens** so that:

1. A leaked token forges **one operator's** identity, not "any admin UUID".
2. Revoking a single operator's access is one DB row update, not a fleet-wide secret rotation.
3. Audit log attribution moves from `actorType=SYSTEM` + body-parameter `operatorId` to `actorType=HUMAN` + token-bound subject userId — operatorId can no longer be fabricated by a token holder.
4. The fix specifically closes the `purge-audit-logs` blast-radius escalation (token leak → destroy audit evidence → false attribution to any admin) called out as pre3.

Out of scope (explicit, do not creep):
- Auth.js v5 session machinery.
- Service Account / MCP token machinery (we **observe** their patterns, not modify them).
- Adding new admin endpoints beyond the 7 already in scope.

## 3. Requirements

### Functional

- F-1 Each of the 7 routes (`/api/admin/rotate-master-key`, `/api/maintenance/{purge-history, purge-audit-logs, dcr-cleanup, audit-outbox-metrics, audit-outbox-purge-failed, audit-chain-verify}`) MUST accept a per-operator bearer token in `Authorization: Bearer ...` and reject all other tokens.
- F-2 Token verification MUST resolve to a single tenant `User` row that is currently an active OWNER/ADMIN of some tenant (delegated to the existing `requireMaintenanceOperator` helper or its replacement). The userId resolved from the token MUST replace the body/query `operatorId` parameter; the field MUST stop being trusted as input.
- F-3 Tenant OWNER/ADMIN users MUST be able to mint and revoke their own admin/maintenance tokens via the existing tenant admin web UI surface, with the token plaintext shown exactly once at creation.
- F-4 Token records MUST persist a SHA-256 hash (never the plaintext), the issuing tenant, the subject userId, scope, expiration, last-used-at, and revocation timestamp — the same shape used by `ServiceAccountToken` and `ApiKey`.
- F-5 During the migration window, `verifyAdminToken` MUST accept BOTH (a) a valid new per-operator token and (b) the legacy `ADMIN_API_TOKEN` env value (only when that env var is set). The cutover is signalled by **unsetting** `ADMIN_API_TOKEN`; no new env-var feature flag is added.
- F-6 The 4 operator shell scripts (`scripts/{purge-history,purge-audit-logs,rotate-master-key,set-outbox-worker-password}.sh` — note: `set-outbox-worker-password.sh` is a DB role helper that does NOT call any admin route, so it is not in F-6 scope; the actual admin-route-calling scripts are `purge-history.sh`, `purge-audit-logs.sh`, `rotate-master-key.sh`, plus a NEW `dcr-cleanup.sh` if we ship one; existing scripts cover only 3 of the 7 routes today — see §6 step 7) MUST keep working with both the legacy token and a new per-operator token; only the env var changes (`ADMIN_API_TOKEN=<hex64>` → `ADMIN_API_TOKEN=op_...`). Bonus: scripts no longer need `OPERATOR_ID` (we'll derive it from the token; legacy callers may still pass it for backward compatibility but it is ignored when a per-operator token is presented).
- F-7 An audit event MUST be emitted on token create, revoke, and (route-specific, already exists) on token *use*. Token-create / token-revoke land in a new `AUDIT_ACTION_GROUP.MAINTENANCE_TOKEN` (or extend an existing group; see §4.7).

### Non-functional

- N-1 All token comparisons remain timing-safe (`timingSafeEqual` over SHA-256 digests; lookup by hash uses Prisma `findUnique({ where: { tokenHash } })` — DB lookup is constant-time-equivalent for our threat model).
- N-2 Existing per-route rate limiter (`createRateLimiter({ max: 1|3|6, windowMs: 60_000 })`) is kept verbatim; this redesign is auth-only, not rate-limit.
- N-3 No new third-party dependencies. We do NOT add `jsonwebtoken`, `jose`, or any JWT library — see §4 (option D wins).
- N-4 The new token type SHALL follow `op_` prefix convention (parallels `sa_`, `mcp_`, `api_`) and reuse `hashToken()` from `src/lib/crypto/crypto-server.ts`.
- N-5 Production deployments without legacy `ADMIN_API_TOKEN` MUST still work the moment a tenant admin issues their first per-operator token; no chicken-and-egg bootstrap.
- N-6 The cutover MUST be reversible up to the point at which legacy support is removed. While the env path is still allowed, an operator can fall back to the legacy token if their per-operator token is lost.

## 4. Technical approach

### 4.1 Options considered

| Option | What it is | Pros | Cons | Verdict |
|---|---|---|---|---|
| (a) **JWT HS256, per-operator** | `Authorization: Bearer <jwt>` signed with HMAC over `ADMIN_API_TOKEN` (or a sibling secret); `sub`=userId, `exp`, `scope` | Stateless verify (no DB hit); operator binding via `sub`; reuses existing 64-hex secret as HMAC key | Single-key compromise still forges any operator; revocation needs a DB blacklist anyway → loses the stateless advantage; introduces a JWT library or hand-rolled JWT (more attack surface than current SHA-256 lookup pattern) | **Reject**: revocation reality erases the only architectural pro |
| (b) **JWT RS256/Ed25519, per-operator** | Asymmetric; private signing key on issuer host, public key on verifier | Compartmentalized key trust; matches OAuth provider patterns | Requires KMS/key-rotation infra that does NOT exist here; for a single-instance Next.js box the verifier and signer share the same disk → asymmetric buys nothing operationally; bootstrap (key generation, distribution, rotation) is a multi-week side project | **Reject**: no KMS infra, no operational gain at this deployment topology |
| (c) **mTLS + cert→operator mapping** | Client cert per operator; Next.js middleware maps `subject.CN` → userId | Strongest auth (private key never on wire); revocation via CRL/OCSP | Next.js ingress doesn't terminate mTLS natively in our docker-compose deploy; CI flows via curl break; cert provisioning + renewal is a separate ops project; operator scripts become much more complex than `Authorization: Bearer` | **Reject**: deployment topology mismatch + ops cost wildly disproportionate to threat |
| (d) **DB-backed per-operator opaque token** (`op_` prefix, parallels `sa_`/`mcp_`/`api_`) | New `OperatorToken` Prisma model, SHA-256 hash lookup, scope CSV, optional family-based rotation | Reuses every existing pattern (`ServiceAccountToken`, `ApiKey`, `McpAccessToken` all have this exact shape); revocation is a `revokedAt` column update; per-operator binding is intrinsic; NO new dependencies | "Just another token table" — slight schema bloat; needs UI for issuance | **Accept** |

### 4.2 Recommendation: option (d), `OperatorToken`

The decisive arguments:

1. **No technical blocker**: the codebase already has 4 near-identical token tables (`ServiceAccountToken`, `ApiKey`, `McpAccessToken`, `ExtensionToken`). The pattern is proven and audited.
2. **Revocation is a column update**: matches existing `revokedAt` semantics; same audit, same hash, same `lastUsedAt` throttle (3.6 KLOC of `service-account-token.ts` pattern is essentially copy-paste).
3. **No new third-party crypto**: SHA-256 hash + `timingSafeEqual` already in `hashToken()`. Adding a JWT library introduces a parsing/algorithm-confusion attack surface (CVE-prone area) that a database lookup does not have.
4. **Per-operator binding is structural, not advisory**: the userId comes from the token row, not from a body parameter. The forging vector that pre3 describes (attacker writes `operatorId` in body) is impossible by construction.

Honest cost statement (per "no false technical justification" rule): option (a) is *also* implementable cheaply; we reject (a) primarily because revocation forces a DB anyway, not because it is "technically incompatible."

### 4.3 Token lifecycle

- **Format**: `op_` + 32 random bytes (base64url, no padding) → 32-byte plaintext after the prefix. Total ≈ 46 chars. Pattern: `^op_[A-Za-z0-9_-]{43}$`.
- **Storage**: SHA-256 hex hash via the existing `hashToken()`; plaintext is shown exactly once at creation.
- **TTL**: default **30 days**, max **90 days**, min 1 day. (Down from default 90 / max 365 in the original draft — Round 1 Security S2 flagged that a 30-day Auth.js session minting a 365-day token is a session-compromise amplifier. v1 caps the token at 90 days; longer-lived needs go through a follow-up PR with explicit security review.) Expired tokens fail verification with `OPERATOR_TOKEN_EXPIRED`.
- **Rotation**: NOT family-based at v1. The operator simply mints a new token before the old expires; both verify until the old one is revoked or expires. Rotation flow is "issue new, swap env var, revoke old." Family-based rotation (MCP-style) is deferred to v2 — YAGNI for human-driven operator workflows.
- **Revocation**: per-row `revokedAt`; tenant OWNER/ADMIN can revoke any token (their own or another operator's) within their tenant.
- **`lastUsedAt`**: throttled write — `OPERATOR_TOKEN_LAST_USED_THROTTLE_MS = 5 * MS_PER_MINUTE` (matches `SA_TOKEN_LAST_USED_THROTTLE_MS = 5 * MS_PER_MINUTE` per Round 1 F8).

### 4.4 Scope design

- v1 ships **one** scope: `maintenance` — granted by all 7 admin/maintenance routes.
- Rationale: KISS. The pre3 fix is per-operator binding, not per-route granularity. All 7 routes already require OWNER/ADMIN tenancy; further splitting is hypothetical capability-control that none of the current operators need.
- v2 (deferred, NOT this PR): introduce sub-scopes if needed: `maintenance:read` (audit-outbox-metrics, audit-chain-verify), `maintenance:purge` (purge-history, purge-audit-logs, dcr-cleanup, audit-outbox-purge-failed), `admin:key-rotation` (rotate-master-key). Schema accommodates this from day 1: `scope` is a CSV string (same as `ServiceAccountToken.scope`); v1 just uses one value.

### 4.5 Multi-tenant operator handling

`requireMaintenanceOperator` (PR #400) already handles multi-tenant operators by pinning to oldest membership (`orderBy: { createdAt: "asc" }`). The new token includes `tenantId` from the moment of issuance — bound at mint time. This makes attribution deterministic and removes the "which tenant?" ambiguity; it also means an operator who is OWNER in two tenants needs two tokens (one per tenant), which mirrors how a real auth boundary should work.

### 4.6 Audit attribution

| Field | Legacy path (env token) | New path (op_ token) |
|---|---|---|
| `actorType` | `SYSTEM` (unchanged) | `HUMAN` |
| `userId` | `SYSTEM_ACTOR_ID` (unchanged) | resolved `subjectUserId` from token row |
| `metadata.operatorId` | from body/query (untrusted) | absent — see `tokenSubjectUserId` |
| `metadata.tokenSubjectUserId` | n/a | from token row (trusted) — distinct field name from legacy `operatorId` to prevent trust-shadowing across paths |
| `metadata.tokenId` | n/a | token row id (so revocation can be cross-referenced from logs) |
| `metadata.authPath` | `"legacy_env"` (NEW field on legacy too — implementer must add) | `"operator_token"` |

Round 1 review F6 flagged that the legacy path is NOT "exactly as today" — `metadata.authPath: "legacy_env"` is added on legacy too. F7 flagged that reusing `metadata.operatorId` for both paths shadows trust levels (body-trust on legacy, token-trust on operator). Resolution: the operator path uses a distinct field name `tokenSubjectUserId`, leaving `operatorId` unambiguous as "untrusted body input" everywhere it appears. Additionally, §6 step 4 enforces `body.operatorId === auth.subjectUserId` on the operator path — if a script accidentally sends a mismatched `operatorId`, the request is rejected (400) rather than silently ignored.

The `authPath` field lets SIEM pipelines distinguish legacy vs new authentications during migration without parsing actor types, and lets us alert if `legacy_env` traffic appears after the planned cutover date.

### 4.6a Legacy-path observability (deprecation surface)

Per the principle that "lingering legacy auth = lingering attack surface", every legacy-token verification (when the request was authenticated by `ADMIN_API_TOKEN` env value, not by an `op_*` token) emits:

1. A `logger.warn("admin-token: legacy ADMIN_API_TOKEN env auth used", { route, requestId })` line — visible in app logs, easy to alert on.
2. A `Deprecation: true` and `Sunset: <date-of-Phase-B>` HTTP response header — surface to operators that this auth path is going away. Sunset date is sourced from a **code-baked constant** `ADMIN_API_TOKEN_LEGACY_SUNSET = "YYYY-MM-DD"` declared in `src/lib/constants/auth/operator-token.ts`. (Round 1 Security S4 flagged that an env-controlled sunset date is operator-controlled — the same operators whose legacy access the deprecation is supposed to discipline can extend their own deadline silently. Baking it into a code constant means changing the date requires a PR, which is reviewable. The exact date is set by the operator team at v1 implementation time; recommended ≥6 months from merge to give self-hosted deployments rotation budget.)
3. The audit `metadata.authPath: "legacy_env"` (already in §4.6) — usable as a SIEM alert key: "any production tenant emitting `authPath=legacy_env` after the sunset date is a deprecation violation."

These three surfaces give operators visibility into legacy usage WITHOUT forcibly breaking the legacy path before they have rotated. Removing the path is Phase C.

### 4.6b Per-route legacy-path attenuation (S1 mitigation)

Round 1 Security S1 flagged that during Phase A the pre3 threat (token leak → destroy audit evidence on `purge-audit-logs`) is NOT mitigated, because the legacy path retains full power on all 7 routes for the duration of Phase A.

Mitigation: from the moment v1 ships, the legacy path is **automatically disabled on the two highest-blast-radius destructive routes** (`purge-audit-logs`, `purge-history`) once the deployment has at least one non-revoked, non-expired `OperatorToken` row. The check fires at request time inside `verifyAdminToken`:

```
if (route in {"purge-audit-logs", "purge-history"}
    && legacyTokenPresented
    && (await hasAnyActiveOperatorToken())) {
  // refuse legacy path — only operator tokens accepted on this route
  return { ok: false, reason: "LEGACY_DISABLED_ON_ROUTE" };
}
```

`hasAnyActiveOperatorToken()` semantics — **monotonic latch, NOT TTL-decaying**: a process-local boolean `everSeenActiveToken: boolean` starts at `false`. While `false`, the function performs the DB lookup (with a short 60-second TTL on the negative result to avoid hot-path DB hits while the deployment is still bootstrapping). The first time the lookup returns a non-null row, the latch flips to `true` and **never flips back within the same process lifetime** — even if the row is later revoked, expired, or deleted. The latch resets only on process restart.

Round 2 review S13/F18-A flagged an earlier draft of this section that suggested "TTL re-check even when cached value is `true`": that wording would have reintroduced an attack window where an adversary issues an op-token, revokes it, waits for cache TTL, and the legacy path re-enables. The monotonic-latch design closes that loop entirely. The trade-off is that a deployment with a transient mis-issuance (token issued then immediately deleted before any legitimate use) keeps the legacy path disabled until process restart — acceptable because the legitimate fix is "issue another token," not "re-enable legacy."

Window of legacy reachability after the FIRST operator token is issued: bounded by `60s × number_of_processes_that_haven't_yet_observed_the_row`. In the project's single-instance topology that is `60s` worst case; in a hypothetical multi-process cluster (PM2/k8s scale-out), each process independently observes via its first DB hit. Document this honestly so reviewers do not over-claim the protection.

Dev-mode note (Round 3 F21): in `next dev` with HMR, editing this module's file re-evaluates it and resets the latch to `false`. Acceptable in dev (legacy auth typically isn't exercised there). Production deployments don't HMR; the latch is stable for the process lifetime.

Why these two routes specifically: they irreversibly destroy audit evidence (the exact pre3 threat). The other 5 routes (`rotate-master-key`, `dcr-cleanup`, `audit-outbox-metrics`, `audit-outbox-purge-failed`, `audit-chain-verify`) keep legacy support during Phase A — `rotate-master-key` is the bootstrap path for prod and must work even before the first operator token is issued.

The migration narrative becomes: "issue at least one `OperatorToken` → within 60 s, both `purge-*` routes auto-cut over to operator-only; the other 5 routes follow when you unset `ADMIN_API_TOKEN` in Phase B."

### 4.7 New audit actions

Add to `AUDIT_ACTION` (in `src/lib/constants/audit/audit.ts`) and to the Prisma `AuditAction` enum (migration required):

- `OPERATOR_TOKEN_CREATE`
- `OPERATOR_TOKEN_REVOKE`
- (use is captured by per-route actions already; no `OPERATOR_TOKEN_USE` action).

Group placement: `AUDIT_ACTION_GROUP.ADMIN` in `AUDIT_ACTION_GROUPS_TENANT` ONLY. Round 2 F16 corrected the original Round-1 fix: `AUDIT_ACTION_GROUPS_PERSONAL` does NOT have an `[ADMIN]` key today (verified at `audit.ts:340-443`; the personal map enumerates AUTH/ENTRY/BULK/TRANSFER/ATTACHMENT/TEAM/FOLDER/HISTORY/SHARE/SEND/EMERGENCY/API_KEYS/TRAVEL_MODE/WEBAUTHN/DELEGATION). Peer high-privilege events that this plan's actions sit alongside in tenant-scope ADMIN: `MASTER_KEY_ROTATION`, `AUDIT_LOG_PURGE`, `HISTORY_PURGE`, `ADMIN_VAULT_RESET_*`, `TENANT_ROLE_UPDATE`. Note that `MASTER_KEY_ROTATION` is also tenant-only (no personal entry), establishing precedent — operator-token issuance is tenant-scoped governance and does not need a personal-feed surface. The TENANT-scope ADMIN group is included in `TENANT_WEBHOOK_EVENT_GROUPS` so tenant webhook subscribers automatically receive operator-token issuance/revocation notifications. `AUDIT_ACTION_GROUPS_TEAM` does NOT receive these actions (operator tokens are tenant-scoped, not team-scoped). `AUDIT_ACTION_GROUPS_PERSONAL` does NOT receive them either — the operator's own user-scoped audit feed will surface these events via the existing audit log views (events emitted with `actorType=HUMAN` and `userId=session.userId` show up in the user's personal audit-log download regardless of group membership; the `*_GROUPS_*` maps drive UI *filter* categorization, not raw event visibility).

The two values must also land in `AUDIT_ACTION_VALUES` and the i18n label maps. **Locale file paths**: `messages/en/AuditLog.json` and `messages/ja/AuditLog.json` — labels live at the top level of `AuditLog.json` (no `audit.actions` wrapper). (Round 1 F2/T3/T11 corrected the original draft, which incorrectly named flat `messages/en.json`/`messages/ja.json` files that do not exist in this repo.) Also: any UI label component that exhaustively maps audit actions. Recurring issue R12 (action group coverage gap) explicitly applies — the file enumeration in §6 step 2 lists every site.

### 4.8 Migration gate (no new env var)

- **Phase A** (this PR): `verifyAdminToken` accepts `ADMIN_API_TOKEN` env value OR a valid `op_*` token. Both produce a successful auth result, but the result *type* differs (`{ kind: "legacy" }` vs `{ kind: "operator", subjectUserId, tokenId, tenantId }`). Routes consume this typed result and choose audit attribution accordingly. The `purge-audit-logs` and `purge-history` routes auto-disable the legacy path once any active `OperatorToken` exists in the deployment (§4.6b) — closing the pre3 blast-radius gap from the moment the first operator migrates.
- **Phase B** (later PR, ≥30 days after Phase A ships): when operators report all tokens migrated, the operator unsets `ADMIN_API_TOKEN` per environment. Two prerequisites the operator must complete first (Round 1 Security S5):
  - **(a)** if `SHARE_MASTER_KEY_CURRENT_VERSION >= 2` is in effect, `src/lib/env-schema.ts:493-499` currently throws on app boot when `ADMIN_API_TOKEN` is unset in production. That production-required-when invariant must be **relaxed in a prior PR** (e.g., changed to a soft warning, or removed entirely once Phase B is reached) so the app still starts after the env var is cleared.
  - **(b)** unsetting the env var in the orchestrator (docker-compose, k8s, etc.) takes effect only after a **container/process restart**; `verifyAdminToken` reads `process.env.ADMIN_API_TOKEN` at every request, but containerized deployments bake env at process start.
  After both prerequisites are met and the env var is unset, the legacy code path remains in the codebase but becomes unreachable.
- **Phase C** (final PR, after at least one release with `ADMIN_API_TOKEN` unset in production for a full audit period): delete the legacy code path, delete the env var declaration in `env-schema.ts`, delete from `scripts/env-allowlist.ts`, update `.env.example`, and update operator scripts to drop the legacy fallback. Phase C is **not** part of this PR.

This staging avoids introducing a `LEGACY_*` feature flag (the codebase has no such pattern; introducing one for a single-use cutover is overkill).

## 5. Schema changes

### 5.1 New Prisma model

The shape MUST match the existing token-table convention in this repo (`ServiceAccountToken`, `ApiKey`, `McpAccessToken`, `McpRefreshToken`). All four use `@db.Uuid` Postgres-side, snake_case `@@map` table names, and explicit `@db.VarChar`/`@db.Timestamptz(3)` annotations. Following that pattern verbatim:

```prisma
model OperatorToken {
  id              String    @id @default(uuid(4)) @db.Uuid
  tokenHash       String    @unique @db.VarChar(64) // SHA-256 hex of plaintext
  prefix          String    @db.VarChar(8)          // first 8 chars of plaintext, e.g. "op_xxxxx" — for UI display
  name            String    @db.VarChar(128)        // operator-supplied label, e.g. "ngc-shj laptop, 2026-04-27"
  tenantId        String    @db.Uuid
  subjectUserId   String    @db.Uuid                // the user this token authenticates AS
  createdByUserId String    @db.Uuid                // who minted the token (== subjectUserId in v1; future-proof for delegated mint)
  scope           String    @db.VarChar(255)        // CSV; v1 always "maintenance"
  expiresAt       DateTime  @db.Timestamptz(3)
  revokedAt       DateTime? @db.Timestamptz(3)
  lastUsedAt      DateTime? @db.Timestamptz(3)
  createdAt       DateTime  @default(now()) @db.Timestamptz(3)

  tenant      Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  subjectUser User   @relation("OperatorTokenSubject", fields: [subjectUserId], references: [id], onDelete: Cascade)
  createdBy   User   @relation("OperatorTokenCreatedBy", fields: [createdByUserId], references: [id], onDelete: Cascade)

  @@index([tenantId, revokedAt])
  @@index([subjectUserId, revokedAt])
  @@index([expiresAt])
  @@map("operator_tokens")
}
```

Rationale notes:

- `@db.Uuid` is mandatory: `Tenant.id` and `User.id` are `@db.Uuid`, so the FK columns must match Postgres-side (otherwise `String`-as-`text` coerces to TEXT and the FK is rejected by Prisma's migration generator). This was identified as Critical in Round 1 review (F1).
- `tokenHash` uniqueness collision is astronomically unlikely (32 random bytes → 256-bit space) but uniqueness is enforced for defense-in-depth and matches the pattern of every other token table.
- `subjectUserId` is the auth principal; `createdByUserId` is provenance. They are separate columns now even though v1 forces them equal — to avoid a schema migration when v2 introduces delegated minting. The equality is **enforced at the create-route layer**, not at the schema (see §6 step 5).
- Cascade-on-tenant-delete and cascade-on-user-delete: tokens are meaningless without their tenant or subject user. Audit logs reference the token by id in metadata, not by foreign key, so cascades don't lose history.
- `@@map("operator_tokens")` matches the codebase's snake_case table-name convention (verify by grep on `@@map\(` in `prisma/schema.prisma`).

### 5.2 Migration

A **single migration file** suffices: `prisma/migrations/<timestamp>_add_operator_token/migration.sql`. Round 1 F4 incorrectly assumed Postgres forbids `ALTER TYPE ... ADD VALUE` inside transactions; Round 2 F17 verified against actual repo migrations (`prisma/migrations/20260415130000_audit_path_unification/migration.sql` and `prisma/migrations/20260214195500_add_trash_specific_audit_actions/migration.sql`) that this codebase's Postgres 16 does support `ADD VALUE` in transactions. The historical restriction is only that the new value cannot be **used** in the same transaction (e.g., no `INSERT ... = 'OPERATOR_TOKEN_CREATE'` in the migration). The migration here only adds enum values and creates a new table — it does not USE the new values — so a single tx-wrapped file is correct and matches existing precedent.

Migration body (in order; same file):

- `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OPERATOR_TOKEN_CREATE';`
- `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OPERATOR_TOKEN_REVOKE';` (the `IF NOT EXISTS` guard matches the precedent in `20260214195500_add_trash_specific_audit_actions`).
- `CREATE TABLE "operator_tokens"` with the columns from §5.1 (Prisma maps `OperatorToken` → `operator_tokens` via `@@map`).
- `CREATE UNIQUE INDEX` on `tokenHash`.
- `CREATE INDEX` on the three index pairs.
- `GRANT SELECT, INSERT, UPDATE ON TABLE operator_tokens TO passwd_app;`
- (uuid PKs do not create sequences, so no sequence grant is needed — confirm during impl by inspecting the generated SQL.)

R14 (DB role grant completeness): `passwd_app` needs SELECT for token verification, INSERT for issuance, UPDATE for `lastUsedAt` + `revokedAt`. No DELETE — tokens are tombstoned, not removed (audit hygiene). `passwd_outbox_worker` does NOT need any access (this table is not in the outbox path). `passwd_user` (migration role) is the table owner and inherits all privileges.

The migration is purely additive (R24); no existing column changes, no backfills, no concurrent-write hazards.

## 6. Implementation steps

1. **Prisma schema + migration** (single migration file per §5.2 — Round 2 F17 corrected)
   - Add `OperatorToken` model to `prisma/schema.prisma` (with `@db.Uuid` annotations per §5.1).
   - Add `OPERATOR_TOKEN_CREATE` and `OPERATOR_TOKEN_REVOKE` to the Prisma `AuditAction` enum in `schema.prisma`.
   - `npm run db:migrate` — generates a single migration file. Use `IF NOT EXISTS` on the `ALTER TYPE ADD VALUE` lines (existing repo precedent in `20260214195500_add_trash_specific_audit_actions`).
   - Per `feedback_run_migration_on_dev_db.md`, apply against the dev DB with real data (not a clean fixture) to catch role-grant or RLS surprises early.
   - Add `passwd_app` GRANT statements in the same migration file.
   - **MANDATORY post-step**: confirm Prisma client is regenerated (Prisma 7's `db:migrate` runs `prisma generate` automatically, so this is normally a no-op; but if your editor's TS LSP did not pick up the new client, run `npx prisma generate` manually — Round 2 F20 + `feedback_prisma_generate_branch_switch.md`).
2. **Constants**
   - Add to a new file `src/lib/constants/auth/operator-token.ts` (mirroring `service-account.ts`):
     - `OPERATOR_TOKEN_PREFIX = "op_"`
     - `OPERATOR_TOKEN_SCOPE.MAINTENANCE = "maintenance"` (object-typed for v2 extensibility)
     - `OPERATOR_TOKEN_LAST_USED_THROTTLE_MS = 5 * MS_PER_MINUTE` (matches SA-token; Round 1 F8)
     - `OPERATOR_TOKEN_PLAINTEXT_RE = /^op_[A-Za-z0-9_-]{43}$/`
     - `OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS = 30`, `OPERATOR_TOKEN_MAX_EXPIRES_DAYS = 90`, `OPERATOR_TOKEN_MIN_EXPIRES_DAYS = 1` (Round 1 S2 — capped TTL)
     - `OPERATOR_TOKEN_NAME_MAX_LENGTH = 128` (matches schema `@db.VarChar(128)`)
     - `ADMIN_API_TOKEN_LEGACY_SUNSET = "YYYY-MM-DD"` (set at impl time per §4.6a; ≥6 months from merge)
     - `OPERATOR_TOKEN_LEGACY_AUTO_DISABLED_ROUTES = ["purge-audit-logs", "purge-history"]` (frozen array, used by §4.6b)
   - Re-export from the project's constants barrel `src/lib/constants/index.ts` if and only if other constants in the same auth subdirectory are already re-exported there (verify the existing pattern; do NOT introduce a new export style for this module alone).
   - Add `OPERATOR_TOKEN_CREATE` and `OPERATOR_TOKEN_REVOKE` to `AUDIT_ACTION` map and `AUDIT_ACTION_VALUES` in `src/lib/constants/audit/audit.ts`. Append them to `AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.ADMIN]` only (Round 2 F16: `AUDIT_ACTION_GROUPS_PERSONAL` does not have an `[ADMIN]` key, and `MASTER_KEY_ROTATION` precedent is tenant-only). Add to UI label maps and i18n keys: **`messages/en/AuditLog.json` and `messages/ja/AuditLog.json`** (top-level keys, no wrapper — Round 1 F2/T3/T11 corrected the path). Both files; see R12.
   - Add a shared test util `src/__tests__/helpers/operator-token-fixtures.ts` (Round 1 T6) exporting:
     - `makeOperatorTokenPlaintext(): string` — returns `OPERATOR_TOKEN_PREFIX + randomBytes(32).toString("base64url")`
     - `makeLegacyAdminTokenHex(): string` — returns `randomBytes(32).toString("hex")`
     The 4 new and 3 existing route tests all import from this util (no inline literal token strings).
3. **Token verifier module** — `src/lib/auth/tokens/operator-token.ts`
   - Mirror `service-account-token.ts` shape:
     ```
     validateOperatorToken(req: NextRequest): Promise<
       | { ok: true; data: { tokenId: string; subjectUserId: string; tenantId: string; scopes: readonly string[] } }
       | { ok: false; error: "INVALID_TOKEN_TYPE" | "OPERATOR_TOKEN_INVALID" | "OPERATOR_TOKEN_REVOKED" | "OPERATOR_TOKEN_EXPIRED" }
     >
     ```
     Note `scopes: readonly string[]` (parsed from CSV via a `parseOperatorTokenScopes(csv: string)` helper that mirrors `parseSaTokenScopes` — Round 1 T5). The DB column is a CSV string; the validator parses to array.
   - Use `hashToken()` for hash, `withBypassRls(prisma, ..., BYPASS_PURPOSE.TOKEN_LIFECYCLE)` for lookup.
   - Verify: token exists, not revoked, not expired. **The validator does NOT re-check OWNER/ADMIN membership** — that is the route's job. The validator returns the bound `subjectUserId` and `tenantId`; the route then calls `requireMaintenanceOperator(subjectUserId, { tenantId })`. Single check site, no duplication.
   - Throttle `lastUsedAt` write (5-minute window — `OPERATOR_TOKEN_LAST_USED_THROTTLE_MS`; fire-and-forget, swallow errors — same as SA token).
   - Export `hasOperatorTokenScope(scopes, required)` helper mirroring `hasSaTokenScope` for callers that want explicit scope checks.
   - Also export `hasAnyActiveOperatorToken(): Promise<boolean>` used by §4.6b. Implementation: `findFirst({ where: { revokedAt: null, expiresAt: { gt: new Date() } } })` via `withBypassRls(prisma, ..., BYPASS_PURPOSE.TOKEN_LIFECYCLE)` — cross-tenant lookup because the legacy hex64 caller has no tenant context. Wrapped in a **monotonic process-local latch** (Round 2 S13 — corrected from the earlier TTL-decaying design): a `let everSeenActiveToken = false` flag. While `false`, calls hit the DB with a 60-second negative-result TTL (so concurrent legacy hits during bootstrap don't all hammer the DB). Once a DB lookup returns a non-null row, `everSeenActiveToken` flips to `true` and **never flips back within the process lifetime** — subsequent calls return `true` synchronously without DB lookup. The latch only resets on process restart, which is by design.
   - Also export `_resetActiveOperatorTokenCacheForTests()` (Round 2 T14) following the precedent set by `_resetSubkeyCacheForTests()` in `src/lib/auth/session/session-cache.ts` — vitest tests that exercise this cache's behavior need a deterministic reset hook in `beforeEach`. The leading underscore matches the existing test-only-hook convention in this codebase.
4. **`verifyAdminToken` rewrite** — `src/lib/auth/tokens/admin-token.ts`
   - Change return type from `boolean` to `Promise<{ ok: true; auth: AdminAuth } | { ok: false; reason: VerifyAdminFailReason }>` where:
     ```
     type AdminAuth =
       | { kind: "legacy" }
       | { kind: "operator"; subjectUserId: string; tenantId: string; tokenId: string; scopes: readonly string[] };
     type VerifyAdminFailReason =
       | "MISSING_OR_MALFORMED"
       | "LEGACY_DISABLED_ON_ROUTE"  // §4.6b auto-disable
       | "INVALID";
     ```
     Routes do NOT consume `reason` for the response body (still returns `unauthorized()`); the field is for log/audit clarity only.
   - First try: parse `Authorization: Bearer ...` payload.
     - If `op_` prefix: delegate to `validateOperatorToken`.
     - Else if hex64 AND `process.env.ADMIN_API_TOKEN` is set: check the §4.6b per-route auto-disable (route name in `OPERATOR_TOKEN_LEGACY_AUTO_DISABLED_ROUTES` AND `hasAnyActiveOperatorToken()`); if disabled, return `{ ok: false, reason: "LEGACY_DISABLED_ON_ROUTE" }`. Otherwise run the existing SHA-256 + `timingSafeEqual` path AND emit the deprecation surface (warn log + Deprecation/Sunset response headers — see §4.6a) and return `{ kind: "legacy" }`.
     - Else: fail-closed.
   - The function takes an optional `routeName?: string` argument so the §4.6b check can identify the calling route. Each route passes its own canonical name (e.g., `"purge-audit-logs"`) at the call site.
   - Update **all 7 routes** to consume the new typed result. Per-route audit-emit table (Round 1 F9 — explicit guidance):

     | Route | Audit action | Operator path: actorType / userId | Legacy path: actorType / userId | Both add `metadata.authPath` |
     |---|---|---|---|---|
     | `/api/admin/rotate-master-key` | `MASTER_KEY_ROTATION` | `HUMAN` / `auth.subjectUserId` | `SYSTEM` / `SYSTEM_ACTOR_ID` | yes |
     | `/api/maintenance/purge-history` | `HISTORY_PURGE` | `HUMAN` / `auth.subjectUserId` | n/a (legacy auto-disabled §4.6b) | yes |
     | `/api/maintenance/purge-audit-logs` | `AUDIT_LOG_PURGE` | `HUMAN` / `auth.subjectUserId` | n/a (legacy auto-disabled §4.6b) | yes |
     | `/api/maintenance/dcr-cleanup` | `MCP_CLIENT_DCR_CLEANUP` | `HUMAN` / `auth.subjectUserId` | `SYSTEM` / `SYSTEM_ACTOR_ID` | yes |
     | `/api/maintenance/audit-outbox-metrics` | `AUDIT_OUTBOX_METRICS_VIEW` | `HUMAN` / `auth.subjectUserId` | `SYSTEM` / `SYSTEM_ACTOR_ID` | yes |
     | `/api/maintenance/audit-outbox-purge-failed` | `AUDIT_OUTBOX_PURGE_EXECUTED` | `HUMAN` / `auth.subjectUserId` | `SYSTEM` / `SYSTEM_ACTOR_ID` | yes |
     | `/api/maintenance/audit-chain-verify` | `AUDIT_CHAIN_VERIFY` | `HUMAN` / `auth.subjectUserId` | `SYSTEM` / `SYSTEM_ACTOR_ID` | yes |

     For every row: legacy path KEEPS `metadata.operatorId` from request body/query (existing untrusted contract — unchanged); operator path REPLACES it with `metadata.tokenSubjectUserId` (Round 2 F19). Round 3 F23: the `Deprecation: true` and `Sunset: <date>` HTTP response headers on the legacy path are set by the route handler (after `verifyAdminToken` returns `{ kind: "legacy" }`), not by `verifyAdminToken` itself — `verifyAdminToken` returns a typed result, not an HTTP response. Each of the 7 route handlers MUST set these headers when it sees `kind: "legacy"`. Implementation: a small `applyDeprecationHeaders(response: NextResponse)` helper exported from the constants module avoids duplication across the 7 routes.

     Each route's `requireMaintenanceOperator` call:
     - For `kind: "operator"`: call `requireMaintenanceOperator(auth.subjectUserId, { tenantId: auth.tenantId })` — note the explicit token-bound `tenantId` (Round 1 S12-A — current routes pass no tenantId option, which would resolve a multi-tenant operator's first membership). After validation, **enforce `body.operatorId === auth.subjectUserId`** (or `query.operatorId` for GET routes); reject with 400 if mismatch (Round 1 F7/S8). The audit emit uses `metadata.tokenSubjectUserId` (NOT `operatorId`) and includes `metadata.tokenId`, `metadata.authPath: "operator_token"`.
     - For `kind: "legacy"`: keep the existing body-parameter flow exactly as today. Audit emit MUST add `metadata.authPath: "legacy_env"` while keeping `userId: SYSTEM_ACTOR_ID, actorType: SYSTEM` unchanged (Round 1 F6).
   - This is an audit-attribution change, not a wire-format change. Existing scripts continue to send the same body shape (operator path additionally enforces the body operatorId equals the token's subject).
   - **No changes to `route-policy.ts`** — the 7 routes retain their existing classification (Round 1 T4); `proxy.test.ts` (which tests proxy gate behavior, not auth) keeps passing.
5. **Token-management API + UI**
   - `POST /api/tenant/operator-tokens` — body `{ name, expiresInDays, scope? }` (Zod schema with `.strict()` — rejects unknown keys including any caller attempt to inject `subjectUserId`; Round 1 S9). Server hard-codes `subjectUserId = createdByUserId = session.userId` server-side. Returns `{ id, prefix, plaintext, expiresAt, ... }` (plaintext shown ONCE; `Cache-Control: no-store` header). Zod constraints: `name` length 1-128, `expiresInDays` integer in `[OPERATOR_TOKEN_MIN_EXPIRES_DAYS, OPERATOR_TOKEN_MAX_EXPIRES_DAYS]` defaulting to `OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS`, `scope` enum (v1: only `"maintenance"`).
   - **Step-up at issuance** (Round 1 S2 + Round 2 F15/S14/T13 — auth-time source corrected): the create route requires the user's session to have been *created* within the last 15 minutes. Concrete check: look up the session row via the session-token cookie (`prisma.session.findUnique({ where: { sessionToken }, select: { createdAt: true } })`) and reject if `now - session.createdAt > 15 * MS_PER_MINUTE`. The original draft proposed `Session.expires - Session.maxAge` which Round 2 verified is wrong: `expires` is recomputed on every request by `resolveEffectiveSessionTimeouts` (`src/lib/auth/session/auth-adapter.ts`), so the subtraction drifts and never represents auth time. `Session.createdAt` is set at initial sign-in by the adapter and never updated — it is the only currently-available immutable auth-time signal in this Auth.js v5 setup. The downside (acknowledged accepted risk per Round 2 S14): "auth-time" via `createdAt` actually means "session-creation time"; a session kept alive by sliding `lastActiveAt` does not re-prove fresh authentication. The absolute-timeout cap (default 8 hours, max per `SESSION_ABSOLUTE_TIMEOUT_MAX`) bounds the worst-case staleness. A stronger model — explicit `Session.authenticatedAt` updated only on full re-authentication (passkey/OIDC challenge) — is a follow-up PR.
   - On stale-session reject, return 403 with body `{ error: "stale_session", message: "Re-authenticate within the last 15 minutes to issue an operator token." }`. The UI presents a "re-authenticate" affordance that triggers Auth.js sign-in flow without losing the form context. Rationale: a stolen 30-day session cookie that has been kept alive *but not re-authenticated* can mint an operator token only if its `createdAt` is itself within 15 minutes — which means the attacker would have had to authenticate via a primary factor (passkey or OIDC), not just possess a stolen cookie.
   - `GET /api/tenant/operator-tokens` — list (no plaintext, no hash). Scope to the authenticated user's tenant via `withTenantRls(prisma, actor.tenantId, ...)` (matches existing SCIM-tokens pattern); do NOT trust client-side filtering. The response includes `lastUsedAt` for every token in the tenant (matches existing SCIM-tokens UI behavior). Round 2 S18 noted this is a within-tenant cross-operator presence/usage disclosure; we accept it for v1 (uniformity with SCIM-tokens UI; all listees are co-OWNERs). Document as accepted disclosure in §8.
   - `DELETE /api/tenant/operator-tokens/[id]` — revoke (sets `revokedAt`, doesn't delete row). Tenant OWNER/ADMIN can revoke any token in their tenant. NO step-up required for revocation (incident-response speed > step-up friction). Per Round 2 S17, the route MUST use `withTenantRls(prisma, actor.tenantId, ...)` for the lookup AND additionally verify `token.tenantId === actor.tenantId`, returning 404 (not 403) on mismatch to avoid token-id enumeration. Mirrors `src/app/api/tenant/scim-tokens/[tokenId]/route.ts` pattern.
   - All three routes: tenant OWNER/ADMIN session auth via Auth.js (NOT `verifyAdminToken` — chicken-and-egg). Per-route rate limit:
     - create: 5/min (per-tenant key)
     - list: 30/min (per-user key)
     - revoke: 30/min (per-tenant key — Round 1 RS2 raised: a per-tenant 5/min would self-DOS during incident-response sweeps where an admin needs to revoke many tokens)
   - UI page: `/[locale]/dashboard/tenant/operator-tokens` mirroring the SCIM token UI pattern (existing reference: tenant SCIM-tokens dashboard). Plaintext shown in a one-time modal with a copy button. The page visibly shows `expiresAt`, `lastUsedAt`, and a per-row "revoke" button. Disabled-state visual cue for revoked rows (grey-out, see R26).
6. **Audit emit at create/revoke**
   - In the create route: `logAuditAsync({ action: OPERATOR_TOKEN_CREATE, actorType: HUMAN, userId: <session.userId>, metadata: { tokenId, scope, expiresAt } })`.
   - In the revoke route: same with `OPERATOR_TOKEN_REVOKE`.
7. **Operator scripts** (in scope: 3 existing scripts only)
   - Update `scripts/{purge-history,purge-audit-logs,rotate-master-key}.sh` to accept either format for `ADMIN_API_TOKEN` (hex64 OR `op_*`). Validation regex becomes `^([a-f0-9]{64}|op_[A-Za-z0-9_-]{43})$`. `OPERATOR_ID` continues to be required by the script's input validation for backward compatibility with mid-rollout servers; on operator-token paths, the server enforces `body.operatorId === auth.subjectUserId` (per §6 step 4) so the operator must pass the same UUID as the token's subject. Document this in the script's usage comment: "OPERATOR_ID must match the subject of `ADMIN_API_TOKEN` when using an `op_*` token."
   - **Out of scope for this PR (deferred to follow-up)** (Round 1 S10): adding new operator scripts (`dcr-cleanup.sh`, `audit-outbox-purge-failed.sh`, etc.). The auth-attribution refactor and shipping new operator scripts are independent concerns; bundling them dilutes the security PR's reviewability and creates an unrelated rollback baseline. The 4 routes without dedicated scripts (`dcr-cleanup`, `audit-outbox-metrics`, `audit-outbox-purge-failed`, `audit-chain-verify`) remain callable via curl with an `op_*` token; the operator runbook (`docs/operations/admin-tokens.md`, §6 step 10) documents the curl pattern for each.
8. **Tests** — see §7.
9. **OpenAPI / public API contract**
   - Update `src/lib/openapi-spec.ts` to document **only** the new `/api/tenant/operator-tokens` endpoints (POST/GET/DELETE). Decision (Round 1 F10): the 7 admin/maintenance routes are NOT added to the OpenAPI spec — they are private operator surfaces, never published, and adding them now would expand the public-API contract beyond this PR's scope. The new tenant-scoped operator-token endpoints ARE documented because they are tenant-admin surfaces consumed by the dashboard UI and may be consumed by external admin integrations.
   - Verify the existing OpenAPI tests (`src/__tests__/api/v1/openapi-json.test.ts`, `src/lib/openapi-spec.test.ts`) keep passing after the additions. Neither uses snapshot assertions, so no snapshot regen is needed (Round 1 T9).
10. **Documentation + env metadata**
    - `CLAUDE.md` admin scripts block: update with the operator-token usage example. Keep the legacy example clearly marked as "deprecated, will be removed in vX.Y".
    - `docs/operations/admin-tokens.md` (new): operator-token issuance + rotation + revocation runbook + the curl pattern for the 4 routes without dedicated scripts (per §6 step 7). Include the **Phase B self-lockout warning** (Round 2 S16): "Before unsetting `ADMIN_API_TOKEN` from production, verify that the env-schema relaxation PR has rolled out to your deployment (`src/lib/env-schema.ts:493-499` no longer makes `ADMIN_API_TOKEN` required when `SHARE_MASTER_KEY_CURRENT_VERSION >= 2`). Skipping this check while running with key-rotation enabled produces a Zod validation error at app boot, requiring re-setting the env var or rolling back to recover."
    - `.env.example`: ADMIN_API_TOKEN comment updated to "DEPRECATED: legacy admin-route auth. Prefer per-operator tokens from /dashboard/tenant/operator-tokens. This env value will be removed in a future release after the documented sunset date."
    - **NO new env var added** — the sunset date is a code-baked constant `ADMIN_API_TOKEN_LEGACY_SUNSET` (Round 1 S4). This change reverses the original draft's `ADMIN_API_TOKEN_SUNSET_DATE` env-var proposal, so there is NO update required to `src/lib/env-schema.ts` or `scripts/env-allowlist.ts`. (Round 1 F14 was conditioned on adding an env var; that condition no longer applies.) `npm run check:env-docs` should not flag drift.

## 7. Testing strategy

### Unit (vitest, mocked Prisma)

- `src/lib/auth/tokens/operator-token.test.ts` (NEW file):
  - Valid token → returns `{ ok: true, data: { tokenId, subjectUserId, tenantId, scopes: ["maintenance"] } }`. Note `scopes` is the parsed array (Round 1 T5).
  - Revoked → `OPERATOR_TOKEN_REVOKED`.
  - Expired → `OPERATOR_TOKEN_EXPIRED`.
  - Wrong prefix → `INVALID_TOKEN_TYPE`.
  - Token-not-found → `OPERATOR_TOKEN_INVALID`.
  - `lastUsedAt` throttle (positive — no update within 5 min): seed `lastUsedAt: new Date()` in mock, call validate, assert `update` was not called.
  - `lastUsedAt` throttle (positive — update fires after 5 min): use `vi.useFakeTimers()` and seed `lastUsedAt: new Date(Date.now() - 6 * 60_000)`, call validate, assert `update` WAS called (Round 1 T7). Import `OPERATOR_TOKEN_LAST_USED_THROTTLE_MS` from constants — no magic numbers in the test.
  - **Note (Round 1 T8): the validator does NOT re-check OWNER/ADMIN membership; the demoted-subject case lives in route tests, not here.**
- `src/lib/auth/tokens/admin-token.test.ts` (rewrite of existing 30-line test):
  - Legacy hex64 path with env set → `{ ok: true, auth: { kind: "legacy" } }`.
  - Legacy hex64 path with env unset → `{ ok: false, reason: "INVALID" }`.
  - Legacy hex64 path on auto-disabled route while ≥1 active OperatorToken exists → `{ ok: false, reason: "LEGACY_DISABLED_ON_ROUTE" }` (mock `hasAnyActiveOperatorToken` to return true).
  - `op_*` token, valid → `{ ok: true, auth: { kind: "operator", subjectUserId, tenantId, tokenId, scopes } }`.
  - `op_*` token, expired → `{ ok: false, reason: "INVALID" }`.
  - Empty / malformed Authorization → `{ ok: false, reason: "MISSING_OR_MALFORMED" }`.
  - Cross-format input (hex64 with `op_` prefix or vice versa) → fail-closed.
- Each of all 7 route tests gains the same three cases. Round 1 T1 flagged that 4 of 7 route test files DO NOT EXIST today (`dcr-cleanup`, `audit-outbox-metrics`, `audit-outbox-purge-failed`, `audit-chain-verify`). The plan therefore includes **creating 4 new route test files** alongside the case additions to the 3 existing ones. Per Round 2 T15 + Round 3 T21 corrections, the 4 new files share the `purge-history/route.test.ts` skeleton (env setup via `setEnv` helper, `vi.hoisted` Prisma mock factory, audit-emit assertions via `mockLogAudit`) but each route mocks a DIFFERENT Prisma surface — verified against the actual route source files in Round 3:
  - `dcr-cleanup/route.test.ts`: only `mcpClient.deleteMany` (line 56 of route — cascades via FK relations; no separate `mcpAccessToken`/`mcpRefreshToken` calls), `tenantMember.findFirst`, `auditOutbox.create` (via `logAudit`).
  - `audit-outbox-metrics/route.test.ts`: `prisma.$queryRaw` (the route uses raw SQL tagged template at line 63 — NOT `aggregate` or `groupBy`), `tenantMember.findFirst`, `auditOutbox.create`. **`$queryRaw` mock pattern**: see canonical reference `src/__tests__/audit-outbox.test.ts:20,67` (assigns `vi.fn()` directly to `$queryRaw` on the prisma mock object — bypasses the typed `MockModel` helper which does not declare `$queryRaw`).
  - `audit-outbox-purge-failed/route.test.ts`: `prisma.$queryRaw` (raw SQL at line 55 — NOT `deleteMany`), `tenantMember.findFirst`, `auditOutbox.create`. Same `$queryRaw` mock pattern as audit-outbox-metrics.
  - `audit-chain-verify/route.test.ts` (Round 2 T19 — special case): unit test mocks ONLY the auth-gate path (verify token → require operator → return 200). Do NOT mock the chain-walk logic (`auditChainEvent.findMany` ordering, hash computation). Mocking those primitives produces a hollow assertion (RT1 mock-reality divergence). The chain-walk audit-emit assertion lives in the integration test only — `audit-chain-verify-endpoint.integration.test.ts` against real DB.
  - **Round 3 T22**: the `MockModel` helper in `src/__tests__/helpers/mock-prisma.ts` does NOT type `$queryRaw` / `aggregate` / `groupBy`. The two routes using `$queryRaw` follow the existing precedent (audit-outbox.test.ts:20,67) of attaching a typed-object-bypass `vi.fn()` directly to the prisma mock. Optionally extend `MockModel` to declare these primitives in a separate refactor; not blocking for v1.

  Each new file is non-trivial — call this out as scope in the PR description.

  Three cases per route (operator-success, legacy-success-or-blocked, body-mismatch):
    - **op_ operator token, valid** → audit emitted with `actorType=HUMAN, userId=auth.subjectUserId, metadata.tokenId, metadata.tokenSubjectUserId, metadata.authPath="operator_token"`. Use **strict-shape assertion** `expect(metadata).toMatchObject({ tokenId: expect.any(String), authPath: "operator_token", tokenSubjectUserId: expect.any(String) })` AND `expect(metadata.operatorId).toBeUndefined()` (Round 1 R19 / additional note). Existing route tests use `expect.objectContaining(...)` — non-strict — so without explicit `toBeUndefined` checks, missing fields would silently pass.
    - **legacy hex64 token, env set** (only on routes NOT auto-disabled by §4.6b — i.e. `rotate-master-key`, `dcr-cleanup`, `audit-outbox-metrics`, `audit-outbox-purge-failed`, `audit-chain-verify`) → audit emitted with `actorType=SYSTEM, userId=SYSTEM_ACTOR_ID, metadata.authPath="legacy_env"`, `metadata.tokenId` undefined, `metadata.tokenSubjectUserId` undefined, deprecation log line emitted, response carries `Deprecation: true` header. **Round 2 T20**: the legacy assertion MUST include `expect(metadata.tokenId).toBeUndefined()` AND `expect(metadata.tokenSubjectUserId).toBeUndefined()` — without these explicit `toBeUndefined` checks, a regression that wrongly emits these fields on legacy would silently pass through `expect.objectContaining(...)`.
    - **`purge-history` and `purge-audit-logs` only**: legacy hex64 token while an active OperatorToken exists → 401, `metadata.authPath` not emitted (no audit on auth failure today; this matches existing behavior).
    - **body operatorId mismatch on operator path** → 400 (Round 1 F7/S8 — the route enforces `body.operatorId === auth.subjectUserId`).
    - **body operatorId mismatch on legacy path** → reject per existing legacy contract (operatorId must be a valid active admin UUID; existing tests already cover this).
    - **demoted subject** (Round 1 T8): mock `requireMaintenanceOperator` to return `{ ok: false }` → route returns 400. This case lives at the route level, not in `operator-token.test.ts`.
- Test mock alignment (R19): when `validateOperatorToken` is added, every `vi.mock("@/lib/auth/tokens/admin-token", ...)` and `vi.mock("@/lib/auth/tokens/operator-token", ...)` block in route tests must be consistent. Affected files: 7 route test files + `proxy.test.ts:852` (existing `ADMIN_API_TOKEN` reference; this proxy test should keep passing — Round 1 T4 — because `route-policy.ts` is unchanged).
- New token-management API tests (`/api/tenant/operator-tokens` create/list/revoke):
  - Create with stale session (`session.createdAt` > 15 min ago) → 403 `stale_session` (Round 1 S2 + Round 2 F15/S14/T13). Test plumbing: seed Prisma mock to return `Session.findUnique → { createdAt: 16 minutes ago }`. The mock-shape is testable (Round 2 T13 was concerned about Auth.js v5 not exposing `createdAt`; the route reads it via direct Prisma lookup, so the test just mocks Prisma).
  - Create with `subjectUserId` injected in body → 400 (Zod `.strict()` rejects unknown keys; Round 1 S9).
  - Create with `expiresInDays` outside `[1, 90]` → 400.
  - Audit emission on create → `OPERATOR_TOKEN_CREATE` with `actorType=HUMAN`.
  - Revoke success → 200, audit emission `OPERATOR_TOKEN_REVOKE`.
  - Revoke cross-tenant `[id]` (Round 2 S17) → 404 (not 403; tenant lookup miss).
  - List excludes plaintext and hash; includes `lastUsedAt`, `expiresAt`, `revokedAt`, `name`, `prefix` (Round 2 S18).
- Token-fixture util tests: `makeOperatorTokenPlaintext()` returns matching `OPERATOR_TOKEN_PLAINTEXT_RE`; `makeLegacyAdminTokenHex()` returns 64-hex (Round 1 T6).
- Sunset constant regression test (Round 2 S15) — `src/lib/constants/auth/operator-token.test.ts`:
  - `expect(ADMIN_API_TOKEN_LEGACY_SUNSET).toMatch(/^\d{4}-\d{2}-\d{2}$/)` — format guard.
  - `expect(new Date(ADMIN_API_TOKEN_LEGACY_SUNSET).getTime()).toBeGreaterThan(Date.now())` — must be in the future as of test run time. (Will fail naturally once the date passes, signalling that Phase B work is overdue.)
  - `expect(new Date(ADMIN_API_TOKEN_LEGACY_SUNSET).getTime()).toBeGreaterThanOrEqual(new Date("YYYY-MM-DD").getTime())` where `YYYY-MM-DD` is the v1 merge date + 6 months. Forces any PR that shortens the deprecation window to also touch this test, surfacing the change in code review (matches Round 2 S15 rationale).

### Integration (real Postgres via `npm run test:integration`)

Round 1 T2 corrected the original draft: there is NO HTTP-running-app harness in this repo. `src/__tests__/db-integration/*-endpoint.integration.test.ts` files import each route handler module and call its exported `POST(req)` / `GET(req)` function with a constructed `NextRequest`, against a real test database via Prisma. The integration tests in this plan follow that pattern. Canonical reference (Round 2 T16): `src/__tests__/db-integration/audit-outbox-metrics-endpoint.integration.test.ts` (or whichever existing endpoint integration test happens to call `POST(req)` / `GET(req)` directly — confirm during impl). Construction shape: `new NextRequest("http://localhost/api/...", { method, headers, body })`, the same pattern unit tests use (`purge-history/route.test.ts:81-86`).

- `src/__tests__/db-integration/operator-token-validate.integration.test.ts` (NEW):
  - Insert a real `OperatorToken` row via Prisma → construct `NextRequest` with the matching plaintext → import and call `validateOperatorToken(req)` → assert `{ ok: true, data: ... }`.
  - Revoke the row (`UPDATE operator_tokens SET revoked_at = NOW()`) → next call returns `OPERATOR_TOKEN_REVOKED`.
  - Insert with `expires_at < NOW()` → returns `OPERATOR_TOKEN_EXPIRED`.
  - Insert with `subject_user.deactivated_at` set → assert validator still returns `ok: true` (the validator does not check membership; route does — Round 1 T8). A separate integration case at the route handler level then asserts the route's 400 response.
- `src/__tests__/db-integration/admin-token-routes.integration.test.ts` (NEW):
  - Mint operator token + import route handler → call `POST(req)` with token → assert 200 + audit row in `audit_logs` with `actor_type='HUMAN'`.
  - Same with legacy `ADMIN_API_TOKEN` env (set in test setup) on a non-auto-disabled route → assert 200 + audit row with `actor_type='SYSTEM'` + `metadata.authPath='legacy_env'`.
  - On `purge-audit-logs`: mint operator token (any tenant) → legacy call returns 401 (auto-disabled per §4.6b).
- TOCTOU regression case (Round 1 R5 / Round 1 T12-A — best-effort, NOT determinism proof): `Promise.all` of two `POST(req)` calls — one valid, one with a token that gets revoked between the call and validate. Document explicitly: "this test is a probabilistic regression check; race timing is non-deterministic in vitest. The accepted-risk decision in §8 stands regardless of test outcome."
- §4.6b monotonic latch behavior (Round 2 S13/T14 — corrected from earlier TTL-decay test): in `beforeEach`, call `_resetActiveOperatorTokenCacheForTests()` to reset the latch to `false`. Then assert:
  1. With no rows: `hasAnyActiveOperatorToken()` returns `false`; second immediate call returns `false` (negative cache hit, no DB query).
  2. Insert a row: after at most one DB-lookup interval (`vi.useFakeTimers()` to advance past the 60s negative TTL), `hasAnyActiveOperatorToken()` returns `true`.
  3. Delete that row: subsequent calls **still return `true`** (monotonic latch). This is the regression case that asserts S13 — the legacy path stays disabled after the first issuance, regardless of later token churn.
  4. After `_resetActiveOperatorTokenCacheForTests()`: latch flips back to `false` (test plumbing only).
- Audit-action exhaustive coverage:
  - `src/__tests__/audit-i18n-coverage.test.ts` (existing): adding the two new actions without locale entries causes hard failure. Verify both `messages/en/AuditLog.json` and `messages/ja/AuditLog.json` are updated together — not separately (Round 1 F2/T3/T11).
  - `src/lib/constants/audit/audit.test.ts` (existing): `AUDIT_ACTION_VALUES` and the per-scope group invariants will fail if the new actions aren't registered. Verify both PERSONAL[ADMIN] and TENANT[ADMIN] are updated.

### CI

- The integration test already runs in CI (per `package.json` `test:integration` script).
- **No separate "smoke-test workflow" added** — Round 1 T10 flagged the original draft's CI-smoke-test claim as vague. The route-handler integration tests above cover the create+use flow; a separate workflow would be redundant infrastructure.

### Pre-PR

- `scripts/pre-pr.sh` (per `feedback_run_pre_pr_before_push.md`) is mandatory before PR open.

## 8. Considerations & constraints

### Risks / known issues

- **Bootstrap chicken-and-egg**: the very first operator token must be issued via session-authed UI; an operator who has lost session access AND has no existing `ADMIN_API_TOKEN` is locked out. Mitigation: `ADMIN_API_TOKEN` remains the break-glass during Phase A and Phase B; Phase C only proceeds after operators confirm session auth recovery is reliable.
- **TOCTOU window between role check and privileged write** (acknowledged accepted risk):
  - Worst case: an admin demoted from OWNER/ADMIN at time T0 sends an in-flight request that arrives at T0−ε; `requireMaintenanceOperator` reads the (still-OWNER) membership row at T0+δ (after demotion has committed) but before the demote propagates to the worker process; the request executes a privileged purge.
  - Likelihood: **low** — requires the attacker to retain a valid token AND have a request in flight at the exact moment of demotion; rate limit is 1/min for destructive routes (`max: 1, windowMs: 60_000`); the entire route handler completes in well under that window.
  - Cost to fix to *zero*: would require a `SERIALIZABLE` isolation transaction that wraps both the membership check and every DB write inside the route — a substantial refactor of all 7 routes; risk of new deadlocks under load.
  - Decision: accept the risk for v1. **Practical observability**: polling-for-window attempts are visible in audit logs because every attempt while still OWNER produces an audit row (success or rate-limit reject) bound to `subjectUserId` and `tokenId`; SIEM rules can flag a high frequency of attempts from a single subject as a precursor signal (Round 1 S6). Document in the runbook that demotion of a privileged operator should be followed by explicit token revocation (one-click in the UI).
- **Plain SHA-256 (no pepper) for the highest-privilege token type** (acknowledged accepted risk; Round 1 S3):
  - Worst case: a database-only compromise (backup leak, read-only SQLi, DBA insider) leaks the `tokenHash` column; if the attacker also obtains a candidate plaintext through a separate channel (env file dump, CI log), they can confirm the match offline and use the token while it remains active.
  - Likelihood: **low** — 32-byte plaintext entropy makes brute-force search infeasible; the attack requires an independent plaintext leak to be useful.
  - Cost to fix: HMAC-SHA256 with a server-side pepper (e.g., HKDF from `MASTER_KEY_HEX`) is a 1-day implementation that diverges from the four existing token tables (`ServiceAccountToken`, `ApiKey`, `McpAccessToken`, `ExtensionToken`) which all use plain `hashToken()`. Diverging now would create a multi-table consistency debt.
  - Decision: accept plain SHA-256 for uniformity with the existing pattern. v2 can introduce a project-wide token-hash uniformization (HMAC pepper across all five tables) as a separate, scoped refactor. The honest cost framing per "no false technical justification": this is *defense-in-depth*, not closing a known feasible attack — entropy alone makes the existing pattern sound.
- **`prefix` UI display: 5 entropy chars** (acknowledged accepted risk; Round 1 F11-A):
  - The `prefix` column stores the first 8 chars of the plaintext (`op_` + 5 base64url chars). Per-tenant collision space is `64^5 ≈ 10^9`; for a tenant with up to ~10 tokens, the birthday-collision probability is ~5×10⁻⁸. Acceptable for human-disambiguation purposes (matches the existing `ServiceAccountToken.prefix @db.VarChar(8)` pattern).
  - Decision: accept; matches existing pattern; collision probability negligible at expected operator-count scale.
- **Single-tenant-instance assumption**: the deployment topology (one Next.js + one Postgres + one Redis) does not currently distribute the verifier across nodes; if that changes, `lastUsedAt` writes contend per-token. Out of scope.
- **Operator scope creep**: §4.4 explicitly defers per-route scopes. If during review someone argues for them now, push back: pre3 is about *who* can act, not about *what* slice of admin power they hold. Reject scope-bleed; keep KISS.

### Recurring-issue checks (R1–R30, RS1–RS3, RT1–RT3) — full sweep at this draft

Carried out by the plan author in advance of expert sub-agent review (sub-agents will repeat this list and may flag additional findings):

- **R1 / R17 / R22 (helper reuse + adoption + perspective inversion)**: New verifier mirrors `service-account-token.ts`. We use the existing `hashToken()`, `withBypassRls()`, `requireMaintenanceOperator()`, `createRateLimiter()`, `parseBody()`, `unauthorized()`, `rateLimited()`. No duplication; no new helper that already exists. After implementation, sweep all `verifyAdminToken` call sites and confirm every one is migrated to the new typed return.
- **R2 (constants hardcoded)**: `OPERATOR_TOKEN_PREFIX`, `OPERATOR_TOKEN_SCOPE.MAINTENANCE`, `OPERATOR_TOKEN_LAST_USED_THROTTLE_MS` go in a constants module; the route regex `^op_[A-Za-z0-9_-]{43}$` is exported.
- **R3 (incomplete propagation)**: enumerate every `verifyAdminToken` consumer (7 routes today; sub-agents to verify by `grep -rn "verifyAdminToken"`).
- **R4 (event dispatch gaps)**: token mint/revoke fires `logAuditAsync` (audit dispatch is automatic via outbox); webhook dispatch follows automatically. New audit actions live in `AUDIT_ACTION_GROUPS_TENANT[ADMIN]`, which is already a member of `TENANT_WEBHOOK_EVENT_GROUPS` — existing webhook subscribers to the `group:admin` topic receive token issuance/revocation events without further config.
- **R5 (transactions)**: token issuance is a single insert; no read-then-write race. Token verification is a `findUnique` then a `lastUsedAt` update — `lastUsedAt` is fire-and-forget, race is benign.
- **R6 (cascade orphans)**: cascades on tenant/user — there is no external blob storage for tokens, so no orphan risk.
- **R7 (E2E selectors)**: new UI page; no existing selectors changed.
- **R8 (UI consistency)**: tenant operator-tokens page mirrors the existing SCIM-tokens page styling.
- **R9 (fire-and-forget in tx)**: `lastUsedAt` write is fire-and-forget but is launched OUTSIDE any tx (matches SA-token implementation).
- **R10 (circular imports)**: new `operator-token.ts` imports from `prisma`, `crypto-server`, `tenant-rls`, `constants/auth/operator-token`. None of those import back. New constants file imports nothing. Verified mentally; reviewer to grep.
- **R11 (display vs subscription group)**: the new audit actions live in `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` (display) and via that mapping inherit `TENANT_WEBHOOK_EVENT_GROUPS[ADMIN]` (subscription). Both surfaces converge on the same group definition; no display-vs-subscription divergence.
- **R12 (enum/action group coverage gap)**: every site enumerated (Round 1 F2/T3/T11 corrected i18n path; Round 2 F16 corrected group placement):
  - `src/lib/constants/audit/audit.ts` — `AUDIT_ACTION` map + `AUDIT_ACTION_VALUES` array + `AUDIT_ACTION_GROUPS_TENANT[AUDIT_ACTION_GROUP.ADMIN]` only (peer group to `MASTER_KEY_ROTATION` / `AUDIT_LOG_PURGE` / `HISTORY_PURGE`). NOT `AUDIT_ACTION_GROUPS_PERSONAL` (no `[ADMIN]` key exists there), NOT `AUDIT_ACTION_GROUPS_TEAM` (tenant-scoped, not team-scoped).
  - Prisma `AuditAction` enum (in `schema.prisma`) — added in the single migration per §5.2 (Round 2 F17 collapsed the two-file split)
  - `messages/en/AuditLog.json`, `messages/ja/AuditLog.json` (top-level keys, no wrapper) — both files
  - `src/__tests__/audit-i18n-coverage.test.ts` — will hard-fail until both locale files updated
  - `src/lib/constants/audit/audit.test.ts` — exhaustive-list invariants for `AUDIT_ACTION_VALUES` and per-scope group membership
  - `src/lib/openapi-spec.ts` if it references audit actions (verify during impl; per §6 step 9 the maintenance routes are NOT documented in OpenAPI, but operator-token CRUD is — verify whether the audit-action enum is exposed there)
  - any UI label map in `src/components/audit/`
- **R13 (re-entrant dispatch)**: `OPERATOR_TOKEN_CREATE/REVOKE` are normal audit emissions; they do NOT trigger token issuance, so no loop risk. Token-use audit events were already non-re-entrant.
- **R14 (DB role grants)**: `passwd_app` needs SELECT/INSERT/UPDATE on `OperatorToken`. The migration includes those grants. `passwd_outbox_worker` does NOT need access (token table is not in its scope).
- **R15 (hardcoded env values in migration)**: grant statements use role names which are environment-stable (`passwd_app`); no hostnames, DB names, or other env-specific values.
- **R16 (dev/CI parity)**: the new role grant is part of the migration and applies in both dev (`passwd_user` superuser runs the migration) and CI; no implicit privilege divergence.
- **R18 (allowlist sync)**: no privileged-op file allowlist gates `OperatorToken` access — N/A. Original draft proposed a new env var `ADMIN_API_TOKEN_SUNSET_DATE` (would have triggered env-schema/allowlist updates) but Round 1 S4 replaced it with a code-baked constant; no env-schema or env-allowlist changes are introduced by this plan.
- **R19 (test mock alignment + exact-shape assertions)**: existing route tests mock Prisma via `vi.fn()`; adding the new model means adding a `mockOperatorTokenFindUnique` stub. Exact-shape: route tests that compare audit metadata literals MUST add `tokenId` and `authPath` fields, otherwise the assertions stale-pass. Sub-agent verifies.
- **R20 (mechanical edits)**: the migration is hand-written; the route updates are typed (TS would fail compile if we miss a callsite). No mechanical bulk insert.
- **R21 (subagent verification)**: applies in Phase 2 (coding), not Phase 1.
- **R23 / R26 / R27 / R28 (UI specifics)**: applies to operator-token UI page; standard form patterns; numeric range (TTL min/max) drawn from constants and interpolated into i18n strings, NOT hardcoded.
- **R24 (additive-then-strict migration)**: this migration is *purely additive* (new table, new enum values, new grants). No nullable→required transition. R24 N/A in the additive/strict sense. The migration ships as a **single file** matching existing repo precedent (Round 2 F17 corrected the original Round-1 F4 mistake — Postgres 16 + this codebase support `ALTER TYPE ADD VALUE` inside transactions; see §5.2).
- **R25 (persist/hydrate symmetry)**: only persisted state is the DB row. Token plaintext is never re-hydrated (one-time view at creation). No symmetry gap.
- **R29 (external spec citations)**: this plan cites no RFC / NIST / OWASP / W3C section. The pre3-prompt mentioned "OAuth 2.1 / RFC 7519 / NIST SP 800-63B-4 etc citation accuracy" — that obligation only applies if the implementation cites them. Since we explicitly reject options (a)–(c) (which would have required JWT or PKI citations), the v1 implementation contains no spec citations. Reviewer to confirm by greping the final implementation.
- **R30 (Markdown autolink footguns)**: this plan and the pre3 prompt mention "PR #400 / #401 / #402 / #404 / #406 / #407". On GitHub-flavored Markdown rendering (e.g., when this doc shows up in PR description / preview), bare `#NNN` autolinks. They are intended links here, so leave them as-is. No `@` mentions or commit-SHA shapes appear in this doc.
- **RS1 (timing-safe)**: legacy path keeps `timingSafeEqual`; new path uses Prisma `findUnique({ where: { tokenHash } })` which is constant-time-equivalent against the threat model (an attacker cannot mount a timing oracle against a SHA-256 hash lookup with 32-byte preimage entropy in any feasible scenario).
- **RS2 (rate limit on new routes)**: token CRUD routes get rate limiters (5/min create, 30/min list, 5/min revoke).
- **RS3 (input validation)**: Zod schemas at the boundary for token-CRUD body/query — `name` length-capped, `expiresInDays` range-checked, `scope` enum-validated.
- **RT1 (mock-reality divergence)**: the operator-token mock returns the exact shape `validateOperatorToken` produces (drilled into the test file).
- **RT2 (testability)**: every claim in §7 is testable with current infra; no mocks of un-mockable primitives.
- **RT3 (shared constants in tests)**: the test fixtures import `OPERATOR_TOKEN_PREFIX` and `OPERATOR_TOKEN_LAST_USED_THROTTLE_MS` from the constants module; no inline duplication.

## 9. User operation scenarios

### Scenario A — first-time bootstrap (legacy → operator token)

1. Tenant OWNER `alice@example.com` is logged into the dashboard.
2. She visits `/dashboard/tenant/operator-tokens`.
3. She clicks "Create token", names it `"alice laptop, ngc-shj, 2026-04-27"`, picks 90 days, scope `maintenance`.
4. The dialog shows the plaintext `op_AbCd...` once — she copies it into her local password manager and into `~/.ngc-shj/.env.maintenance` as `ADMIN_API_TOKEN=op_AbCd...`.
5. Closes the dialog. Token now appears in the list (without plaintext) with `lastUsedAt: null`, `expiresAt`, prefix.
6. Source-loads the new env file and runs `scripts/purge-history.sh DRY_RUN=true`.
7. Server: `verifyAdminToken` sees `op_*` prefix, looks up the row, verifies subject is active OWNER, returns `{ kind: "operator", subjectUserId: alice.id, tenantId: alice.tenantId, tokenId }`. Route ignores body `operatorId`, audits with `actorType: HUMAN, userId: alice.id, authPath: "operator_token"`.
8. Alice sees the audit log entry under her own name, not "SYSTEM."

### Scenario B — operator demotion mid-token-life

1. Alice mints a token, then is demoted from OWNER to MEMBER by another OWNER (TENANT_ROLE_UPDATE audit emitted).
2. Alice's token is **not** automatically revoked at the database row level.
3. The next time she runs a script using the token: `validateOperatorToken` re-checks `requireMaintenanceOperator(alice.id, { tenantId })` → fails (no active OWNER/ADMIN membership) → returns `{ ok: false }` → 401.
4. The token row remains; if Alice is later re-promoted, the same token starts working again. If desired, the re-promoting OWNER can revoke the token explicitly first.
5. Edge case: if the demotion happened *during* an in-flight request (TOCTOU window between request arrival and `requireMaintenanceOperator` lookup), the request may complete. The window is bounded by request handler duration (sub-second for these routes). Accepted risk; documented; the alternative — coupling demotion to a token-revoke transaction — is over-engineered for an admin/admin trust boundary.

### Scenario C — token leak

1. Alice's `op_*` token is leaked (laptop stolen, env file in a public repo, etc.).
2. Bob (another OWNER in the same tenant) revokes it via `DELETE /api/tenant/operator-tokens/[id]` (or via UI).
3. `revokedAt` is set; `OPERATOR_TOKEN_REVOKE` audit emitted with `actorType: HUMAN, userId: bob.id, metadata: { tokenId, revokedSubjectUserId: alice.id }`.
4. Any further use of the token returns 401. The compromise blast radius is limited to whatever the attacker did before the revoke (visible in the audit log; the events bear `userId: alice.id, tokenId`).
5. Alice mints a new token; rotation has no impact on Bob or other operators.

### Scenario D — cron / CI usage

1. CI workflow `nightly-dcr-cleanup.yml` runs daily.
2. It exports `ADMIN_API_TOKEN` from a GitHub Actions secret — value is an `op_*` token bound to a dedicated "ops automation" user account in the tenant (this user is OWNER, deactivatedAt: null, exists solely for automation).
3. Token TTL is 365 days; rotation is a yearly secret-rotation chore.
4. If the automation token leaks, revoking ONE token disables only the CI pipeline, not human operators.
5. Out-of-scope but worth noting: the long-term ergonomic answer for automation is service accounts (existing `sa_` tokens). For the *7 maintenance routes* specifically, we keep the same `op_*` shape for everyone (humans + cron) for simplicity in v1.

### Scenario E — Phase B cutover

1. Operator confirms via audit log that no `authPath: legacy_env` events have occurred for ≥30 days.
2. Operator unsets `ADMIN_API_TOKEN` from production environment.
3. Any leftover script invocation that still has the legacy hex64 fails with 401. Operator updates the script's env.
4. Phase B is complete; legacy code path remains as dead code until Phase C deletes it.

## 10. Open design questions for review

All Round 1 items have been resolved:

- Q-1: ~~subjectUserId vs createdByUserId~~ **Resolved in §6 step 5**: the create route hard-codes `subjectUserId = createdByUserId = session.userId`; the request body is `.strict()` and rejects any caller-supplied `subjectUserId`. Tested explicitly (Round 1 S9).
- Q-2: ~~legacy operatorId requirement during Phase A~~ **Resolved in §6 step 4**: legacy path keeps the existing operatorId validation contract unchanged; operator path additionally enforces `body.operatorId === auth.subjectUserId` (Round 1 F7/S8) so the field can never silently disagree with the token.
- Q-3: ~~validator OWNER/ADMIN re-check~~ **Resolved in §6 step 3**: the validator does NOT re-check membership; it only verifies token existence/expiry/revocation. The OWNER/ADMIN check stays at the route boundary via `requireMaintenanceOperator`. Single source of truth.
- Q-4: ~~`OPERATOR_TOKEN_USE` audit action~~ **Resolved in §4.7**: per-route audit + `tokenId`/`tokenSubjectUserId`/`authPath` metadata is sufficient; a USE action would double-log.
- Q-5: ~~Family-based rotation absence~~ **Resolved in §4.3**: human-driven mint→swap→revoke is fine for ≤dozens of operators; family rotation is for automated refresh chains and is deferred to v2 if/when needed.

No open questions remain for v1. Any further design changes should ship as their own scoped PR.

---

End of plan. Phase 1 review iterates until all expert findings are resolved or accepted-with-justification.
