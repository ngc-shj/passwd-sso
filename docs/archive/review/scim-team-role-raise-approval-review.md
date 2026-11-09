# Plan Review: scim-team-role-raise-approval
Date: 2026-11-09
Review round: 1

## Changes from Previous Round
Initial review of the round-1 design: keep the member active and record the raise in a new
`team_members.scim_requested_role` column, with CHECKs, `COALESCE(requested, role)` group semantics,
and approve/reject extended to requests.

## Functionality Findings
- F1 [Major] The `assigned` group predicate cannot be built from `SCIM_GROUP_ROW_STATE`; five
  role-filter sites (PUT pre-read and locked re-read, `loadGroupMembers`, remove filter, remove CAS)
  were not enumerated.
- F2 [Major] A user in two role groups flips request/withdraw and demote/request on every sync; an
  approval does not stick; "max" (pending) vs "last add wins" (active) inconsistent.
- F3 [Major] After a rejection, the next sync's outcome depends on which group syncs first.
- F4–F12 [Minor] Removal from the requested group deactivates; `countAddedRemoved`; reuse of
  `pendingApproval`; 404 on a changed request; unreachable self-approval arm; forbidden pattern
  matches the plan's own code; unreachable C4 cells; manual PUT vs SCIM race; departure discards the
  request.

## Security Findings
- S1 [Major] An unapproved request stops removal from the member's real role group, so an IdP's
  delta deprovisioning becomes a no-op and the member keeps access the IdP revoked.
- S2–S6 [Minor] Ownerless-team owner route + a second approved identity (residual); CHECK does not
  catch a below-request role change and the gate misses raw SQL; audit closure of a cleared request;
  unlisted role-predicate readers; CHECK depends on enum order.

## Testing Findings
- F1 [Major] A missed clear on manual PUT / SCIM demotion passes the CHECK silently.
- F2 [Major] Several C4 cells cannot be seeded.
- F3 [Major] SCIM raise of an active non-`scim_managed` row unspecified (CHECK → 500).
- F4 [Major] Breaking / vacuous existing tests not enumerated.
- F5 [Major] Self-approval 403 cannot be reached.
- F6 [Major] The gate rule as specified flags `select`/response uses or is blind.
- F7–F10 [Minor] Pinned counts; `countAddedRemoved`; cells needing controls; race cells.

## Adjacent Findings
Testing F3 / F8 (functionality); security S5 (functionality).

## Quality Warnings
None.

## Recurring Issue Check
Functionality: R3 (five sites, `countAddedRemoved`, `pendingApproval` consumers), R29 (convergence
claim false), R42 (writer set complete). Security: R42 (raw SQL writers, role readers), fail-open on
an ambiguous state (S1). Testing: RT1–RT11, R19 (F4), R42 (F2, F7).

## Resolution Status

### Round 1
The findings concentrate on the requested-role column itself: its group semantics, its interaction
with removal (S1), and its enforcement. The user chose (2026-11-09) the alternative the security
review proposed as S1's remedy: a SCIM raise of an active member becomes a pending admission at the
new role, decided by the existing approve/reject flow. The plan was rewritten around it; the column,
CHECKs, group-semantics change, request approval/rejection, gate rule and UI work are dropped, which
removes the findings that depended on them (functionality F1, F2 (approval no longer undone except
by a demotion, documented), F4–F10; security S1, S3–S6; testing F1, F2, F5, F6, F8–F10). Carried
into the rewrite: non-managed rows (testing F3 → C1), existing tests to update (testing F4 →
acceptance), `countAddedRemoved` (C1), rejection consequences and two-group configuration
(Considerations), the owner-route residual (SC2), the manual PUT race (Considerations), the
ROLE_UPDATE metadata doc fix (C2).

### Round 2
Review of the rewritten (re-admission) plan; security and functionality/testing. Both found the
same Major:
- S1 / F1 [Major, design] The hold deleted `team_member_keys` before its CAS; a CAS miss under a
  racing manual role PUT, ownership transfer or confirm-key left an active member (a new OWNER
  included) `keyDistributed: true` with no key, or a held row with a key. Action: CAS first, then
  delete keys only for the rows it returned; `toBecomePending` reordered the same way; A7d seeds a
  key and asserts it survives (race red-proof); acceptance cell 9 (CAS miss leaves keys).
Minor, all applied: SC2 restated with the real chain (one second identity; the SCIM token can make
the team ownerless; the owner route grants OWNER without a key) — residual unchanged; share links of
a held member pause and resume (Considerations); IdP revert before a decision deletes the pending
row; `previouslyActive` only in the add-first order; spec action list and service docstrings in C3;
A10 (not A11) is the transition-kind cell and gains a demotion fixture; A7e / service unit tests need
a lower mapping role; cell 1 fixture seeds `scim_managed`, `key_distributed`, a key row; the count to
change is the gate's `EXPECTED.memberWrites`.

Saturation call (after round 2): no Critical/Major open; the round-2 Major was a single ordering
defect with a direct fix; the rest prose or test-mechanics. Plan review closed.
