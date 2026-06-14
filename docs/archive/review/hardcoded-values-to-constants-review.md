# Plan Review: hardcoded-values-to-constants
Date: 2026-06-13
Review rounds: 1–2 (this file accumulates; newest round appended at the end)

## Changes from Previous Round
Initial review. Pre-screening (local LLM, gpt-oss) ran before this round; its valid findings (crypto file count, per-route max scope-out, RATE_WINDOW_MS server-only verification, i18n call-site pairing) were folded into the plan before expert review. One pre-screening finding (vault-context.tsx re-exporting crypto constants) was verified false and dismissed.

## Functionality Findings

### F1 — Major — C10 missing 2 i18n keys with hardcoded policy values
- File: `messages/{en,ja}/TenantAdmin.json:189,208`; call sites `tenant-token-policy-card.tsx:115,121`, `tenant-delegation-policy-card.tsx:94,100`
- Evidence: `"jitTokenTtlValidationMin": "TTL must be at least 60 seconds."` / `delegationTtlValidationMin` same; `JIT_TOKEN_TTL_MIN = 60`, `DELEGATION_TTL_MIN = 60` exist in `src/lib/validations/common.ts:231,233`
- Problem: plan listed 6 keys, omitted the two Min validation keys carrying the same hardcoded policy boundary (60). Acceptance grep `86400 → 0` passes while these stay hardcoded.
- Fix: add both keys to C10 with `{min}` placeholder + paired call-site update; extend acceptance grep.
- Resolution: **Fixed in plan** (C10 now lists 8 keys; acceptance extended).

### F2 — Major — C4 Watchtower cooldown naming inconsistency
- File: `src/app/api/watchtower/start/route.ts:10` (`WATCHTOWER_SCAN_COOLDOWN_MS`) vs `src/hooks/use-watchtower.ts:31` (`WATCHTOWER_COOLDOWN_MS`)
- Problem: the route uses a different identifier than the plan's shared name; rename not stated — risk of two constants remaining or build break.
- Fix: explicit rename instruction in C4.
- Resolution: **Fixed in plan**.

### F3 — Minor — C11 PSSO_VAULT_STATE_CHANGED sender not in adoption list
- File: `extension/src/popup/App.tsx:36`
- Resolution: **Fixed in plan** (added to C11 adoption list).

### F4 — Minor — C1 forbidden pattern misses `src/app/api/vault/setup/route.ts:118`
- Evidence: `const kdfIterations = data.kdfParams?.kdfIterations ?? 600_000;` — third definition of the PBKDF2 default outside `src/lib/crypto/`. `prisma.ts:79` `max: 600_000` is a pool value (excluded); `KDF_PBKDF2_ITERATIONS_MIN` is a semantically distinct min guard (excluded).
- Resolution: **Fixed in plan** (C1 adoption extended; forbidden pattern rescoped with named exclusions).

### F5 — Minor — C8 VALID_ACTOR_TYPES derivation widens parseActorType return type
- Evidence: `Object.values(ACTOR_TYPE)` yields `ActorType[]` vs readonly tuple; Prisma/callers compatible; `it.each` unaffected.
- Resolution: **Fixed in plan** (clarifying note added — intentional, no `as const` attempt).

## Security Findings

### S1 — Minor — C11 plain-JS twin desync is a process control only
- Verified: background `handleMessage` has no default branch — unknown message types fail closed (silent feature break, no privilege escalation).
- Fix: value-pin assertions pairing constants.ts values against plain-JS twin literals.
- Resolution: **Fixed in plan** (merged with T3 — C11 acceptance now requires twin-sync/value-pin test).

### S2 — Minor — C10 call-site update is prose, not formal acceptance
- Impact: missed `t()` site renders literal `{max}` on the tenant security-policy page (enforcement unaffected).
- Resolution: **Fixed in plan** (merged with T2 — automated guard added to C10).

### S3 — Minor — `crypto-recovery.ts:170,279` bare literal 256 escapes acceptance greps
- Evidence: line 170 `{ name: "AES-GCM", length: 256 }` (no named constant at all); line 279 `deriveBits` 256.
- Resolution: **Fixed in plan** (C1 adoption + acceptance grep extended).

### S4 — [Adjacent→Functionality] Minor — v1ApiKeyLimiter uses MS_PER_MINUTE not RATE_WINDOW_MS
- Routed to Functionality scope; accepted for domain-naming consistency.
- Resolution: **Fixed in plan** (folded into C3).

Security verified-clean highlights: all 4 crypto params numerically identical across all 7 files (direct read incl. crypto-server.ts) — consolidation cannot silently change crypto behavior; HKDF/AAD untouched; PBKDF2_ITERATIONS already client-bundled (no new exposure); 15-min migrateLimiter correctly kept out of C3; API_ERROR codes self-keyed; JIT/delegation TTL display↔enforcement alignment is a net security improvement; no security-relevant interval value changes; RS4 plan file clean. No Critical findings; escalate: false throughout.

## Testing Findings

### T1 — Major — AUTH_TAG_LENGTH (and AES_KEY_LENGTH) have no value-pin test
- Evidence: `e2e/helpers/crypto.test.ts:35,42` pins PBKDF2_ITERATIONS and IV_LENGTH via CRYPTO_CONSTANTS; CRYPTO_CONSTANTS does not expose AUTH_TAG_LENGTH; aad-parity vectors pin AAD bytes, not cipher params; HEX_AUTH_TAG_LENGTH=32 independently hardcoded.
- Fix: pin `AUTH_TAG_LENGTH === 16` and `AES_KEY_LENGTH === 256` importing directly from crypto-params.ts.
- Resolution: **Fixed in plan** (C1 acceptance + testing strategy).

### T2 — Major — C10 placeholder completeness has no automated guard
- Evidence: all TenantAdmin TTL keys currently called with NO argument object; no TenantAdmin en/ja parity test; next-intl missing-arg is not a compile error; missed site renders literal `{max}`.
- Fix: createTranslator-based formatting test over the 8 changed keys × both locales asserting no literal braces + constant value present; call-site argument grep in acceptance.
- Resolution: **Fixed in plan** (C10 testing guard added).

### T3 — Minor — new extension constants unguarded by sync/value-pin tests
- Evidence: extension-constants-sync.test.ts guards only 5 bridge constants; 29 raw "AUTOFILL_FILL" literals in extension tests bypass the constant.
- Resolution: **Fixed in plan** (merged with S1 — C11 acceptance).

### T4 — Minor — test files assert raw "NOT_FOUND" literals
- Evidence: `src/__tests__/api/passwords/history*.test.ts`, `share-links/delete.test.ts`, `teams/team-history*.test.ts`, `helpers/mock-team-auth.ts`.
- Resolution: **Fixed in plan** (C9 extended to update test assertions/helpers).

## Adjacent Findings
- S4 routed Security → Functionality (accepted, folded into C3). No other adjacent findings.

## Quality Warnings
None (merge-findings quality gate raised none; all findings carried file:line evidence).

## Recurring Issue Check

### Functionality expert
- R1 checked-clean; R2 checked-clean (plan IS the R2 sweep, inventory verified); R3 finding-raised (F1, F4); R4–R11 N/A (no webhooks/migrations/DB roles/E2E selectors touched); R12 checked-clean (ACTOR_TYPE 5/5 values); R13–R16 N/A; R17 checked-clean (F2 flags undocumented rename); R18 N/A; R19 checked-clean; R20–R21 N/A; R22 finding-raised (F4; KDF_PBKDF2_ITERATIONS_MIN correctly excluded as semantically distinct); R23–R24 N/A; R25 checked-clean (storage keys value-identical); R26 N/A; R27 finding-raised (F1 extends C10); R28–R32 N/A; R33 checked-clean (no CI change); R34–R36 N/A; R37 checked-clean.

### Security expert
- R1–R26 checked-clean or N/A as itemized (no secrets moved, no IV/nonce logic touched, no session/CSRF/XSS/SQLi surface; R25 storage keys value-identical clean); R27 finding-raised (S2); R28–R37 N/A or checked-clean (R30 token prefixes value-identical; R31 no destructive ops; R37 AAD contract untouched, verified by codebase read).
- RS1 N/A (no new secret comparisons); RS2 N/A (no new routes); RS3 N/A (no new input paths); RS4 checked-clean (plan file contains no personal data).

### Testing expert
- R1–R26 checked-clean or N/A as itemized (R7 E2E selectors clean — 9+ specs scanned; R19 no mocks import the new crypto-params module; R22 audit-bypass-coverage uses containment only, no ordering assumption); R27 finding-raised (T2); R28–R37 N/A or checked-clean.
- RT1 checked — no mock-reality divergence (NOT_FOUND values identical; CLI 3600 fallback pinned correctly). RT2 checked — value-pins concrete; aad-parity has anti-vacuous negative test; no always-pass tests. RT3 checked — extension/cli test commands confirmed from package.json; pre-pr.sh runs neither (VE2 accurate). RT4 checked — acceptance greps mechanically valid. RT5 finding-raised (T2). RT6 finding-raised (T3).

---

# Round 2 (incremental)
Date: 2026-06-13

## Changes from Previous Round
All 13 Round-1 findings reflected into the plan: C10 expanded to 8 keys + automated interpolation test; C4 watchtower rename explicit; C1 extended (vault/setup fallback, crypto-recovery sites, value-pin tests, forbidden-pattern rescope); C3 includes v1ApiKeyLimiter; C9 test alignment; C11 adoption list + twin-sync test.

## Functionality Findings (Round 2)
- F6 — Major — `VERIFIER_PBKDF2_ITERATIONS = 600_000` (crypto-client.ts:22) missing from C1 named exclusions → acceptance grep would falsely fail on a legitimate, semantically distinct survivor. **Fixed in plan** (named exclusion added).
- F7 — Minor — authTag slice count: actual is 8 pairs (export-crypto ×1, not ×2). **Fixed in plan** (orchestrator re-verified by grep: 16 lines = 8 pairs).
- F8 — Minor — `length: 256` grep cannot match the bare deriveBits `256`; semantic concern overlaps S5. **Fixed in plan** (deriveBits companion check + VERIFIER_BITS).
- F9 — Minor — ja min-phrase acceptance grep was vacuous (`最低でも60` never matches the actual `60秒以上`). **Fixed in plan** (locale-neutral key-scoped grep).
- F10 — Minor — SC4 mis-attributed VERIFIER_PBKDF2_ITERATIONS location. **Fixed in plan** (both homes named: src crypto-client.ts:22, cli crypto.ts:17).
- F11 — Minor — C3 literal grep cannot see `windowMs: MS_PER_MINUTE` in rate-limiters.ts. **Fixed in plan** (companion grep added).

## Security Findings (Round 2)
- S5 — Minor — crypto-recovery deriveBits 256 is HKDF verifier bits, not an AES key; labeling it AES_KEY_LENGTH would be semantically wrong. **Fixed in plan** (file-local `VERIFIER_BITS = 256`, precedent `VERIFIER_PBKDF2_BITS` in crypto-client.ts:23). escalate: false.
- S6 — Advisory — `common.server.ts` boundary is comment-only; pre-existing live violation: `notification-bell.tsx` ("use client") imports NOTIFICATION_BELL_LIMIT from it. **Fixed in plan** as new contract C13 (move constant to common.ts — orchestrator verified: only violating importer; `s/[token]/page.tsx` is a server component, fine). Build-enforced `server-only` guard deferred to SC6 with quantified Anti-Deferral entry (new dependency required — package not installed, verified). escalate: false.
- S7 — Minor — same root cause as F6 (named exclusion gap). **Fixed in plan** (merged with F6).
- Verified clean: vault/setup `?? 600_000` is genuinely the PBKDF2 default (Zod min guard separate — behavior identity confirmed); rate-limiters.ts server-only (importers: api/v1 routes + migrate route); no AAD/HKDF strings touched by round-2 edits.

## Testing Findings (Round 2)
- T5 — Major(MEDIUM) — PrivacyPolicy `{iterations}` call site (privacy-policy/page.tsx:74 renders with no values) had no paired step, no acceptance grep, no test coverage. **Fixed in plan** (mandatory paired step; `grep '600,000' messages/ → 0`; interpolation test extended to sections.security.body).
- Implementation notes adopted: createTranslator import source is `use-intl/core` (next-intl core re-export; transitive dep, ESM-OK under Vitest 4); e2e/helpers/crypto.test.ts confirmed inside default vitest include (value-pins will run in CI); extension twin-sync test feasible via the existing `?raw`-import pattern (`token-bridge-js-sync.test.ts` precedent); interpolation test is a post-migration guard (vacuous pre-migration) — acceptance greps are the migration-time gate, now stated in plan.
- RT2/RT5/RT6 re-checked: crypto pins and twin-sync non-vacuous; build-enforcement claim accurate.

## Adjacent Findings (Round 2)
- S6 routed Security → Functionality/plan-scope (accepted as C13 + SC6).

## Quality Warnings (Round 2)
None.

## Recurring Issue Check (Round 2)
- Functionality: R3 finding-raised (F6/F8/F9/F11 — acceptance-criterion propagation gaps, all fixed); R27 finding-raised (F9, fixed); all other rules unchanged-from-R1/N-A; R37 clean (no constant value affected by any round-2 edit).
- Security: R2 clean (updated inventory verified); R3 finding-raised (S7, fixed); R27 clean post-fix; RS1–RS3 N/A; RS4 clean (updated plan file re-checked — no personal data).
- Testing: RT1 clean; RT2 re-checked (one acknowledged post-migration-guard property, mitigated by acceptance greps, now documented in plan); RT3 clean (stateless tests); RT4 clean (production artifacts tested); RT5 finding-raised→resolved (T5); RT6 clean.

---

# Round 3 (final verification)
Date: 2026-06-13

## Changes from Previous Round
All 8 Round-2 findings (F6-F11, S5-S7, T5; F6=S7 and F8=S5 shared root causes) reflected into the plan: C1 named-exclusion completion + VERIFIER_BITS semantic split; count corrections; locale-neutral C10 acceptance greps; PrivacyPolicy paired step + test coverage; C3 companion grep; new C13 + SC6.

## Findings
**No findings.** Combined verification pass (all three perspectives) confirmed every Round-2 fix landed correctly:
1. OK — C1 named exclusions complete (KDF min guard, prisma pool, VERIFIER_PBKDF2_ITERATIONS with both homes).
2. OK — authTag prose: 8 pairs / 16 lines, export-crypto ×1.
3. OK — deriveBits site → file-local VERIFIER_BITS, companion grep present; line 170 stays AES_KEY_LENGTH.
4. OK — locale-neutral key-scoped min-bound grep (catches ja 60秒以上).
5. OK — SC4 attribution corrected (both file homes).
6. OK — C3 companion grep for v1ApiKeyLimiter.
7. OK — C13 fully specified; SC6 deferral quantified; gate updated.
8. OK — PrivacyPolicy paired step + grep '600,000' + test covers sections.security.body.
9. OK — createTranslator source documented; post-migration-guard vacuity documented with greps as migration gate.
Cross-checks: Go/No-Go lists C1-C13; no C13↔C3/C5 contradiction; RS4 clean; notification-bell.tsx confirmed the sole component importer of common.server (live grep).

## Recurring Issue Check
- Functionality: unchanged from R2; R3/R27 re-verified clean.
- Security: unchanged from R2; RS4 re-verified clean on updated plan.
- Testing: unchanged from R2; RT2/RT5 re-verified clean.

## Outcome
Plan review CONVERGED in 3 rounds. All 13 contracts flipped to `locked` in the Go/No-Go gate. Proceeding to Phase 2.
