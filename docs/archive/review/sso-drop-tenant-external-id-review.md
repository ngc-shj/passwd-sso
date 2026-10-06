# Plan Review: sso-drop-tenant-external-id
Date: 2026-10-06
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screening: no issues.

## Functionality Findings

- **Func F1 [Major, design]** — `tenant-claim-registry.test.ts`'s drift-guard block mixes
  external_id-only cases with the CHECK-constraint guard for `NON_PRINTABLE_ASCII_SQL_CLASS`;
  C5's file-level wording risked deleting the latter. **Resolved**: C5 names the surviving and
  deleted cases per assertion, with an acceptance item.
- **Func F2 [Major, prose]** — `scripts/checks/worker-policy-manifest.json` lists `preflight` in
  the CLI's command set; no contract or gate covered it. **Resolved**: added to C4 and to the
  forbidden pattern.
- Noted, not a finding: `scripts/lib/tenant-domain-flags.ts` has nothing to change. Plan text corrected.

## Security Findings

- **Sec F1 [Major, design]** — removing `preflight` and the fold probe removes the only diagnostic
  for fold-collision orphans; a later sign-in could shadow them. **Accepted** — see Anti-Deferral below.
- **Sec F2 [Major, prose]** — `docs/security/security-review.md` §7 item 4 would keep a PASS for an
  `externalId` control that no longer exists. **Resolved**: added to C6 as a rewrite to the
  current control.
- **Sec F3 [Minor, prose]** — C3's grep missed `ClaimLookup`'s bare `"collision"`; stale prose in
  `scripts/tenant-domain.ts` would survive the forbidden-pattern sweep. **Resolved**: grep widened;
  C4 names the prose blocks to rewrite.

### Sec F1 [Major] Fold-collision diagnostic removed — Accepted
- **Anti-Deferral check**: owner decision (2026-10-06): not in production; data that needs it is patched by hand.
- **Justification**:
  - Worst case: a database holding two tenants whose `external_id` values fold to one claim, neither with a
    claim row, gets a third tenant created for that claim on the next sign-in; new members of that IdP
    domain land there.
  - Likelihood: nil for existing databases — the only one (dev) was measured before removal:
    `tenant-domain preflight` → 0 collisions / 0 non-ASCII / 0 fold mismatches, and 0 tenants with an
    `external_id` but no claim row (commands in plan R1). No production deployment exists.
  - Cost to fix: keeping `preflight` and the probe means keeping the column, which is the change the owner
    asked to remove.
- **Orchestrator sign-off**: accepted; the measurement replaces the "run preflight first" step the finding
  recommends, because the only database it could apply to has been checked.

## Testing Findings

- **Test F1 [Major, design]** — `tenant-claim-registry.test.ts` missing from the unit list; its top-level
  `EXTERNAL_ID_FOLD_SQL` import breaks the whole file. **Resolved** (merged with Func F1).
- **Test F2 [Major, design]** — forbidden pattern #1 is not a single-line grep and already returns nothing on
  the unfixed tree (vacuous). **Resolved**: removed; `tsc` / `next build` is the enforcement.
- **Test F3 [Major, design]** — the proposed integration case was vacuous and duplicated the existing
  register-event case. **Resolved**: replaced with an `information_schema.columns` assertion.
- **Test F4 [Minor, design]** — dead mock surface left behind. **Resolved**: the unit test plan removes it and
  re-checks the remaining "did not call X" assertions.

## Adjacent Findings
None.

## Quality Warnings
None (Ollama merge not used; manual merge of three reports with no overlapping root causes except Func F1 / Test F1).

## Recurring Issue Check
### Functionality expert
R3 Finding F1; R18 Finding F2; R42 Finding F1; R5, R12, R20, R24, R29, R31, R48 Checked; all other R1–R57 N/A.

### Security expert
R1 N/A, R2 N/A, R3 Fail, R4 Pass, R5 Pass, R6 N/A, R7 N/A, R8 N/A, R9 N/A, R10 N/A, R11 N/A, R12 Pass, R13 N/A, R14 Pass, R15 N/A, R16 N/A, R17 N/A, R18 Pass, R19 N/A, R20 N/A, R21 N/A, R22 N/A, R23 N/A, R24 Pass, R25 N/A, R26 N/A, R27 N/A, R28 N/A, R29 Fail, R30 N/A, R31 Pass, R32 N/A, R33 N/A, R34 N/A, R35 N/A, R36 N/A, R37 N/A, R38 N/A, R39 N/A, R40 N/A, R41 N/A, R42 Fail, R43 N/A, R44 N/A, R45 N/A, R46 N/A, R47 N/A, R48 Pass, R49 Pass, R50 N/A, R51 N/A, R52 N/A, R53 N/A, R54 N/A, R55 N/A, R56 N/A, R57 N/A, RS1 N/A, RS2 N/A, RS3 Pass, RS4 N/A, RS5 N/A, RS6 N/A

### Testing expert
R1–R18 clean, R19 found, R20–R57 clean, RT1 clean, RT2 found, RT3–RT6 clean, RT7 found, RT8–RT11 clean

---

# Round 2
Date: 2026-10-06

## Changes from Previous Round
Round-1 dispositions applied (C3 grep, C4 prose + worker-policy-manifest, C5 per-assertion boundary, C6 security-review.md, forbidden pattern #1 → tsc, R1 dev-DB measurement).

## Functionality Findings
- **F1 [Major, prose]** — `resolveTenantByClaim` / `findOrCreateTenantForClaim` JSDoc still narrates the release-1/2 (D1/SC10) split; no grep catches camelCase prose. **Resolved**: NF1a + residue sweep.
- **F2 [Major, prose]** — C6's "rows" understated the README section; one sentence ("removed in a later release") becomes false. **Resolved**: NF1a names the blocks.
- **F3 [Adjacent → Testing]** — see Test T1 (same test).

## Security Findings
- **Sec R2-1 [Major, design]** — forbidden pattern narrower than C3's derivation; `case "collision":` is not a tsc error. **Resolved**: pattern widened and scoped; confirmed non-vacuous on the current tree (10 files match).
- **Sec R2-2 [Minor, prose]** — VE1 "Likelihood: nil" overstated for a self-hostable product. **Resolved**: restated with its basis.
- Sec F1 Anti-Deferral entry re-verified sound against the code (orphan population is static: both create sites register the claim atomically).

## Testing Findings
- **T1 [Major, design]** — "--tenant resolution" test mixes the removed external_id resolution with the kept slug refusal; `cmdPreflight()` also sits in a shared fail-closed case. **Resolved**: per-assertion instruction + named surviving case.
- **T2 [Minor, design]** — same as Sec R2-1. **Resolved**.

## Recurring Issue Check
### Functionality expert
R3 Finding; R18 Checked; R42 Finding; R5, R12, R20, R24, R29, R31, R48 Checked; all other R1–R57 N/A.
### Security expert
R3 Fail, R29 Pass, R34 Pass, R42 Pass; all other R1–R57 N/A; RS1–RS6 N/A.
### Testing expert
R3 Finding T1, R19 Pass, R29 Pass, R42 Finding T2; all other R1–R57 N/A; RT1 Pass, RT2 Pass, RT5 Pass, RT7 Pass, RT10 Checked; other RT N/A.

---

# Round 3
Date: 2026-10-06

## Changes from Previous Round
Round-2 dispositions applied (NF1a + residue sweep, widened collision pattern, per-assertion CLI integration instruction, VE1 wording).

## Functionality Findings
- **F1 [Major, design]** — residue sweep missed `pre-flight`, `release 1`, and Japanese prose. **Resolved**: pattern widened (hyphen/space variants, Japanese terms) and declared a tripwire; the README sections and the JSDoc of every touched or kept symbol are read in full regardless of hits.

## Security Findings
No findings. Round-2 fixes verified; VE1 wording accurate.

## Testing Findings
- **QA3-1 [Major, design]** — collision forbidden pattern did not reach `scripts/__tests__/tenant-domain-buckets.test.ts` (5 hits today). **Resolved**: path added.
- **QA3-2 [Minor, prose]** — inert `:!prisma/migrations` exclusion. **Resolved**: removed; `prisma/` stated out of scope.

## Exit decision
All findings from rounds 1–3 are resolved in the plan; none is open, so no Carried-Forward entries. Round 3's findings were all against enforcement text added in round 2, not against the contracts — the plan-growth pattern the saturation rule describes. Proceeding to Phase 2 rather than a round 4. Go/No-Go: C1–C6 locked.

## Recurring Issue Check
### Functionality expert
R3 Finding; R42 Finding; R5, R12, R18, R20, R24, R29, R31, R48 Checked; all other R1–R57 N/A.
### Security expert
R3 Pass, R29 Pass, R34 Pass, R42 Pass; all other R1–R57 N/A; RS1–RS6 N/A.
### Testing expert
R42 Finding; all other R1–R57 N/A; RT2 Pass, RT7 Finding; other RT N/A.
