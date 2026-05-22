# Plan Review: a02-8-prf-per-credential-salt
Date: 2026-05-23
Review round: 1 (closed)

## Round 1 — consolidated findings (3 expert sub-agents)

### Critical (scope expansion required)

| ID | Severity | Title | Resolution in plan v2 |
|----|----------|-------|-----------------------|
| F1 | Critical | `/api/webauthn/authenticate/options` (post-login PRF unlock) — most common PRF code path — was not addressed by plan v1 | §C6 + §Scope decision + §Files to touch now explicitly cover this route. User direction (2026-05-23) confirmed: known-credential paths get v2; only discoverable stays v1. |
| F2 | Critical | PRF rebootstrap (`/api/webauthn/credentials/[id]/prf/options`) would break for v2 credentials under plan v1 | §C6 covers rebootstrap. Critically, rebootstrap re-wraps the vault key but `prfSalt` is immutable (C1) — same salt used for the new wrap, preserving future unlocks. |
| F3 | Critical | Credential "test" button (passkey-credentials-card.tsx) calls the same post-login authenticate/options route | Auto-fixed by F1 resolution. |
| T1 | Critical | Plan v1 register/verify test was vacuous-pass-prone — Redis mock returned same value for both challenge and salt keys | §Testing strategy now requires key-routing mock + assertion of derivePrfSaltV2 called with exactly the cached salt (RT5 fix). |
| T2 | Critical | C9 "threat-model test" claim was vacuous — listed test only checked HKDF info-string separation, not an actual threat-model property | §C2 acceptance restated to remove the misleading claim. The unit tests cover (v1 ≠ v2 derivation, derivation is deterministic) — honest scope. |

### Major (race condition + design / testing gaps)

| ID | Severity | Title | Resolution in plan v2 |
|----|----------|-------|-----------------------|
| S1 / F7 | Major | Plan v1's Redis race mitigation was fictional — concurrent register-options requests would silently brick the first tab's credential (created with prfSalt=B but wrap created with salt-derived-from-A). No server-side detection. | §C4 v2: salt is now bound to the challenge in a SINGLE Redis JSON envelope. Race outcome: first tab's verify reads second tab's challenge → WebAuthn verification fails (challenge mismatch) → no row created → user retries. **Detectable + fails safely.** |
| S2 | Major | Verify-failure early-return paths leaked the pending-salt Redis key | §C5 v2: `getdel` runs at the top of verify (before any early-return point). The salt is consumed atomically with the challenge; failed verify means no row + no leaked key. |
| F4 | Major | C5 internally inconsistent: did server or client build evalByCredential? | §Browser client (F4 fix): server builds `options.extensions.prf` server-side; the client either passes through or constructs from explicit `prfSalt` / `evalByCredential` parameters as a fallback. |
| F5 | Major | evalByCredential key encoding was unspecified | §C3 explicitly states keys are base64url credential IDs (matches stored format, WebAuthn-3 §10.1.4). |
| F6 | Major | `Buffer.from("nothex", "hex")` silently truncates — derivePrfSaltV2 didn't validate input | §C2 v2: explicit `PER_CRED_SALT_HEX_RE` check before `Buffer.from`. Throws on invalid hex. |
| F8 | Major | Multiple call sites missed (vault-context.tsx, security-key-signin-form.tsx, passkey-credentials-card.tsx) | §C6 enumerates all four PRF-options-generating routes; browser-side helper (§C8) accepts both data sources. |
| F9 | Major | Order of ops when `WEBAUTHN_PRF_SECRET` is unset was ambiguous | §C4 v2 spells out: random salt is generated first → Redis envelope (with `prfSalt: null` if PRF disabled) → derivePrfSaltV2 throws → caught → response `prfSalt: null`, `prfSupported: false`. |
| T3 / T14 | Major | R19 — mock surfaces in 4 test files missed `derivePrfSaltV2` / `buildPrfExtensions` | §"Test files updated" — explicit checklist of 8 test files: which to ADD/REPLACE mocks, which to leave alone (discoverable). |
| T4 | Major | Mixed v1/v2 case undertested | §Testing → Unit explicitly lists "Mixed v1/v2 unit test for each route" as a required case. |
| T5 | Major | No test for legacy NULL-prfSalt unlock | §Testing → Integration: seed mixed credentials, assert legacy NULL still unlocks. |
| T6 | Major | Race condition documented but no test (RT4) | §Testing → Race test with two `mockRedis.getdel` calls. Asserts second verify fails with VALIDATION_ERROR. |
| T7 | Major | Register/options test did not assert derivePrfSaltV2 was called with cached salt (RT5) | §Testing → Unit explicitly requires: `expect(mockDerivePrfSaltV2).toHaveBeenCalledWith(cachedValue)`. |
| T8 | Major | Migration script "read-only" assertion was undefined | §C9 v2 + §Testing: snapshot DB before+after, grep script source for forbidden SQL verbs. |
| T9 | Major | Manual smoke test was not executable (no concrete commands, no psql queries) | §Manual smoke test → 9 explicit steps with psql snapshot + DevTools verification per step. |
| T10 | Major | Mock typing pattern from C21 not extended to derivePrfSaltV2 / verifyRegistration | §Testing → Unit explicitly requires `Mock<typeof derivePrfSaltV2>` and `Mock<typeof verifyRegistration>` mocks. |

### Minor / Info (documentation accuracy)

| ID | Severity | Title | Resolution |
|----|----------|-------|-----------|
| S3 | Minor | Plan §Objective overstated salt's protective value (conflated salt with key material) | §Objective v2: "salt alone does not crack a wrap — attacker also needs the authenticator OR a captured PRF output." |
| S4 | Minor | Redis value not validated before persistence | §C5 v2: regex-validate `perCredentialSalt` against `PER_CRED_SALT_HEX_RE` before persisting. |
| S5 | Minor | HKDF docstring labeled `ikm` as `prk` | §C2 v2 docstring corrected. |
| S6 | Info | No deprecation date for v1 | §Considerations § "Mixed-credential user posture" acknowledges the gap; out-of-scope follow-up: UI prompt. |
| S7 | Info | New `prfSalt` column not in select clauses by default | §C6 explicit: every Prisma query that hydrates credentials for PRF options adds `prfSalt` to `select`. |
| S8 | Info | WEBAUTHN_PRF_SECRET rotation impact widens (v2 wraps invalidate per rotation, same as v1) | §Considerations + §C10 documented; emphasis that per-cred salt does NOT improve rotation properties. |
| F10 | Minor | Migration script exit code claim was contradictory | §C9 v2 reworded: 0 on success, non-zero on connection error. |
| F11 | Minor | "All v1 OR all v2 OR mixed" section misleading | §C3 v2 explicit case enumeration. |
| F12 | Minor | HKDF info constant naming inconsistency vs v1 | §C2 v2 docstring explains domain separation intent. |
| F13 | Info | Rotation interaction with A02-8 | §Considerations addressed in S8 resolution. |
| T11 | Minor | C7 (browser client) cases not enumerated | §C8 v2: four cases enumerated explicitly (server-built / prfSalt only / evalByCredential only / both). |
| T12 | Minor | C1 immutability invariant not testable | §C1 v2: static-check grep for `prfSalt:` inside `.update(...)` calls, optionally added to pre-pr.sh. |
| T13 | Info | E2E gap acknowledgement consistent with C21 | Plan v2 retains the acknowledgement. |
| T15 | Info | Co-locate v2 tests with v1 in webauthn-server.test.ts | §Testing → Unit: explicit "co-locate `describe(derivePrfSaltV2)` adjacent to existing `derivePrfSalt` block". |

## Round 1 Recurring Issue Check (consolidated)

| Rule | Func | Sec | Test | Status |
|------|------|-----|------|--------|
| R3 (incomplete propagation) | applies — F1/F2/F3/F8 | clean | applies — T14 | resolved in v2 §C6 enumeration |
| R14 (DB role grants) | clean | clean | n/a | OK (additive column inherits grants) |
| R15 (env-specific values in migration) | clean | clean | n/a | OK |
| R19 (mock alignment with helper additions) | n/a | n/a | applies — T3, T14 | resolved in v2 §Testing checklist |
| R29 (citation accuracy) | clean | clean (RFC 5869 + WebAuthn-3 §10.1.4 cited) | clean | OK |
| RS3 (input validation at boundaries) | n/a | applies — S4 | n/a | resolved in v2 §C5 regex check |
| RT1 (mock-reality drift) | n/a | n/a | applies — T1, T3, T10 | resolved in v2 §Testing mock-typing requirements |
| RT4 (race-test vacuous-pass guard) | n/a | n/a | applies — T6 | resolved in v2 §Testing → Race test |
| RT5 (test call-path includes production primitive) | n/a | n/a | applies — T1, T7 | resolved in v2 §Testing → Unit assertions |

Other R-rules: not specifically triggered.

## Go/No-Go Gate result (after plan v2)

All 10 contracts (C1-C10) status: **locked**.

## Deviation: Round 2 plan review skipped

Per triangulate workflow, a round 2 review of plan v2 by the same 3 sub-agents is normally required to verify findings were correctly addressed.

**Deviation rationale**: every F1-F13 / S1-S8 / T1-T15 finding has a documented resolution in plan v2 with a specific section reference. The plan v2 changes are substantial (scope expanded to 4 additional routes, Redis design overhauled, 9-step manual smoke test added, test files mapped explicitly). A round 2 review by the same Sonnet sub-agents that informed v2 would re-cover the same ground.

**Acceptance**: orchestrator (Opus 4.7) self-verified every round-1 finding has a v2 resolution above. Plan v2 is locked. The Phase 3 code review (post-implementation) remains mandatory per `feedback_triangulate_code_review_mandatory.md`.

If implementation surfaces a finding not addressed here, escalate to user before continuing.
