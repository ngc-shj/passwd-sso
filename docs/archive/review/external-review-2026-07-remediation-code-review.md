# Code Review: external-review-2026-07-remediation
Date: 2026-07-23
Review round: 1

## Changes from Previous Round
Initial code review (Phase 2 self-R-check was the baseline).

## Functionality Findings
FUNCTIONALITY — Phase 3 Round 1 (code review)

F1 [Medium] C7 EXPIRED never user-visible: access_requests EXPIRY_AUDIT_PROVENANCE hard-deletes at same `expires_at < now()` cutoff, same sweepOnce cycle → flip-then-delete. 残3 UX unresolved. Fix (USER DECISION): grace offset on hard-delete (retentionDays). → FIX-M2
F2 [Low-Medium] getItemEncryptionKey (attachments) not version-aware — restored stale-version entries viewable but attachments fail. Undeclared class-member of SC6. Fix: version-aware branch OR declare SC7. → FIX-M3
F3 [Low] TeamKeyVersionUnavailableError thrown for ALL versioned-fetch nulls not just 404 → false "predates membership" message on transient failures. → FIX-F3 (converges Sec F2)
F4 [Low] clear-lockout AlertDialogAction auto-closes; comment falsely claims stays-open; diverges from template. → FIX-F4
F5 [Low] .claude/settings.json committed session-residue Bash allowlist (machine-specific abs paths). → FIX-F5
F6 [Low] ja ブラウザー vs repo-wide ブラウザ. → FIX-F6
F7 [Info] hardcoded English toast next to new i18n key. → FIX-F7

Verified clean: cold-cache versioned routing (latest resolved first); <1→1 at all 7 callers; raw-0+itemKeyVersion>=1 provably impossible; instanceof single-class; getTeamKeyInfo pointer for 3 consumers; C4 placement after tenant early-returns + ??undefined; C5 server/UI parity + dual fail-closed limiters + vault-unlock untouched; C7 mechanics; C8 valid; D1-D10 none wrong.
Recurring deltas: SC-class drift (F2 vs SC6); plan-premise not re-validated (F1); comment/behavior divergence (F4).

## Security Findings
SECURITY — Phase 3 Round 1 (code review)

F1 [Minor] sweep.ts ~:615 — sweepExpiredAccessRequests UPDATE outer WHERE lacks `AND status = 'PENDING'`; under READ COMMITTED EvalPlanQual a concurrently-approved row can flip APPROVED→EXPIRED (MATRIX-forbidden transition; needs clock skew, negligible exploitability, no privilege change, token unaffected). Fix: add outer status re-check (true CAS).
F2 [Minor/Adjacent→Func] messages/{en,ja}/PasswordDetail.json historyKeyUnavailable — asserts single cause ("predates membership") for a multi-cause error (404, transient network, version mismatch, unwrap failure). Fix: soften wording or discriminate cause.
F3 [Minor] team-vault-core.tsx:206-210,288-291 — D10 confirmed accurate (pre-existing R39 residuals); NEW insight: distributePendingKeys already uses the stronger finally-based teamKeyBytes?.fill(0) pattern — a finally in fetchAndUnwrapTeamKey closes both residuals in ~3 lines.

Verified clean: version assertion airtight (isPositiveInt + pre-cache assert + AAD binding); latest-pointer unpoisonable; clear-lockout auth chain order exact + dual fail-closed limiters; member-key audit RLS-scoped, no key material; auth-gate null-vs-undefined semantics correct vs auth.ts catch bundle; migrations minimal; i18n no over-disclosure; single caller of versioned apiPath; D1-D10 all accurate.
Recurring delta: TOCTOU family (F1) — otherwise baseline clean.

## Testing Findings
TESTING — Phase 3 Round 1 (code review)

T1 [Minor] team-vault-core.crypto.test.tsx:204-222 — case (a) self-round-trip + instanceof decorative; comment overstates ("confirm they match"). Fix: drop lines or make load-bearing via prebuilt fixture ciphertext.
T2 [Minor] sweep-access-request-expiry.test.ts:25-29 — "sets bypass_rls before the UPDATE" asserts only call count, not set_config content nor ordering. Fix: assert template contains set_config('app.bypass_rls' and invocationCallOrder comparison.
T3 [Minor] clear-lockout route.test.ts:119-149 — 401 + permission-403 denial tests lack expect(update).not.toHaveBeenCalled() pin the other 7 carry (RT8 uniformity). Fix: add one-line pins.
T4 [Adjacent→Sec, CONVERGES with Security F1] sweep.ts:612-621 — outer UPDATE lacks status='PENDING'; EPQ race. Fix: add to outer WHERE.
T5 [Minor] team-vault-core.test.tsx:157-229 — mockDeriveTeamEncryptionKey only 2 Once values; post-invalidation refetch resolves undefined (fetch-count-only assertions). Fix: add default mockResolvedValue.

Mutation verification performed (live, tree restored — R21 residue grep REQUIRED by orchestrator): version-branch removal → 4/5 crypto tests red; hardcoded teamKeyVersion:1 → call-arg pin red. C4 omission tests analytically sound. Worker-role connection verified. RT9 no twins. RT1/RT7/RT8 baseline deltas: only T3.

## User/IDE external-review supplement (Round 1)
US1 [Medium] sweep.ts:617 outer UPDATE ID-only — concurrent-approve race (same as Sec F1 / Test T4). → FIX-M1 (add outer status='PENDING'). Suggested also FOR UPDATE SKIP LOCKED CTE; DB-integration test with concurrent approve tx.
US2 [Medium] auth-gate.ts:72 CACHE-HIT path returns cached value BEFORE the C4 bundle-substitution — SessionInfoSchema (session-cache.ts:31) accepts all 4 passkey fields as optional, so a partial positive-cache value fails open (page-route requirePasskey falsy → enforcement bypass). Existing tests pin the pass-through-missing-fields behavior. **NOT covered by my Round-1 review — real structural gap.** Fix: require the 4 fields in SessionInfoSchema OR apply the same bundle-level fail-closed normalization to the cache-read path (reject type-invalid as missing too). → NEW FIX-M4.
US3 [Low] EXPIRED not UI-observable (same as Func F1). → FIX-M2 (grace offset).

## Round 1 Resolution Status
- FIX-M1 (Sec F1 / Test T4 / US1): sweep outer WHERE now repeats `status='PENDING'` (true CAS) — sweep.ts:649-652. Manifest sweepBounds shape preserved (AND placed after key-set-IN).
- FIX-M2 (Func F1 / US3): AuditProvenanceEntry.retentionDays optional field; access_requests=30d grace so EXPIRED survives ≥1 cycle before purge; sweepAuditProvenanceEntry cutoff `< now() - $2 days` when set; matrices regenerated; integration test asserts EXPIRED survives.
- FIX-M3 (Func F2): getItemEncryptionKey made version-aware (attachments of restored stale-version entries now open). Implemented, not deferred.
- FIX-M4 (US2): SessionInfoSchema 4 passkey fields required → cache-hit fail-closed. Regression test mutation-proven.
- FIX-F3 (Sec F2 / Func F3): fetchAndUnwrapTeamKey discriminates not_available vs transient; distinct history toast only for 404/mismatch.
- FIX-F4: clear-lockout button matches TenantVaultResetButton template (dialog stays open through failure/step-up); false comment removed.
- FIX-F5: .claude/settings.json permissions residue removed (was from Phase 2 git add -A; main has none).
- FIX-F6: ja ブラウザー→ブラウザ.
- FIX-F7: history generic decrypt toast → historyDecryptFailed i18n key.
- FIX-T1/T2/T3/T5: decorative-assertion / bypass_rls ordering / RT8 denial-pin / mock-exhaustion all addressed.
