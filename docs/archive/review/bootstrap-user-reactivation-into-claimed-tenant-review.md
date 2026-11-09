# Plan Review: bootstrap-user-reactivation-into-claimed-tenant
Date: 2026-11-09
Review round: 1

## Changes from Previous Round
Initial review. The plan re-scopes #955 (user decision): the issue's producer-side migration is
rejected in favour of correcting the stale remedy text and proving the remedy on a real DB.

## Functionality Findings
All factual claims verified (engine refusal arm, `deactivateScimUser` removes row and mapping,
producer set complete, row 6 reachable after the delete, dates).
- FF1 [Major, prose] C1 misses the stale rationale beside the stale remedy: `src/auth.ts` and the
  README cause cells still say reactivation is "the target tenant's decision — SCIM, directory
  sync, its admins", none of which can reactivate a bootstrap-owned user after `#830`.
- FF2 [Minor, prose] Remedy text assumes a SCIM token and a userId; a directory-sync-only tenant
  must mint a token, and `resolveUserId` also accepts the IdP externalId.
- FF3 [Minor, design/prose] Remedy preconditions unstated: row 6b and an OWNER-protected row still block.
- FF4 [Minor, prose] `usersOwnedByAnotherTenant` doc says sign-in is always the way back.

## Security Findings
The rejection's threat reasoning holds; the remedy needs both the tenant's delete and the user's
own authenticated sign-in, runs every row-6 guard, and revokes only in the tenant.
- SF1 [Minor, prose] Remedy text must say the delete admits the user (data and audit history move
  in) and that a deliberately deactivated row should stay.
- SF2 [Minor, prose] "No current producer" claim needs its producer list recorded.
- SF3 [Minor, design, Adjacent] C2 bypasses the route; nothing pins that revocation stays in the tenant.

## Testing Findings
- TF1 [Major, design] The only mutant also reddens an existing cell; the `deactivateScimUser` half
  (row and mapping removal) is not red-proved.
- TF2 [Major, design] The refusal reason is not in `SyncResult`; assert the
  `DIRECTORY_SYNC_ACTIVATION_REFUSED` outbox row (reason, target), sync outside any RLS context.
- TF3 [Major, design] One cell is feasible in `tenant-claim-binding`; fallback (b) is not the post-delete state.
- TF4 [Minor] The delete must run as the route runs it (tenant context, `resolveUserId`).
- TF5 [Minor] Missing positive control (pre-delete sign-in refused).
- TF6 [Minor] Forbidden patterns English-only and narrow.
- TF7 [Minor] C1 acceptance cannot go red on a wording regression in CI.
- TF8 [Minor] The heading cell pins three substrings; the plan named one.

## Adjacent Findings
- SF3 (security → testing): resolved with TF4 by driving the route.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R3 partial (FF1) · R29 claims verified · R42 producer set complete, text member set incomplete (FF1) · R4 consistent.

### Security expert
R3 OK · R29 OK · R42 complete (SF2 records it) · R51 OK · RS1 OK (Jackson never links by email;
Google only within hd; strict binding with ≥2 claim providers) · RS2 unchanged · RS3 residual
enumeration via 409 inherent in `#830` (SC5) · RS4 OK.

### Testing expert
RT1 OK · RT2/RT3 gap (TF2) · RT4 gap (TF5) · RT5 TF1 · RT6 OK · RT7 TF1 · RT8 TF3 · RT9 TF7/TF8 ·
RT10/RT11 TF7 · R29 OK · R42 TF6.

## Resolution Status

### Round 1
All 15 findings accepted and reflected in the plan:
- FF1, SF1, FF2, FF3, FF4, TF6, TF7, TF8 → C1 (member set re-derived with a wider grep; R1/R2
  reworded; heading assertion pinned in CI; three anchors kept).
- SF2 → Objective producer table.
- TF1, TF2, TF3, TF4, TF5, SF3 → C2 rewritten: one cell in `tenant-claim-binding`, SCIM DELETE
  through the route, positive control, outbox reason/target assertion, mutants M1–M3.

### Round 2
Incremental review (all three perspectives): round-1 resolutions verified against the code
(member set complete, module-scope mocks safe, `DELETE` export, refusal row shape, M1/M3 real). New:
- N1 [Major, design] The forbidden pattern `(?i)recreat|re-creat` matched ~100 unrelated correct
  lines (`isShareCreatorAdmitted`, "pre-create", "re-created"). Action: patterns scoped to the six
  member-set files and narrowed to the stale phrases; the other hits recorded as out of scope.
- N2 [Major, design] "Real SCIM token" contradicted the cited sibling, which mocks
  `authorizeScim`. Action: mock `@/lib/scim/with-scim-auth` as the sibling does; route body runs for real.
- N3 [Minor, prose] M2 trace corrected (neither `toCreate` nor `toUpdate`); each mutant records
  its first failing assertion.
- N4 [Minor, prose] Remedy says to mint the SCIM token short-lived and revoke it afterwards.
- N5 [Minor, prose] The pinned positive phrase is named: "next SSO sign-in moves them in".

Saturation call (after round 2): no Critical or Major open; no finding against the design; the
remaining were prose or test-mechanics corrections, all applied. Plan review closed.
