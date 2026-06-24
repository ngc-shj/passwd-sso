# Coding Deviation Log: admin-stepup-nostore-hardening

## Deviations (manually recorded)

### D1 — New test fixtures use UUIDv4 instead of plan's `"entry-1"` placeholder
- **Files**: `src/app/api/share-links/route.test.ts`, `src/app/api/sends/route.test.ts` (new files)
- **Reason**: the `passwordEntryId` field is validated by Zod `.uuid()`; the plan's conceptual `"entry-1"` placeholder would fail validation. Used a valid UUIDv4 (`a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d`), matching the convention in sibling tests (e.g. `vault/delegation/route.test.ts`).

### D2 — Pre-existing lint warning fixed (root cause, not in original scope)
- **File**: `src/app/api/tenant/policy/route.ts:942`
- **Reason**: C3 added the step-up gate to `handlePATCH`, putting the whole file in diff scope (CLAUDE.md "Fix ALL errors"). A pre-existing `no-unused-vars` warning (`tx` param of the outer `withBypassRls` callback, shadowed and unused) was fixed at root cause by dropping the unused param — NOT suppressed (per `feedback_no_suppress_warnings`).

### D3 — R2 hardcoded-reuse hook false positive (deliberate skip)
- **Anti-Deferral check**: out of scope (false positive — not a real shared-constant violation)
- **Justification**: the R2 hook flagged `"tenant-1"` and a UUID literal in the two new test files as matching a `TENANT_ID`/`ENTRY_ID_1` constant. Those "constants" are LOCAL `const` declarations inside unrelated test files (`purge-history/route.test.ts`, `vault/delegation/route.test.ts`), not shared exports. Sibling tests in the same directories (`share-links/[id]/route.test.ts:62`, `sends/file/route.test.ts:88`) use the identical inline `"tenant-1"` literal. There is no shared exported test-fixture constant; importing another test's private fixture would create cross-test coupling. Following local convention is correct.
- **Orchestrator sign-off**: confirmed — test-fixture string collision across independently-authored test files is the documented R2 caveat, not a violation.

### D4 — Self-R-check: two missed no-store helper adoptions (resolved)
- **Files**: `src/app/api/mobile/token/route.ts`, `src/app/api/tenant/webhooks/route.ts`
- **Reason**: Step 2-5 self-R-check (R17/R22) found two secret-bearing routes still inline. `mobile/token` was owned by the C4 batch (which was told not to touch headers) and the C2 batch (told not to touch mobile/token) — it fell between batch boundaries. `tenant/webhooks` returns `secret: plainSecret` but was omitted from the original C2 enumeration. Both fixed: migrated to `NO_STORE_HEADERS`, plan C2 list amended, webhooks test gained a no-store assertion. No security regression (no-store was already present in both). Committed c1737dae.

## Phase 3 deviations

### D5 — bypass-rls fix (user finding + Round-1)
- **File**: `src/app/api/tenant/policy/route.ts`
- The Phase 2 D2 lint "fix" (`async (tx) =>` → `async ()`) introduced a `check:bypass-rls` CI-gate failure (the check forbids the tx-less callback form). Root cause: the original code redundantly re-entered `prisma.$transaction` inside `withBypassRls`, and the inner transaction did NOT inherit the bypass `set_config` (transaction-local GUCs). Fixed by removing the nested `$transaction` and using the bypass `tx` directly — `withBypassRls` already provides transactional atomicity. This is the architecturally correct form (queries now run with the bypass GUC live).
- **Accepted Minor (S-R2-1)**: the removed inner transaction carried `isolationLevel: "Serializable"`; `withBypassRls` uses the default (Read Committed). Worst case: two OWNER admins concurrently lowering the same team-policy ceiling could leave a team policy briefly above the new tenant ceiling. Likelihood: low (two simultaneous OWNER PATCHes on the same tenant). Cost to fix: would require extending `withBypassRls` to accept an isolationLevel — out of proportion. Self-heals on next write; both actors are trusted OWNERs. No security bypass.

### D6 — step-up scope expanded to all detected routes (user decision)
- Added step-up to members/[userId] PUT, reset-vault POST, audit-delivery-targets POST + [id] PATCH, breakglass POST + [id] DELETE (beyond the original 7 families). User explicitly chose "all detected routes". audit-delivery [id] PATCH: parseBody moved to after the step-up gate (canonical authz→existence→step-up→body order; Round-2 S-R2-5).

### D7 — delivery-URL credential masking (user finding)
- `isSsrfSafeWebhookUrl` now rejects embedded credentials; `maskUrlForDisplay` (origin+pathname) applied to the audit-delivery list response and 3 worker log sites. Delivery still uses the full URL.
- **Noted Minor (S-R2-12, unreachable)**: `sanitizeErrorForStorage` does not strip userinfo from URL-shaped error strings, but the ingestion gate now blocks credentialed URLs so no such URL reaches the worker. Defense-in-depth note only.

### D8 — Round-2 fixes
- **T-R2-4 (Major, fixed)**: 3 new tuple-type annotations `([, msg]: [unknown, string])` in `src/workers/audit-delivery.test.ts` broke `tsc --noEmit` (vitest transpiles without type-check, so the full suite passed but the typecheck CI gate would fail). Fixed by dropping the annotation. Lesson: re-run `tsc --noEmit` / `npm run typecheck`, not just vitest, after test edits.
- **F-R2-1 (Minor, accepted cosmetic)**: the policy/route.ts transaction body is over-indented by 4 spaces (residue from the removed nesting). Valid, compiles, lint-clean. Re-indenting 90 lines for zero functional gain risks introducing errors and bloats the diff; left as-is.
- **T-R2-1 / T-R2-3 (Minor, accepted)**: centralized members.test.ts / breakglass.test.ts have step-up pass-through mocks but no reject test. The reject path is already covered non-vacuously in the route-local test files (with `.not.toHaveBeenCalled()` on the mutation spy). No coverage gap; duplicating would be churn.

## Phase 3 — lateral sweep (横展開, user request)

### D9 — 5 more secret-bearing responses found by exhaustive sweep
- **Routes**: `teams/[teamId]/webhooks` POST (`secret: plainSecret`), `extension/token/exchange` (`token`), `teams/[teamId]/invitations` POST (`token`), `share-links/verify-access` (`accessToken`), `auth/passkey/verify` (`prf` = PRF key-derivation output).
- **Root cause of the miss**: the original C2 enumeration was scoped to obvious token-mint routes under `tenant/` and did not exhaustively sweep `teams/`, `extension/token/exchange`, `share-links/`, and `auth/passkey/`. The user surfaced `teams/[teamId]/webhooks` (the tenant-webhook sibling); a wider `grep -E '(secret|token|accessToken|prf):'` over all `NextResponse.json` routes then caught the other four. All migrated to `NO_STORE_HEADERS` with header assertions added.

### D10 — WebAuthn challenge/options routes correctly EXCLUDED (not cargo-culted)
- The sweep also surfaced `webauthn/*/options`, `webauthn/authenticate/verify`, `auth/passkey/reauth/options`, `auth/passkey/options/email`. These return a WebAuthn **challenge** (a public single-use nonce, Redis-stored, consumed via getdel) + `challengeId` (flow correlation) + `prf` **extension input config/salt** — NOT a credential. A challenge is sent precisely to be signed; caching it is harmless. `prf` here is the extension *input* (contrast `passkey/verify`'s `prf` *output* = vault-key material, which WAS fixed). Applying no-store here would be cargo-cult. Deliberately excluded.

### D11 — pre-existing unused-`tx` warning in passkey/verify NOT touched
- `src/app/api/auth/passkey/verify/route.ts:120` has the same `withBypassRls(prisma, async (tx) => prisma.$transaction(async (tx) => ...))` shadow pattern as policy/route.ts had — a pre-existing `no-unused-vars` warning (confirmed present on `main`; my diff only added the no-store header far below, not this line).
- **Anti-Deferral check**: pre-existing in changed file. Per CLAUDE.md "fix all errors" the correct fix is the same bypass-`tx`-direct-use refactor as D5 — BUT this is a **pre-auth, security-critical** route and its transaction semantics are out of this PR's (no-store + step-up) scope. "Fixing" the warning naively (`async ()`) is the exact `check:bypass-rls` trap that cost a round (D5). Worst case: cosmetic lint warning persists. Likelihood: n/a. Cost to fix correctly: a separate reviewed refactor of a pre-auth route's transaction — disproportionate and risky here. Deferred to a dedicated follow-up. `check:bypass-rls` passes; the warning is non-blocking (0 errors).
- **Orchestrator sign-off**: pre-existing-in-unchanged-line, out-of-theme, security-critical route — deferred with this justification, not silently dropped.

## /simplify session

### D12 — webhook target URLs masked in audit-log metadata (inverted-search coverage gap)
- The simplify inverted-search (enumerate every site that logs/returns a delivery URL, check maskUrlForDisplay adoption) found that webhook target URLs were logged RAW into audit-log metadata at 6 sites the C4/D7 masking didn't cover: webhook-dispatcher.ts delivery-failed audit (×2: team + tenant) and the 4 webhook CRUD route audit logs (tenant/team × create/delete). `url` is not in METADATA_BLOCKLIST, so a pre-PR webhook carrying `user:pass@` would leak credentials via audit_logs → external SIEM. User: "本質的には推奨". Fixed: each audit `metadata.url` wrapped with `maskUrlForDisplay`. Functional delivery URLs (fetch, deliverWithRetry, WebhookRecord construction) and create-response bodies left RAW — only the cross-actor audit-log surface is masked. Added a masking-proof test (fixture URL with `?token=secret` → masked).

### D13 — policy/route.ts cosmetic cleanup (simplify findings #3/#4)
- Stale comment claiming `Serializable` isolation removed (the wrapper was dropped in D5; comment now describes the actual default-isolation withBypassRls transaction).
- Transaction body dedented by 2 spaces (residual over-indent from the removed nested `$transaction`, flagged F-R2-1 in code review and deferred there; fixed now in simplify since it was cheap and clean). Verified: tsc clean, 91 policy tests pass, lint clean.
