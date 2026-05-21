# Plan Review: owasp-batch-3 — Round 1

Date: 2026-05-22
Review round: 1

## Changes from Previous Round

Initial review — three parallel sub-agent reviews (Functionality, Security, Testing) of `owasp-batch-3-plan.md`.

## Functionality Findings (F1-F16)

- **F1 Critical**: C13 REVOKE breaks production — `passwd_app` actively `auditLog.updateMany`s in `src/auth.ts:136` (tenant merge) and `auditLog.deleteMany`s in `purge-audit-logs/route.ts:70`. Also `audit_anchor_manifests` table does not exist. **Resolution**: revised plan adopts SECURITY DEFINER procedures (`audit_log_tenant_migrate`, `audit_log_purge`) owned by `passwd_user`; passwd_app gets EXECUTE; UPDATE/DELETE revoked. `audit_anchor_manifests` removed from contract.
- **F2 Critical**: C2 history restore AAD flow undefined. **Resolution**: revised plan defines two-step restore (decrypt with `buildPersonalHistoryAAD` → re-encrypt with `buildPersonalEntryAAD(_, _, "blob")`).
- **F3 Major**: C8 `AccessRequest.requesterUserId` column does not exist; SA actor type not handled. **Resolution**: new Prisma migration with `requesterUserId` + `requesterServiceAccountId` (XOR constraint); pre-1.0 existing PENDING rows transition to CANCELLED.
- **F4 Major**: C1 Consumer-flow missing CLI (8 files), emergency-access page, audit-logs page, watchtower hook, password-card component, path typo `.ts` not `.tsx`. **Resolution**: walkthrough expanded to 9 consumers.
- **F5 Major**: C12 path `src/lib/auth/rate-limit/` does not exist. **Resolution**: corrected to `src/lib/security/rate-limiters.ts`; `magicLinkIpLimiter` is new (not existing).
- **F6 Major**: C19 model name `BreakGlassGrant` wrong (actual: `PersonalLogAccessGrant`); `effectiveAt` NULL semantics undefined. **Resolution**: corrected; access-time check uses `(effectiveAt IS NULL OR effectiveAt <= now())`.
- **F7 Major**: C18 TOCTOU not addressed. **Resolution**: soft-cap explicitly accepted pre-1.0 with documented +N concurrency tolerance; hard-cap deferred.
- **F8 Major**: C6 tx boundary / fail-mode ambiguous. **Resolution**: post-tx call (separate connection), 500 on failure with `session_invalidate_failed`, audit metadata records `cacheTombstoneFailures`.
- **F9 Major**: C14 worker DB role missing. **Resolution**: new `passwd_audit_chain_verifier` role defined in same migration as C13; new env vars + docker-compose service.
- **F10 Major**: C3 forward-compat (rollback) undocumented. **Resolution**: pre-1.0, no backward compat; rollback consequence documented.
- **F11 Major**: C4 deploy ordering undefined. **Resolution**: 3-phase deploy documented (Phase A = both branches, Phase B = migration, Phase C = drop v1 = this PR).
- **F12 Minor**: C9 helper name wrong. **Resolution**: changed to existing `requireRecentCurrentAuthMethod`.
- **F13 Minor**: C7 tenantId scoping. **Resolution**: changed to `allTenants: true` (matches S2).
- **F14 Minor**: C11 i18n key naming. **Resolution**: snake_case `auth_login_failure` to match existing convention.
- **F15 Info**: C21 v9→v11 breakage list. **Resolution**: known breakages enumerated + call sites listed.
- **F16 Info**: C23 dependabot.yml not in contracts. **Resolution**: new C24 added.

## Security Findings (S1-S18)

- **S1 Critical** (escalate=true): C8 schema migration missing. **Resolution**: same as F3 above (revised plan adds migration with XOR constraint + actor discriminated logic).
- **S2 High**: C7 `tenantId` scoping leaves cross-tenant tokens. **Resolution**: changed to `allTenants: true`.
- **S3 High**: C3 `kv:` not bound to HMAC. **Resolution**: HMAC input is now `${kv}|${payloadB64}`; signing key derives from `"share-access-token-v" + kv`; no-prefix tokens rejected.
- **S4 High**: C6 invalidate failure mode silent. **Resolution**: 500 + audit; client UI must instruct manual sign-out.
- **S5 High**: C13 anchor publisher role + TABLE OWNER. **Resolution**: TABLE OWNER verification added to migration test; anchor publisher role check noted as impl-time verification.
- **S6 Medium**: C10 false-positive risk. **Resolution**: downgraded to audit warning only (no reject); new constant `AUDIT_ACTION.WEBAUTHN_COUNTER_ZERO_RAPID_REUSE`.
- **S7 Medium**: C11 cross-tenant correlation. **Resolution**: identifierHash now uses `hmac_sha256(AUDIT_IDENTIFIER_PEPPER, email + ":" + tenantId)` for tenant binding.
- **S8 Medium**: C12 IPv6 /128 fail-open. **Resolution**: explicit use of `rateLimitKeyFromIp` documented.
- **S9 Medium**: C2 history rollback DB-write threat. **Resolution**: threat model clarified — DB-write attackers are covered by C13/C14 audit chain; historyId binding closes the API-layer attack.
- **S10 Medium**: C5 HKDF info collision check. **Resolution**: literal table documented (`verifier-pepper:`, `share-access-token-v1`, `dirsync-derive`).
- **S11 Medium**: C19 email infrastructure. **Resolution**: confirmed `src/lib/email/{resend,smtp}-provider.ts` exists; use existing abstraction.
- **S12 Medium**: C9 step-up helper. **Resolution**: `requireRecentCurrentAuthMethod` (matches F12) — re-asserts current auth method.
- **S13 Medium**: C14 worker liveness. **Resolution**: `CHAIN_VERIFY_HEARTBEAT` audit event per hourly tick.
- **S14 Medium**: C18 TOCTOU + 429/403 distinction. **Resolution**: 403 for quota (distinct from 429 rate limit); TOCTOU soft-cap accepted.
- **S15 Medium**: C20 partial minimization. **Resolution**: `auditOutbox` check removed from `/ready` entirely (not just from body).
- **S16 Medium**: C21 CVE driver. **Resolution**: explicitly reclassified as hygiene (no specific CVE identified during planning).
- **S17 Medium**: C24 missing from contracts. **Resolution**: new locked contract C24.
- **S18 Low**: C16 sustained re-alert. **Resolution**: 24h re-alert added.

## Testing Findings (T1-T14)

- **T1 Critical**: C4 webhook migration integration test missing. **Resolution**: new `src/__tests__/db-integration/migrate-webhook-secrets-v1-to-v2.integration.test.ts` with idempotency + post-migration throw cases.
- **T2 Critical**: C13 REVOKE integration test missing. **Resolution**: new `src/__tests__/db-integration/audit-tables-revoke.integration.test.ts` with 6 negative + positive (INSERT/SELECT still work) cases.
- **T3 Critical**: C11 actual emission test missing. **Resolution**: new `src/__tests__/auth-failed-login.test.ts` with 5 reasons × identifier-hash length + negative-PII assertions.
- **T4 Major**: C6 integration test for both endpoints. **Resolution**: new integration test with 2 describe blocks (change-passphrase + recover).
- **T5 Major**: C14 unit testability. **Resolution**: `verifyTenantChain(tenantId, deps)` exported as pure function; unit test file specified.
- **T6 Major**: C18 quota matrix. **Resolution**: 4 resources × 4 cases = 16 test cases enumerated; tenant isolation integration test specified.
- **T7 Major**: C19 fake-timer 24h boundary. **Resolution**: `vi.useFakeTimers()` + `vi.advanceTimersByTime(...)` pattern documented in testing strategy.
- **T8 Major**: C15 bail position assertion. **Resolution**: extended test with `walkedThrough`, `firstTamperedSeq`, row-level verified/unverified assertions.
- **T9 Minor**: C8 null requesterUserId case. **Resolution**: added as test case (d) — 400 invalid_request.
- **T10 Minor**: C20 body shape exact match. **Resolution**: `Object.keys(body).sort()` equality assertion specified.
- **T11 Minor**: C21 E2E gate. **Resolution**: `npx playwright test webauthn` added to PR description/CI gate.
- **T12 Info**: C12 strategy explicit. **Resolution**: testing strategy now lists C12 with bucket + IPv6 cases.
- **T13 Info**: C23 grep gate in pre-pr.sh. **Resolution**: added to pre-pr.sh extension.
- **T14 Info**: C1 CHANGELOG `BREAKING CHANGE` footer. **Resolution**: commit-message convention specified in Commit Plan.

## Recurring Issue Check

(Preserved from individual agent reports — summary.)

### Functionality expert
- R1 (shared utility): fail → F12 resolved (use existing `requireRecentCurrentAuthMethod`)
- R3 (propagation sweep): fail → F4 resolved (9-consumer walkthrough)
- R7 / R24 (TOCTOU): fail → F7 resolved (documented soft-cap)
- R8 / R9 (tx boundary / fire-and-forget): fail → F8 resolved
- R14 (i18n drift): fail → F14 resolved
- R16 (optional vs nullable): fail → F6 resolved (NULL semantics defined)
- R17 (migration safety): fail → F1/F3/F6 resolved
- R18 (backwards compat): fail → F10/F11 resolved
- R19 (env-var coverage): fail → F9 resolved
- R29 (type/ORM compile correctness): fail → F3/F6/F1/F4/F5 resolved
- R37 (worker role least privilege): fail → F9 resolved
- Other rules: pass or n/a

### Security expert
- RS1 (threat model accuracy): fail → S2/S6/S7/S9/S12 resolved
- RS2 (auth bypass): fail → S1/S3/S12 resolved
- RS3 (defense-in-depth): fail → S6/S13 resolved
- RS4 (data leakage / correlation): fail → S7 resolved
- R29 (external spec citation): fail → S16 resolved (downgraded to hygiene)
- R31 (destructive op rollback): fail → S5 resolved (TABLE OWNER verification added)

### Testing expert
- R1 (test contract coverage): fail → T1/T2/T6 resolved
- R2 (mock DB for SQL): fail → T2 resolved (real-DB requirement)
- R5/RT2 (no sleep, use fake timer): fail → T4/T7 resolved
- R9 (integration test gap): fail → T1 resolved
- R10 (role-separated DB test): fail → T2 resolved
- R21 (commit BREAKING footer): fail → T14 resolved
- R23 (CI YAML lint): fail → T13 resolved
- RT3 (no DB mock): fail → T2 resolved
- RT4 (coverage threshold for new module): noted — project default applies
- RT5 (E2E smoke gate): fail → T11 resolved

## Round 2 Decision

Plan revision substantially addresses all Critical/Major Round 1 findings. Per user instruction "クラスタごと triangulate", remaining verification is deferred to per-cluster review in Phase 2 implementation (review happens after each commit/cluster). No Round 2 of plan-level review is run; Phase 2 begins directly.
