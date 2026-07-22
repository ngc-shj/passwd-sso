# Plan Review: external-review-2026-07-remediation
Date: 2026-07-22
Review round: 1

## Changes from Previous Round
Initial review

FUNCTIONALITY EXPERT — Plan review round 1 (external-review-2026-07-remediation)

F1 [Critical] C7: retention GC role lacks UPDATE grant on access_requests (migration 20260619001000:9 grants SELECT,DELETE only). Sweep fails permission-denied every cycle; worker loop swallows errors. Fix: GRANT UPDATE (status) migration + worker-policy-manifest.json update; integration test must run under worker role.
F2 [Major] C1: cache re-key breaks getTeamKeyInfo (team-vault-core.tsx:268-277 reads cacheRef.get(teamId) directly) — feeds team entry create/edit, bulk import, rotation. Fix: resolve via latest pointer or have getTeamEncryptionKey return the cached record.
F3 [Major] C1: legacy teamKeyVersion=0 rows (schema default 0; `0 ?? 1 === 0`) route into versioned fetch → member-key route 400s keyVersion<1 → decrypt regression on pre-versioning rows. Fix: normalize teamKeyVersion<1 → "use latest"; acceptance test with =0 fixture.
F4 [Major] C8: engines "20.x" contradicts release.yml PUBLISH_NODE_VERSION 24.18.0 (hard-asserted at :72). Fix: inspect ALL workflows; choose ">=20" or "^20 || ^24" or record release.yml decision.
F5 [Minor] C2/C5: audit action names must be UPPER_SNAKE (TEAM_MEMBER_KEY_OLD_VERSION_READ, TENANT_MEMBER_LOCKOUT_CLEAR) matching TEAM_MEMBER_KEY_DISTRIBUTE style. (Converges with Testing F5.)
F6 [Minor] C2: "old" detection needs extra latest-version lookup in the keyVersionParam branch (route findUnique fetches exact version only). State explicitly; hot no-param path stays single-query.
F7 [Minor] C5: permission constant ambiguous — recommend MEMBER_MANAGE (not MEMBER_VAULT_RESET); state whether self-target/role-hierarchy checks carry over; lockout fields live on global User model — "tenant-scoped" concretely = verify active TenantMember(actor.tenantId,target) then update User by id.
F8 [Minor] C1: MEMBER_KEY_NOT_FOUND (post-rotation joiner) surfaces as generic decrypt-failure toast — accept explicitly or add distinct i18n message. (Converges with Security F6 adjacent.)

Verified sound: history route field completeness; latest-pointer race (JS single-thread, no latest-slot writes from versioned path); v0 branch direction; C2 registration member-set reality; C4 both-path field emission; C6 relrowsecurity readability + harness; C7 EXPIRED badge/labels + matrix + sweep placement; C8 env-drift-check has no Node-22-only step, no corepack usage.
Cosmetic: plan line refs :56/:69/:94 are actually :61/:74/:99 (drift only).

Recurring Issue Check: R1 pass; R2 pass; R3 fail (F2,F4); R9 pass; R10 pass; R12 partial fail (F5); R14 pass; R17 pass; R25 fail (F1); R38 pass; R40 pass; R41 pass; R42 partial fail (F3); others n/a.

SECURITY EXPERT — Plan review round 1 (external-review-2026-07-remediation)

F1 [Major] C7: retention-gc worker role lacks UPDATE grant on access_requests (migration 20260619001000 grants SELECT,DELETE only). Sweep fails permission-denied. Fix: column-scoped GRANT UPDATE (status) migration + manifest parity gate update. Integration test must connect as the worker role.
F2 [Minor] C7: raw SQL bypasses state-machine SSoT (bulkTransition, access-request-state.ts:134-165). Recommend bulkTransition with SYSTEM-sweep carve-out OR raw SQL + MATRIX cross-ref comment + parity test. Note isBypassRlsActive guard requires tenantId predicate under bypass.
F3 [Major] C5: dropping dual-approval needs per-target fail-closed rate limit (reset-vault has per-admin 3/day AND per-target 1/day, route.ts:40-50,122-139). Without it, compromised admin loops clear-lockout → unlimited passphrase-guess budget. Also reset lastFailedUnlockAt for parity with resetLockout().
F4 [Minor] C5: verified lockout state is DB-only (no cache invalidation needed). Add plan line: do NOT clear the independent Redis vault-unlock limiter.
F5 [Minor] C1: versioned fetch must assert response.keyVersion === requestedVersion before AAD build and caching (server version-swap → cache poisoning of versioned slot / latest pointer).
F6 [Minor/Adjacent→Functionality] C1(a) verified safe: no pre-join old-version rows exist (confirm-key gates on current version; rotation createMany only for active members). Adjacent: post-rotation joiner viewing pre-join history gets MEMBER_KEY_NOT_FOUND — add graceful null-path test/UX.
F7 [Major] C1: plan silent on R39 zeroization (ecdhPrivateKeyBytes.fill(0) on every exit path :198,:218,:261; teamKeyBytes.fill(0) :245). Fix: shared private helper parameterized by optional keyVersion — one zeroization implementation, two entry points; add invariant + forbidden second unwrapTeamKey call site.
F8 [Minor] C2: comparator unspecified — recommend compare vs team.teamKeyVersion (simpler, audits more); metadata include latestKeyVersion.
F9 [Minor] C4: pin-only acceptable minimum; stronger: bundle-level fail-closed substitution (if ANY of 4 fields missing → substitute full fail-closed bundle + warn). Per-field ?? true rejected (fragile recombination + availability risk).
F10 [Minor] C3 verified: wording discloses nothing beyond policy-enforcement.md; gloss CGNAT if used (R37).
F11 [Minor] C7 audit posture acceptable (terminal retention purge records status provenance).

Recurring Issue Check: R3 pass; R9 pass; R12 pass; R14 fail-partial (F9/F1); R31 pass; R38 pass; R39 fail (F7); R42 pass; R43 pass; RS1 pass; RS2 fail-partial (F3); RS3 pass; RS4 pass; RS5 pass; RS6 pass; others n/a.

TESTING EXPERT — Plan review round 1 (external-review-2026-07-remediation)

F1 [Major] C1: real-WebCrypto acceptance conflicts with fully-mocked team-vault-core.test.tsx (vi.mock crypto-team/crypto-aad + globalThis.crypto stub). Fix: new sibling file team-vault-core.crypto.test.tsx (jsdom, real subtle proven by jsdom-web-crypto-probe.test.ts), real TeamVaultProvider, crypto UNMOCKED, fetch stubbed; fixtures via real wrapTeamKeyForMember (pattern in crypto-team.test.ts:170-230). Keep mocked suite for cache semantics.
F2 [Major] C1: no test pins entry-history-section teamKeyVersion pass-through — hardcoding 1 passes all planned tests (existing component test never asserts getEntryDecryptionKey args). Add component test: fixture teamKeyVersion=<old> → assert call args.
F3 [Major] C4: real-session-callback contract test ALREADY EXISTS at src/auth.test.ts:775-897 (captures callbacks.session via NextAuth init args; asserts 4 fields on catch+success). Rewrite C4: reference existing suite, drop AST-gate fallback, scope new work to auth-gate missing-field fallback tests (auth-gate.test.ts currently covers only full-response cases).
F4 [Major] C5: acceptance omits step-up test (reset-vault has @stepup + requireRecentCurrentAuthMethod :116-118). Add stale-auth → step-up 403 case; note @stepup annotation + step-up client-coverage gate impact (new route may add a member to the tracked open client class).
F5 [Minor/Adjacent→Functionality] C2: action name `team.member_key.old_version_read` violates SCREAMING_SNAKE convention; dotted key breaks next-intl flat-key label lookup. Rename TEAM_MEMBER_KEY_OLD_VERSION_READ. R12 guard verified real (audit-i18n-coverage.test.ts:22-30).
F6 [Minor] C7: name the test file (src/__tests__/db-integration/retention-gc-access-request-expiry-sweep.integration.test.ts); mocked jit-workflow suite cannot host row-mutation assertion. EXPIRED badge verified existing (access-request-card.tsx outline variant) — pre-lock verification done.
F7 [Minor] C6: extract parameterized assertRegistryRlsParity(registry, rlsFreeTables, catalogRows) so negative fixture and real-DB assertion share one function (validateRegistry doesn't cover RLS parity).
F8 [Minor] C3/C8 RT7 exceptions: declare C3 wording as review-gated (key parity guarded by existing i18n tests); C8 add check-publish-toolchain.sh to acceptance.
F9 [Minor] C1: cache non-poisoning test must pin fetch-call counts AND key identity (or version-tagged decrypt) — as phrased satisfiable by decorative test.

Recurring Issue Check: R19 pass; R21 n/a; R42 pass; RT1 fail (F1); RT2 pass w/ F9 caveat; RT3 pass; RT4 pass; RT5 fail (F2,F3); RT6 pass; RT7 partial fail (F2,F3,F7,F8); RT8 pass; RT9 pass; others n/a.

---

# Round 2 (combined incremental)
Date: 2026-07-23

F1 [Major→fixed] C5 self-target vs strict-above hierarchy contradiction → explicit check order (self bypasses hierarchy) + self-target 200 acceptance cases both roles.
F2 [Major→fixed] R12 member-set omitted Prisma AuditAction enum + ALTER TYPE migration → added as item 1 of re-derived member-set (both new actions).
F3 [Minor→fixed] C1 caller set 4→7 re-derived (F-H added); edit-after-restore residual scope-declared as SC6 (server defends w/ 400; strictly better than today).
F4 [Minor→fixed] teamKeyVersion=0 semantics: normalization changed from "<1 → latest" to "<1 → 1" (semantically correct for rotated teams; fixture (c) updated).
F5 [Minor→fixed] C4 substitution scoped to valid===true; sticky positive-cache fail-closed behavior recorded as intended.
F6 [Info] C7 updated_at/trigger concern moot (no column, no trigger); grant mechanics + bypass-GUC WITH CHECK confirmed.

R43 assessment: C5 self-target = deliberate bounded widening (ACCEPT w/ F1 fix); C4 = fail-closed only (not a widening; user-approved); C7 grant = column-scoped, manifest-pinned (ACCEPT).
Recurring check deltas: R12 newly triggered (F2, fixed); R42 newly triggered (F3, fixed); R43 assessed-accept. Others unchanged.

---

# Round 3 (final verification)
Date: 2026-07-23

No findings. All five Round-2 fixes verified in plan text; delta checks clean:
(a) `<1 → 1` + branch condition compose correctly for never-rotated teams (normalized 1 == latest 1 → normal path, no extra fetch);
(b) C4 valid===true scoping composes with auth-gate ordering (info built at :124 after valid computation; explicit guard stated);
(c) C5 check order unambiguous vs reset-vault template (self-check → hierarchy-bypass branch; step-up + limiters anchored).
Go/No-Go gate consistent (C1-C8 locked, SC1-SC6 present). Plan converged in 3 rounds.
Recurring Issue Check: all unchanged.
