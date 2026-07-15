# Plan Review: p1-supply-chain-provenance
Date: 2026-07-16

## Round 1
Three experts reviewed against the real repo + live npm registry. Local-LLM pre-screen ran first (3 items addressed pre-review). Findings summary: 0 Critical, 5 Major, 3 Minor.

### Round 1 Major
- **M1** (Func F1 + Sec SEC-2 convergence): crypto/auth manifest covered only `src/**`; CLI (`bcrypt-pbkdf`, `otpauth`) + extension (`otpauth`) crypto deps invisible. → Extended GT-6 to all 3 workspaces.
- **M2** (Func F3 + Sec SEC-1 convergence): `npm audit signatures` temporal/path-gating hole. → Added weekly cron sweep workflow.
- **M3** (Sec SEC-3): forbidden-pattern guards inert unless wired into `pre-pr.sh` run_step. → Made wiring an explicit deliverable with negative self-tests.
- **M4** (Test F1+F6): C4 completeness + hash-wasm dynamic-import resolver no proven-can-fail. → Pure exported functions + per-function RT7 self-tests.
- **M5** (Test F2+F3): C2 / C3 verifiers lack negative self-tests. → C2 can-fail demonstration in Phase 2 + C3 pure-function guard + synthetic fixture.

### Round 1 Minor
- **m1** (Func F2): prisma pair listed but outside drift roots. → three-set reconciliation with (C) + `detectedBy:["manual"]`.
- **m2** (Sec SEC-4): `publishConfig.provenance` fail-open on OIDC-context loss. → INV-C1b post-publish assertion.
- **m3** (Test F4+F5+F7): C1 shape "or", C2 no pre-pr mirror, changes-filter mapping. → concrete named test, offline-safety Anti-Deferral, mapping recorded.

**Round 1 also incorporated the user's directive** to redesign C4 as a THREE-SET reconciliation (CODE ∪ DEPS ∪ MANIFEST), object-keyed manifest with `detectedBy`/`owners`/`reason`, failing on (A) unregistered import, (B) manifest-vanished, (C) sensitive-in-deps-not-in-code (reasoned manual allowance), (D) empty reason/owners.

## Round 2
Incremental review of the revised plan. Summary: 0 Critical, 2 Major (both member-set/control gaps in the not-yet-implemented plan, correctable before merge), 5 Minor. One Round-1 fix (F2/prisma) produced a self-contradiction that R2 caught.

### Round 2 Major (adopted)
- **SEC-5** (Sec + Func F-R2-1 convergence — both experts independently reached `nodemailer`): `nodemailer` (^9.0.1) + `resend` (^6.9.2) are real magic-link auth-channel deps bare-imported at `src/lib/email/smtp-provider.ts:1` / `resend-provider.ts:1`, outside the original CODE roots, listed in neither `packages` nor `excluded`. **Self-verified true.** → Added `src/lib/email/**` to CODE roots; added `nodemailer`+`resend` as `auth-flow`/`static-import` members.
- **SEC-6** (Sec): the (C) `detectedBy:["manual"]` allowance is an in-PR self-service bypass unless bound to CODEOWNERS + a validated `owners`. **Self-verified**: `.github/CODEOWNERS` gates `/scripts/checks/**` (manifest) but NOT `src/__tests__/checks/**` (the enforcing test). worker-policy template uses a `>=10-char reason` floor. → INV-C4f (CODEOWNERS-gate both files), reason ≥10 chars, `owners` from a fixed enum.

### Round 2 Minor (adopted)
- **SEC-7** (Sec): INV-C1b `npm view | jq -e` conflates absent-attestation vs network error, no pipefail. → prefer `npm audit signatures` post-publish; if `npm view`, pipefail + exit-check + predicateType assertion + retry-on-absent-only. Also verified: no `require()` of a crypto/auth dep in any workspace → dropped `require` from the `detectedBy` enum.
- **m2 / F-R2-2** (Func, both rounds converge): prisma pair now in drift roots (`src/lib/prisma.ts` static import) → `detectedBy:["static-import"]`, not `manual` (the `manual` claim would trip the import-evidence contradiction check). → Corrected.
- **m3** (Func): `@prisma/client` is a data-access boundary, not a crypto primitive. → `category: db-identity-store` with a note.
- **T1** (Test): (B) presence lacked a *unit* negative self-test (only committed-tree mutation). → Added.
- **T2** (Test): (C)'s `dynamic-import`-confirmed suppression branch unproven at unit level. → Added a self-test row for that third branch.
- **T3** (Test): DEPS name-pattern heuristic (R-3 backstop) had no pattern list + no self-test. → Enumerated the regex set + negative self-test.

### Round 2 Rejected (hallucination, self-verified)
- **M1** (Func Round-2, first pass): "extension uses `@simplewebauthn/browser`, add it + make exclusions workspace-scoped." **REJECTED**: `@simplewebauthn/browser` is ABSENT from `extension/package.json` and NOT imported in `extension/src/**`; `webauthn-client.ts:5` is a comment saying the app deliberately uses the raw WebAuthn API. The **workspace-scoped exclusions** design principle was adopted; the `@simplewebauthn/browser` addition was not. (The Functionality expert self-corrected this in its final pass, converging with the Security expert.)

## Convergence & verification note
Both the member-set gaps (`nodemailer`/`resend`) were reached independently by the Functionality and Security experts (Round-2 SEC-5 / F-R2-1). Every load-bearing member-set claim was self-verified against the code by the orchestrator, because a prior investigation sub-agent had hallucinated non-existent files earlier this session — `nodemailer`/`resend`/`bcrypt-pbkdf`/`otpauth`×3 confirmed real; `@simplewebauthn/browser` confirmed absent. R42 was applied by re-deriving the three-workspace member-set from code, not from any supplied list.

## Quality Warnings
None — all findings carried concrete file/line evidence and verified repro.

## Recurring Issue Check (condensed, both rounds)
- **R42** (member-set code-derived): CENTRAL — drove M1/SEC-2 (3-workspace), SEC-5/F-R2-1 (email transports), and rejected the hallucinated extension webauthn addition. Final member-set re-derived from code across all 3 workspaces.
- **R44 / RS5** (masked exit / fail-open): C2 anti-mask grep + wired guard + INV-C1b pipefail (SEC-7); no auto-merge (INV-C3a).
- **R41 / RS2 / RS6** (unenforced capability, ungated surface, weak metadata gate): SEC-6 — CODEOWNERS-gate the enforcing test + reason floor + owners enum.
- **RT7** (every guard proven-can-fail): all pure detection functions (drift/presence/reconciler-3-branches/metadata/dynamic-resolver/name-heuristic) now carry unit negative self-tests (INV-C4d).
- **R29** (external spec citation): npm OIDC provenance + SLSA predicateType claims verified against the live GT-1 registry measurement.
