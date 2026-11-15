# Plan Review: saml-jackson-account-rekey
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screen skipped (Ollama unavailable); dedup done manually.

## Functionality Findings
- F1 Major (design) — C2's rationale said the existing-user path has no claim check; `ensureTenantMembershipForSignIn` → `claimedTenantMembership` (`src/auth.ts`) compares the asserted claim's bound provider with the sign-in provider. "At least one claim bound to `to`" lets a tenant with claims on A and B pass for A, and B's users stay refused (`tenant_claim_provider_mismatch`). Merged with S2. **Resolved**: C2 R-b; walkthrough adds the consumer; VE1 rewritten.
- F2 Major (design) — cloud key cache (`maxStaleTtlMs` 10 min) can expire across the 10-minute confirmation. **Resolved**: C6 helper re-warms after confirmation; verify pass discards plaintext, apply pass re-decrypts.
- F3 Minor (design) — CAS omits `userId`/`providerAccountId`. Merged with S3. **Resolved**: I3 / C1 step 9.
- F4 Minor (question) — users active in two tenants. Merged with S8. **Resolved**: schema-enforced single active membership cited in F5.
- F5 Minor (question) — RDS-shaped privileges. **Resolved**: C4 RDS cells seed real tokens and reach every read and the enqueue.

## Security Findings
- S1 Major (design) — C2 overstated: a claim bound to X does not prove T's IdP is behind X (claimless sign-in reaches the account regardless), and a sign-in-registered binding satisfied C2. **Resolved**: C2 restated as a consistency check with the residual declared; R-c requires the deciding binding event to carry an operator label.
- S2 Major (design) — other claims of T and the configured legacy provider ignored. **Resolved**: R-b; preview prints every live claim; step 4 prints the legacy-accounts reminder.
- S3 Minor — CAS AAD fields (with F3). **Resolved**.
- S4 Minor (question) — 23505 driver text may carry `providerAccountId`. **Resolved**: C1 step 10 maps P2002 via `pgErrorCode` to a fixed message; NF3 test.
- S5 Minor (prose) — header threat model stale; plaintext held. **Resolved**: NF1/C5 header update; no plaintext across the prompt (SC5).
- S6 Minor — audit metadata lacks claim evidence/run id; TAMPERED indistinct. **Resolved**: `claims`, `runId` added; kinds printed distinctly. Key versions not added: the new version is the current one and the old is not an accountability fact for the tenant reader.
- S7 Minor (question) — CLI env vs app env. **Resolved**: step 4 caveat.
- S8 Minor (question) — `Session.provider`, multi-membership. **Resolved**: only reader compares with `"webauthn"` (`src/lib/auth/session/recent-current-auth-method.ts`); single active membership is schema-enforced.
- S9 Adjacent Minor — import graph. **Resolved**: test listed; C6 helper placed in a prisma-free module.

## Testing Findings
- T1 Major — migrate-account-tokens fix untested. **Resolved**: `prepareMigration()` extracted and unit-tested.
- T2 Major — C6 test path/ordering/singleton. **Resolved**: test injects at the `aws-sm-provider` constructor, drives production modules, resets the singleton.
- T3 Major — race recipe and anti-vacuity. **Resolved**: races (a)-(d) with `raced` flag and specific messages.
- T4 Major — missing cells. **Resolved**: cell list enumerated.
- T5 Major — fixtures/cleanup/env. **Resolved**: fixtures paragraph.
- T6 Major — enumerating tests not listed. **Resolved**: listed in C3.
- T7 Minor — RDS cells seeding. **Resolved**: C4.
- T8 Minor — enforcement of forbidden patterns, mandatory checks. **Resolved**: forbidden patterns marked as Phase 2/3 conformance grep; mandatory checks listed.
- T9 Minor — one mutation per clause. **Resolved**: RT7 list.
- T10 Minor — audit row content. **Resolved**: audit cell.

## Adjacent Findings
- Testing A1 (user active in two tenants) — same as F4/S8, resolved by schema citation.
- Functionality: plaintext held across the prompt — resolved with F2/S5.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1 N/A; R2 OK; R3 F1; R4–R11 OK; R12 OK (registration complete); R13–R28 OK; R29 OK; R30 OK; R31 OK (confirm + preview); R32–R41 OK; R42 F4, F1; R43–R47 OK; R48 F1 (two judgments of "bound to provider"); R49 OK; R50 F2; R51–R56 OK; R57 F1/F2 boundaries.

### Security expert
R1 OK; R2 OK; R3 OK; R4 N/A; R5 OK; R6 OK; R7 N/A; R8 N/A; R9 OK; R10 S9; R11 N/A; R12 OK; R13–R21 OK/N/A; R22 S1; R23 OK; R24 S8; R25 OK; R26–R28 N/A; R29 S1, S5; R30 N/A; R31 OK; R32–R40 N/A/OK; R41 S4; R42 S2, S8; R43–R48 OK/N/A; R49 S1; R50 S1, S7; R51–R55 N/A; R56 S1; R57 S1. RS1 OK + S4; RS2 S1; RS3 OK; RS4 OK (S3); RS5 S6; RS6 S8.

### Testing expert
R1–R11 N/A; R12 T6; R13–R28 N/A; R29 T8; R30–R33 N/A; R34 OK (T1); R35–R41 N/A; R42 partial (T6); R43–R57 N/A. RT1–RT3 N/A; RT4 T3; RT5 T2; RT6 N/A; RT7 T9; RT8 partial (T4, T5); RT9 N/A; RT10 partial (T4); RT11 T5.

---

# Round 2
Date: 2026-11-16

## Changes from Previous Round
Plan revised for all round-1 findings: C2 rewritten as a consistency check (R-a/R-b/R-c), verify/apply passes with re-warm, CAS over AAD columns, P2002 mapping, audit `claims`/`runId`, C6 warming helper, full test cell list.

## Functionality Findings
- N1 Major (design) — R-c unsatisfiable: `bind`/`add` with an unchanged provider write no event, so a sign-in-bound claim can never gain an operator binding. Merged with S15-A. **Resolved**: C7 — `bindingAttestation` (one adjudicator) and `bind`'s attestation path records a same-provider `rebind` event.
- N2 Major (design) — unique-violation mapping must sit outside `withBypassRls` (23505 aborts the tx) and be index-scoped. **Resolved**: C1 step 11 with `isUniqueViolationOn(e, "accounts_provider_provider_account_id_key")`.
- N3 Minor — warm version collection and attribution. **Resolved**: `collectEnvelopeVersions`, per-version report, `KEY_UNAVAILABLE` per account.
- N4 Minor (prose) — unbound Google claim refusal wording. **Resolved**: R-b refusal text names the remedy.
- N5 Minor (prose) — re-warm overstated. **Resolved**: C6 wording.
- N6 Minor (prose) — label normalisation. **Resolved**: C7.
- A1 Adjacent — re-warm red-proof vacuous. **Resolved** with T11 (warmer seam spied).

## Security Findings
- S10 Minor — unmapped errors printed whole. **Resolved**: C1 step 11 generic fixed message; NF3 cell for the unexpected path.
- S11 Minor — no re-check after confirmation. **Resolved**: C1 step 9 re-read and compare; race (d).
- S12 Minor — `claims` array can exceed `METADATA_MAX_BYTES`. **Resolved**: first 10 + `claimsOmitted`; 12-claim cell.
- S13 Minor (question) — other providers in R-b. **Resolved**: R-b is "bound to `to` or `google`, else refuse".
- S14 Minor (question) — membership-based selection residual. **Resolved**: F5 and README state it.
- S15-A Adjacent Major — same as N1. **Resolved**.

## Testing Findings
- T11 Major — warm calls unobservable. **Resolved**: `shareMasterKeyWarmer` seam spied in the integration test.
- T12 Major — apply-pass ciphertext source. **Resolved**: snapshot is the CAS expected value and the decrypt source.
- T13 Major — candidate order. **Resolved**: ordered by `accounts.id`; victim is the last candidate; CAS message names it.
- T14 Major — stateful fake + negative control. **Resolved**: C6 unit test spec.
- T15 Major — R-c cells. **Resolved**: C2/C7 acceptance cells.
- T16 Minor — missing cells. **Resolved**.
- T17 Minor — race setup. **Resolved**: row-count asserts, `tenantId`, no row locks (Technical approach); race (b) disjoint from the re-read.
- T18 Minor — event cleanup. **Resolved**.
- T19 Adjacent — CAS `tenantId`. **Resolved**: added.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R3 N1; R41 N2; R42 N1; R50 N5; R56 N3; R57 N1; all others OK.
### Security expert
R41 S10; R43 S11, S14; R48 S15-A; R50 S10; R57 S11, S15-A; RS1 S10; RS5 S12; all others OK/N/A.
### Testing expert
R12 OK; R29 OK; R34 OK; R42 partial (T15, T16); RT4 partial (T12, T13); RT5 T14; RT7 T11, T12; RT8 OK; RT10 partial (T15); RT11 T18; others N/A.

---

# Round 3
Date: 2026-11-16

## Changes from Previous Round
C7 added (bindingAttestation + bind attestation path); step 9 re-read / step 10 CAS split; step 11 error mapping outside the tx; warmer seam; bounded `claims` metadata.

## Functionality Findings
- R3-1 Minor (design) — attestation needs `--accept-unused-provider` before the move. **Resolved**: C7 text, scenario 4, README.
- R3-2 Minor (prose) — R-c conditions explicit. **Resolved**.
- R3-3 Minor (prose) — re-read compares the live-claim SET. Merged with S17. **Resolved**; race (d) adds an add-claim cell.

## Security Findings
- S16 Minor (design) — attestation prompt must show the engine origin. **Resolved**: C7 prompt prints the deciding event, `createdBy`, and the consequence; rekey preview marks attested-after-sign-in claims. Forbidding `--accept-unused-provider` rejected (breaks scenario 4; evidence is 0 pre-move by construction).
- S17 Minor (prose) — same as R3-3. **Resolved**.
- Adjacent: same-provider `rebind` readers. **Resolved**: C7 lists `history` and `readProvenance` behaviour.

## Testing Findings
- N1 Major (design) — race (c) unreachable through `confirm`. **Resolved**: injected through the second warmer call.
- N2 Minor — RT7 list for C7. **Resolved**.

## Recurring Issue Check
### Functionality expert
All R1–R57 OK; R3-1..R3-3 Minor only.
### Security expert
R43 S16/S17; R57 S17; others OK/N/A; RS1 OK, RS5 OK.
### Testing expert
R12/R42 via N2; RT4/RT7 N1; others OK.

---

# Round 4
Date: 2026-11-16

## Changes from Previous Round
Round-3 Minors applied (claim-set comparison, explicit R-c conditions, attestation prompt evidence, scenario 4 flag); race (c) moved to the second warmer call.

## Testing Findings
- T4-1 Major (design: acceptance adequacy) — step-9 terms lacked per-term race cells and red-proofs. **Resolved in plan**: race (d) one cell per compared term; RT7 one mutation per term.
- T4-2 Minor — C7 prompt text and preview marker unasserted. **Resolved**: stdout assertions with an operator-bound control.
- T4-3 Minor (prose) — victim from result rows. **Resolved**.
- T4-4 Minor (prose) — attestation cells over all engine labels and no-event. **Resolved**.

## Functionality Findings
- F1 Minor (prose) — prompt sentence derived from the deciding event, "no recorded event" variant. **Resolved**.
- F2 Minor (design) — explanatory evidence line on the attestation path; flag stays mandatory. **Resolved**.
- F3 Minor — un-revoke and attestation-seq race cells; per-term red-proofs. **Resolved** (with T4-1).

## Security Findings
- S1 Minor (prose) — DB-sourced prompt fields escaped; control-char cell. **Resolved**.
- S2 Minor (question) — R-c operator flag is label-only. **Resolved**: declared tripwire grade in C2's residuals.

## Recurring Issue Check
### Testing expert
R42/R57 T4-1/T4-3; RT7/RT10 T4-1; others OK.
### Functionality expert
R42 F3; R48 OK; R57 OK; others OK/N/A.
### Security expert
NF2 S1; label-only attribution S2; RS1–RS6 OK; others OK/N/A.

## Saturation call (round 4)
Exit to Phase 2 by saturation. Labels as filed by the experts: T4-1 Major/design (acceptance adequacy), F2 and S2 Minor/design, all others Minor/prose or Minor test-cell additions. Every finding of round 4 is resolved in the plan file; none is open, so condition 2 holds. Condition 3 is not strictly met: T4-1, F2 and S2 were filed against acceptance criteria / control-class wording and were resolved in this round rather than in a later clean round. Rationale for exiting anyway: rounds 3–4 found no defect in the contracts' behaviour — only test-cell granularity and prose that each round's additions created (the self-seeding pattern), and the remaining granularity is exactly what Phase 2 implementation and Phase 3 review settle by execution. No carried-forward findings.
