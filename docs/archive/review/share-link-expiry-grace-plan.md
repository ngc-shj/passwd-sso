# Plan: share-link-expiry-grace

## Project context

- Type: web app (Next.js) + separate retention-gc worker process
- Test infrastructure: unit + integration (real-DB, `npm run test:integration`) + E2E + CI/CD
- Verification environment constraints:
  - VE1: real-DB integration tests require stopping `audit-outbox-worker` and
    `retention-gc-worker` (CLAUDE.md); CI runs no worker alongside. `verifiable-local`.
    No blocked-deferred paths.

## Objective

Records whose UI renders an "expired" state must stay visible for a grace period. Today the
retention-gc worker hard-deletes them on the first sweep after expiry, so that UI state is
unreachable. Reported instance: a user's two 1-hour entry shares vanished from the share menu
~1h20m after expiry.

## Background — the defect class

Defining primitive: a `RETENTION_REGISTRY` entry (`src/workers/retention-gc-worker/registry.ts`)
that deletes on `cutoffColumn < now()` (no `retentionDays`) for a table whose rows a UI lists
with an **expired** status.

Derivation (R42):
1. Registry entries with an expiry cutoff:
   `node -e 'const s=require("fs").readFileSync("src/workers/retention-gc-worker/registry.ts","utf8");const r=/kind: "([A-Z_]+)",\s*\n\s*table: "([a-z_]+)",\s*\n\s*cutoffColumn: "([a-z_]+)"/g;let m;while((m=r.exec(s)))console.log(m[1],m[2],m[3])'`
   → 18 entries of kind `EXPIRY` / `EXPIRY_GUARDED` / `EXPIRY_AUDIT_PROVENANCE` (plus 5 `PER_TENANT_AGE`, out of class).
2. UI rendering an expired state:
   `grep -rnE 'expired|Expired|EXPIRED' src/components src/app --include='*.tsx' | grep -v '\.test\.'`,
   each traced to its list API's `findMany` filter.

| Table | Expired-state UI | List keeps expired? | Member? |
|---|---|---|---|
| `password_shares` | `/dashboard/share-links` filter "expired" + badge; `share-dialog.tsx` badge; `/s/[token]` `reason="expired"` | yes (`/api/share-links/mine` `status=expired`) | **yes** |
| `api_keys` | `api-key-manager.tsx` status `expired` | yes (`where: { userId }`) | **yes** |
| `operator_tokens` | `operator-token-card.tsx` status `expired` | yes (`where: { tenantId }`) | **yes** |
| `personal_log_access_grants` | `breakglass-grant-list.tsx` `GRANT_STATUS.EXPIRED` | yes (server-computed status) | **yes** |
| `admin_vault_resets` | `tenant-reset-history-dialog.tsx` `RESET_STATUS.EXPIRED` | yes (history `findMany`) | **yes** |
| `access_requests` | `access-request-card.tsx` | yes | already fixed (`retentionDays: 7`, M2) |
| `emergency_access_grants` | no expired state; REVOKED/REJECTED are terminal, not expiry | — | no — SC1 |
| `team_invitations` | none (GET returns PENDING only, shows "expires at") | — | no — SC2 |
| `service_account_tokens` | none | — | no |
| `extension_tokens` | sessions list filters `expiresAt > now` | no | no |
| `master_key_rotations`, `sessions`, `verification_tokens`, bridge codes, MCP codes/tokens, `mcp_clients` | none (delegation "expired" is a client countdown of a live session) | — | no |

## Requirements

- R-F1: Each member row stays readable by its list UI for 30 days after `expires_at`, then is
  purged exactly as today (provenance audit before delete, cascades unchanged).
- R-F2: Retained expired rows must not consume caps or block re-creation (C3).
- R-NF1: Retained expired rows never authenticate, authorize, decrypt, or execute (C2).
- Grace: 30 days for all five members (user decision 2026-11-11 for shares, applied uniformly
  so one number governs the "expired list" UX). `access_requests` keeps 7 (SC3).
- The grace is a UI-visibility window, not forensic retention — provenance at purge is permanent.

## Technical approach

Reuse `AuditProvenanceEntry.retentionDays`: `sweepAuditProvenanceEntry` applies
`cutoffColumn < now() - ($2 || ' days')::interval`, binding the days as a parameter
(`sweep.ts`, SQL shape pinned by `sweep-sql.test.ts`). No new sweep kind, schema change,
or migration.

## Contracts

### C1 — Registry grace for the five members

- Export one constant from `registry.ts`: `EXPIRED_RECORD_VISIBILITY_GRACE_DAYS = 30`.
- Set `retentionDays: EXPIRED_RECORD_VISIBILITY_GRACE_DAYS` on `password_shares`, `api_keys`,
  `operator_tokens`, `personal_log_access_grants`, `admin_vault_resets`. The cutoff column stays `expires_at`.
- Comment once at the constant: UI-visibility grace, not forensic retention.
- A revoked row was already retained until `expires_at`. It now stays until `expires_at + 30d`
  and is shown as revoked.
- Invariants. Both are app-enforced by the sweep, because a time-based purge has no schema-enforced form.
  - INV1: a member row with `expires_at >= now() - 30d` is never deleted by retention-gc.
  - INV2: a member row with `expires_at < now() - 30d` is deleted with provenance in the same tx.
- Control class: this is a retention parameter, not a guard, so R49 does not apply.
- Forbidden pattern: `retentionDays: 30` — reason: use the constant, and never repeat the literal (RT3).
  It is enforced by a `registry.test.ts` case asserting that exactly the five member tables carry
  `retentionDays === EXPIRED_RECORD_VISIBILITY_GRACE_DAYS`. The check is set equality, so a member losing
  the grace and another table gaining it both fail.
- Acceptance:
  - Regenerate `docs/security/deletion-retention-matrix.md` with `npm run generate:security-matrices` and commit it.
  - It shows `retentionDays: 30 (grace window before purge)` on the five rows.
  - `npm run check:security-matrices` and `scripts/__tests__/generate-security-matrices.test.mjs` pass.
- Consumer walkthroughs. The shape consumed is the persisted row's lifetime; no fields change.
  - `/api/share-links/mine` reads `{expiresAt, revokedAt}` for the `status=expired` filter and for `isActive`.
    It is cursor-paged, so retained rows do not crowd out live ones.
  - `share-links/page.tsx` and `share-dialog.tsx` read `{isActive, revokedAt}` and render the badge.
  - `/s/[token]/page.tsx` reads `{expiresAt}` and renders `reason="expired"` instead of not-found.
    This leaks nothing to anyone without the 256-bit token.
  - `/api/share-links/[id]/access-logs` returns the child logs. They now survive with the parent and
    are still trimmed independently by `shareAccessLogRetentionDays`.
  - `api-key-manager.tsx` and `operator-token-card.tsx` read `{expiresAt, revokedAt}` to derive the status.
  - `breakglass-grant-list.tsx` reads the server-computed `status`. The list is capped at 200
    (`BREAKGLASS_USER_LIST_LIMIT`); 24-hour grants over 30 days do not reach the cap in practice.
  - `tenant-reset-history-dialog.tsx` reads the server-computed status.

### C2 — Expired rows stay inert (verification gate, verified in Round 1)

- Invariant (universal, R42): every path that authenticates with, authorizes by, decrypts, or
  executes a member row rejects expired and revoked rows.
- Member set:
  - Derived by `grep -rnE '(passwordShare|apiKey|operatorToken|personalLogAccessGrant|adminVaultReset)\.(find\w*|update\w*|count|aggregate|upsert|delete\w*)\(' src --include='*.ts' | grep -v '\.test\.'`.
  - Raw SQL on these tables was also checked; the only raw UPDATEs are in the share content/download routes, and both re-assert `revoked_at IS NULL AND expires_at > now()`.
  - Result: every gating member is fail-closed.
    - Shares: `/s/[token]` page, `/s/[token]/download`, `/api/share-links/[id]/content`, `/api/share-links/verify-access`.
    - Token validators: `lib/auth/tokens/api-key.ts`, `lib/auth/tokens/operator-token.ts`.
    - `breakglass/[id]/logs`.
    - Admin reset: `vault/admin-reset` (CAS `expiresAt > now`) and `reset-vault/[resetId]/approve` (CAS `expiresAt > now`).
  - Mutators narrow only, behind `revokedAt: null`: `user-session-invalidation.ts`, `auth.ts` tenant move, and master-key-rotation share revocation.
  - Counters are count-only (C4).
- Control class: `fail-closed verification gate` per route. Adjudication authority: the DB timestamp vs the server clock at request time.
- No code change.
- Deny-side test obligation: Phase 2 fills this checklist (test file and test name, or "added"),
  one row per gate. The contract is not done while a row is empty.

  | Gate | Expired-row deny test |
  |---|---|
  | `/s/[token]/page.tsx` | added: `src/app/s/[token]/page.test.tsx` — "renders the expired error, not the content, for an expired unrevoked share" |
  | `/s/[token]/download/route.ts` | existing: `src/__tests__/api/s/download.test.ts` — "returns 410 for expired share" |
  | `/api/share-links/[id]/content` | existing: `src/app/api/share-links/[id]/content/route.test.ts` — "returns 404 when share is expired" (and `src/__tests__/api/share-links/content.test.ts` — "returns 404 for expired share") |
  | `/api/share-links/verify-access` | existing: `src/app/api/share-links/verify-access/route.test.ts` — "returns 404 when share is expired" |
  | `lib/auth/tokens/api-key.ts` | added: `src/lib/auth/tokens/api-key.test.ts` — "rejects an expired, unrevoked key with API_KEY_EXPIRED before the membership lookup" |
  | `lib/auth/tokens/operator-token.ts` | existing: `src/lib/auth/tokens/operator-token.test.ts` — "returns OPERATOR_TOKEN_EXPIRED when expiresAt is in the past" |
  | `/api/tenant/breakglass/[id]/logs` | existing: `src/app/api/tenant/breakglass/[id]/logs/route.test.ts` — "returns 403 when grant has expired" (and `src/__tests__/api/tenant/breakglass-logs.test.ts` — "returns 403 for expired grant") |
  | `/api/vault/admin-reset` | existing: `src/app/api/vault/admin-reset/route.test.ts` — "returns 410 when token is expired" |
  | `reset-vault/[resetId]/approve` | added: `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/approve/route.test.ts` — "returns 409 RESET_NOT_APPROVABLE for an expired, unrevoked reset, which the CAS refuses via expiresAt > now" |

### C3 — Caps and duplicate checks ignore expired rows

Member set: the `count` / `findFirst` / `findMany`-for-dedup callers from the C2 grep.
- `src/app/api/api-keys/route.ts` `MAX_API_KEYS_PER_USER` currently counts `{ userId, revokedAt: null }`, which
  includes expired keys. Change it to add `expiresAt: { gt: now }`, which agrees with `api-key.ts`
  rejecting at `expiresAt <= now`. The column is NOT NULL.
- `src/__tests__/db-integration/count-then-create-toctou.integration.test.ts` re-implements that count
  in SQL. Update its predicate to `AND expires_at > now()` so the race test models the cap the route enforces.
  Add a case that seeds one expired unrevoked key plus cap−1 live keys and asserts the count is below the
  cap; it is red against the old predicate. The SQL copy stays a twin of the route's `where` rather than a
  shared helper, because the race test runs raw SQL under its own lock by design. The unit test pins the route side.
- Already correct: the operator-tokens count, the break-glass duplicate check and the `reset-vault` `pendingCount`
  (all `expiresAt > now`), and the `sends/file` byte aggregate (excludes revoked and expired).
- `resource-quotas.ts` `share_links` counts all of a user's shares. It is kept deliberately: it is a storage-exhaustion
  control (C18/A04-1), retained rows occupy storage, and the default is 1000.
- Forbidden pattern: `apiKey.count({ where: { userId: userId, revokedAt: null } })` without `expiresAt`.

### C4 — Out-of-tenant and stranded counters (consequence accepted, no change)

- `vault-reset.ts` `countVaultRowsOutsideTenant` (passwordShare) and `stranded-rows.ts` (apiKey,
  operatorToken, passwordShare) now count expired rows for 30 more days.
- They are kept as they are. The refusal protects rows the new tenant has no authority over, and an expired row is
  still such a row.
- Cost: a tenant-mover with recently expired shares waits up to 30 days for an admin reset.
- The security review (S5) concurred. Narrowing the counters would widen an adjudicator.

### C5 — Team invitation re-issue ignores expired PENDING rows

- `src/app/api/teams/[teamId]/invitations/route.ts` POST is a latent defect that exists today until the next sweep.
  - Select `expiresAt`.
  - Partition the pending rows before the loop: expired ones (`expiresAt <= now`) never yield `ALREADY_SENT`.
  - The existing `updateMany` still flips every pending row, expired ones included, to EXPIRED.
  - A single live pending row still returns `ALREADY_SENT`.
- Abuse check (S5): the route requires `MEMBER_INVITE`, and superseded rows are flipped, so they do not accumulate.
  Phase 2 confirms that the route has a rate limiter.

### C6 — Emergency-access duplicate check ignores expired PENDING invites

- `src/app/api/emergency-access/route.ts` POST duplicate check (`status notIn [REVOKED, REJECTED]`)
  treats a never-accepted invite whose `tokenExpiresAt` has passed as a live duplicate until the
  next sweep deletes it (latent today; security R2 N1). Add
  `NOT: { status: PENDING, tokenExpiresAt: { lte: now } }` to the `where`.
- The expired row is left in place (non-actionable: accept routes check `tokenExpiresAt`;
  purged by the existing `EMERGENCY_GRANT_DEAD` sweep). No supersede write.
- Acceptance (unit, `src/app/api/emergency-access/route.test.ts`): the `findFirst` `where`
  carries the expired-PENDING exclusion (red before); an existing live PENDING still yields
  `DUPLICATE_GRANT` (deny control unchanged).

- Accepted (functionality R3 F1): after a re-invite, the owner and grantee lists show the
  expired PENDING card beside the new one until the next sweep; accepting the stale one returns
  `INVITATION_EXPIRED`. Same state exists today within a sweep interval.
- Tests (testing R3 M1/M2):
  - Unit (`src/app/api/emergency-access/route.test.ts`, fake timers): assert the exact `where`
    shape including `NOT: { status: PENDING, tokenExpiresAt: { lte: <now> } }`; the existing
    live-duplicate case additionally asserts that clause (not only the 409).
  - Real-DB (`src/__tests__/db-integration/`): run the duplicate-check `where` against seeded
    grants — expired PENDING → not a duplicate; live PENDING → duplicate; ACCEPTED/ACTIVATED
    with past `token_expires_at` → duplicate; `token_expires_at = now()` → not a duplicate.
    To avoid a twin, export the `where` builder from the route module's lib side
    (`src/lib/emergency-access/`) and call it from both the route and the test.

## Security consideration (decision recorded)

Retaining expired rows for 30 more days keeps this material at rest.
- `password_shares`:
  - `encrypted_data` and, for FILE Sends, `encrypted_file` are server-encrypted with the master key, not E2E.
  - `accessPasswordHash` is an HMAC-peppered SHA-256.
- `admin_vault_resets`: an unexecuted, unrevoked row keeps `encryptedToken`. It is server-encrypted and
  AAD-bound to tenant, resetId and email, and the CAS refuses it once expired.
- `api_keys` / `operator_tokens`: token hashes only.

Reading any of these needs the DB plus the master key or the pepper. An attacker who has them already
reads every live share and reset. Before SC6 (#581, 2026-06-18), expired shares were kept
indefinitely. Every read path rejects expired rows before decrypting (C2), so a master-key
rotation that retires an old version leaves retained rows undecryptable but never decrypted.

Rejected alternative (SC4): scrub the ciphertext at expiry. It needs a schema change, because the
ciphertext columns are NOT NULL, plus a new sweep kind, for a marginal gain.

## Testing strategy

The grace is always derived from `EXPIRED_RECORD_VISIBILITY_GRACE_DAYS`, imported from the registry
module. Each test also asserts that its table's registry entry has `retentionDays` equal to that
constant, and fails loudly otherwise. Boundaries use DB-clock SQL expressions:
- kept: `now() - interval '1 hour'` (just expired) and `now() - make_interval(days => G - 1)`.
- deleted: `now() - make_interval(days => G) - interval '1 hour'`.

Integration tests (real DB, worker role where the existing file uses it):
- `retention-gc-security-records.integration.test.ts`, shares (T2):
  - `insertShare` takes an SQL interval expression.
  - The existing tests at the "deletes the expired share and cascades", "worker role can run the full capture→emit→delete" and A2 race cases move to the deleted boundary.
  - The A2 race test asserts N audit rows as a positive control.
  - Add kept-boundary cases for 1h and G−1d.
- New tests (T1). `admin_vault_resets` and `personal_log_access_grants` go in `retention-gc-security-records.integration.test.ts`. `api_keys` and `operator_tokens` go in `retention-gc-forensic-credentials.integration.test.ts`. Each table gets:
  - kept at 1h, kept at G−1d, deleted at G+1h;
  - provenance row on delete;
  - fixtures built from that table's NOT NULL columns and parents in `prisma/schema.prisma` (`admin_vault_resets` needs an initiator and a target user).
- RT11: confirm `ctx.deleteTestData(tenantId)` removes rows of all five tables, directly or by cascade. Extend it if not.

Unit tests:
- `src/app/api/api-keys/route.test.ts` (C3):
  - The count `where` contains `expiresAt: { gt: expect.any(Date) }`. This test is red before the change.
  - Together with the updated real-DB `count-then-create-toctou` predicate, it covers the semantics.
- `src/app/api/teams/[teamId]/invitations/route.test.ts` (C5):
  - The existing pending-row mocks gain a future `expiresAt`, as a deny control.
  - New cases:
    - an expired PENDING row gives 201, and `updateMany` flips it;
    - an expired row plus a live row gives `ALREADY_SENT`;
    - `expiresAt === now` counts as expired.
  - Use fake timers.
- C2 deny-side tests per the C2 obligation.

Gates: `npm run check:security-matrices`, `npx vitest run`, `npx next build`, `npm run test:integration` (VE1).

## Considerations & constraints

Scope contract:
- SC1: `emergency_access_grants` excluded.
  - Its UI has no expired state. REVOKED/REJECTED are terminal transitions, and today's prompt purge is consistent with that.
  - A grace would regress or expose:
    - the duplicate check (`route.ts` `status notIn [REVOKED, REJECTED]`) would block re-invites for 30 days on expired-PENDING rows (F1/S1);
    - `emergency_access_key_pairs` (grantee wrapped private key), `granteeEmail` and the public keys would be retained (S2);
    - an `updated_at` cutoff resets on any later write (A2).
  - The grace is not applied. The latent sweep-interval defect in its duplicate check, the same class as C5,
    is fixed as C6.
- SC2: `team_invitations` excluded. It has no expired-state UI, and a grace would regress the POST dedup and the
  pending list. Its latent re-issue defect is fixed as C5.
- SC3: the `access_requests` grace stays at 7 days (admin-review cadence, M2).
- SC4: ciphertext scrub at expiry. Not done; see the Security consideration.

## User operation scenarios

1. Create a 1-hour entry share and wait 2 hours.
   - Share Links with the "expired" filter lists it, and its access log is viewable.
   - The recipient URL shows "expired".
2. An API key expires.
   - It is listed as expired for 30 days.
   - A new key can still be created when 10 keys exist but some are expired.
3. A break-glass grant expires. It is listed as EXPIRED, and its logs endpoint rejects.
4. An admin vault reset expires unapproved. The history shows EXPIRED, and execute and approve refuse.
5. An admin re-invites a member whose team invitation expired before the next sweep. A new invitation is issued.
6. 31 days after expiry, the row is gone, and a `SECURITY_RECORD_RETENTION_PURGED` or `CREDENTIAL_RETENTION_PURGED` audit is present.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Registry 30-day grace (shared constant) for five members + matrix doc | locked |
| C2 | Expired rows inert — member set verified; deny-side tests confirmed/added | locked |
| C3 | api-keys cap ignores expired keys (+ toctou test predicate) | locked |
| C4 | Out-of-tenant/stranded counters — consequence accepted | locked |
| C5 | Team invitation re-issue ignores expired PENDING | locked |
| C6 | Emergency-access duplicate check ignores expired PENDING | locked |

## Implementation Checklist

Production (done by orchestrator):
- [x] `src/workers/retention-gc-worker/registry.ts` — `EXPIRED_RECORD_VISIBILITY_GRACE_DAYS` + `retentionDays` on 5 entries (C1)
- [x] `src/app/api/api-keys/route.ts` — cap count `expiresAt: { gt: new Date() }` (C3)
- [x] `src/app/api/teams/[teamId]/invitations/route.ts` — select `expiresAt`, loop over live rows only (C5)
- [x] `src/lib/emergency-access/emergency-access-server.ts` — `duplicateGrantWhere()`; `src/app/api/emergency-access/route.ts` uses it (C6)

Tests (all test trees, R19):
- `src/workers/retention-gc-worker/__tests__/registry.test.ts` — set-equality of grace members (C1/N3)
- `src/__tests__/db-integration/retention-gc-security-records.integration.test.ts` — shares boundary/existing tests; new admin_vault_resets, personal_log_access_grants (C1)
- `src/__tests__/db-integration/retention-gc-forensic-credentials.integration.test.ts` — new api_keys, operator_tokens (C1)
- `src/__tests__/db-integration/count-then-create-toctou.integration.test.ts` — predicate + expired-key case (C3)
- `src/app/api/api-keys/route.test.ts` — cap `where` (C3)
- `src/app/api/teams/[teamId]/invitations/route.test.ts` and `src/__tests__/api/teams/team-invitations.test.ts` — C5 cases, mocks gain `expiresAt`
- `src/app/api/emergency-access/route.test.ts` — exact `where` (C6); new real-DB test for `duplicateGrantWhere` (C6)
- C2 deny-test checklist table above — filled

Docs: `docs/security/deletion-retention-matrix.md` regenerated (C1).

Shared utilities to reuse: `createTestContext`, `setBypassRlsGucs`, `inRetentionSweepTx`, `ctx.deleteTestData`, `sweepAuditProvenanceEntry` (`src/__tests__/db-integration/helpers.ts`, `sweep.ts`); `MS_PER_DAY` (`src/lib/constants/time`).

CI parity: `scripts/pre-pr.sh` is the aggregate local gate (117 steps incl. `check:security-matrices`, `check:env-docs`); CI workflows with multi-line run blocks reviewed via pre-pr coverage.

## Addendum — external review findings (2026-11-12), fixed with class sweep

An external review of the branch raised five findings; each was treated as a class
(R42) and every member found in the repo was fixed.

| ID | Class | Members fixed |
|----|-------|---------------|
| C7 | Stored credential sent to a server other than its issuer | CLI: `StoredCredentials.serverUrl` (legacy creds → re-login), `api-client` (requests + refresh), `login` revoke at old issuer, `env`/`run` login-token path, `status` display. Extension: `serverUrl` change disconnects and revokes at the old issuer (`endConnectionForServerChange`). iOS: `ServerURLSetupViewModel.persist` discards host + upload tokens when the server changes. |
| C8 | Read-gated create without serialization (TOCTOU) | `emergency-access` POST, `tenant/breakglass` POST (cooling-off bypass), `vault/delegation` POST (existing-session read outside the lock), `teams/[teamId]/invitations` POST (no row lock for addresses without an account), `tenant/members/[userId]` PUT (double/zero OWNER). Derived by a sub-agent sweep of every read→decide→write site; exclusions recorded in the review log. |
| C9 | `equals` + `mode: "insensitive"` (unescaped ILIKE) | `teams/[teamId]/invitations` (2 sites); `members/search` pending-user exclusion made case-insensitive. New ESLint `no-restricted-syntax` rule (`INSENSITIVE_EQUALS_RESTRICTION`) over `src/**` and `scripts/**`. |
| C10 | Secret file mode applied only at creation | `writeSecretFile` (CLI + e2e mirror) `fchmodSync`; `migrate` chmod after rename; `saveConfig` via `writeSecretFile`; config/data dirs tightened to 0700. |

Not fixed, by decision:
- New-device notification duplicate under concurrent login (`new-device-detection.ts`): cosmetic; a lock would serialize the auth path.
- Unique-constraint-protected creates return 500 instead of 409 to the losing request (`prismaErrorResponse` has no callers): integrity holds; cosmetic.
- An AST gate for the C8 class (sibling of `check-count-then-create-lock.mjs`): proposed as follow-up.

### Addendum round 2 (second external review, 2026-11-12)

- C7 iOS: `ServerURLSetupViewModel.persist` discards host + upload tokens unless the very same URL is re-verified (also when no previous config is readable), and a failed discard aborts the save (`persist` throws; the setup screen shows a retry message).
- C7 extension: any `serverUrl` change stops token use synchronously (`hydrationSuperseded = true`, in-memory clear) before any await, including when the previous URL is unknown; the previous URL, when known, is only the revocation target.
- C10 CLI migrate: the legacy file is tightened to 0600 before the rename, so a chmod failure leaves it unmoved instead of moved at its old mode.
- Follow-up candidate (not done): bind extension / iOS tokens to their issuer URL at storage time, as the CLI now does, so the guarantee does not depend on observing the URL change.

### Addendum round 3 (third external review, 2026-11-12)

- C7 extension: on a server change the stored session is cleared synchronously in every case (the session read for revocation is started first but never awaited before the clear), so a SW torn down mid-read leaves no token behind, and a connection made while the read is pending is never wiped. A token the read loses is not revoked (best-effort).
- C10 CLI migrate: the legacy file is tightened through an O_NOFOLLOW descriptor (`fstat` regular-file check + `fchmod`); a symlinked legacy file is neither followed nor migrated.
