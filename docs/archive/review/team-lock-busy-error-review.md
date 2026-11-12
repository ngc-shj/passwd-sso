# Plan Review: team-lock-busy-error

## Round 1 (2026-11-12)

Initial review. Local LLM pre-screen skipped (Ollama unavailable). Finding IDs are prefixed by
expert: F- functionality, S- security, T- testing.

### Functionality
- F-F1 Major (design) — re-key runner: `TEAM_BUSY` also reaches the upgrade PUT and the migrate
  PUT chains, not only the re-key POST; unwired chains fall to STOP, a regression from today's
  REFRESH_KEYS retry. Runner `retryAfterMs` does not clamp (plan said it did). → Resolved: C5 wires
  all three locking chains, adds a 30 s clamp, updates `rekeyStopRetryBudget` and the comment.
- F-F2 Major (design) — membership clients branch on `CONFLICT` or bare 409 (members-list page,
  ownerless card, invite, add-from-tenant, team-create, tenant-members-card); plan's "no code
  change" claim was false. → Resolved: each named in C5 with its change; the four status-keyed
  ones key their fixed message on the specific code (fixes their pre-existing `CONFLICT`
  misreport, R34).
- F-F3 Minor (design) — "this team" wording misfits the tenant-row timeout and the spent-token
  admin-reset. → Resolved: `TEAM_BUSY` only for `TeamRotationInProgressError`; neutral wording;
  admin-reset keeps `CONFLICT` (SC5).
- F-F4 Minor (prose) — API_ERROR count test (204) and two more doc spots. → Resolved: C1, C6.
- F-F5 Minor (prose) — form message namespace; delete toast widening; importer retry budget is 2.
  → Resolved: `PasswordForm.teamEntryTeamBusy`; widening stated; budget stated.
- F-F6 Minor (prose) — stale directory-sync claim; bulk-import rationale; RFC wording. →
  Resolved: corrected in Background/C3/C6 and the 409 rationale.
- F-F7 Minor (design) — forbidden-pattern regex misses confirm-key. → Resolved: pattern dropped;
  confirm-key pinned by its `busy` test.

### Security
- S-F1 Minor (design) — `TEAM_BUSY` precedes the in-tx actor re-check for a just-revoked member.
  → Accepted, recorded in C4 (pre-tx authz still first; retry yields 403; previous code leaked the
  same fact).
- S-F2 Minor (design) — vault/tenant routes reveal some team is rotating. → Accepted in C4; no
  team id in the body.
- S-F3 Minor (prose) — shared wording mislabels the tenant-row timeout. → Resolved with F-F3.
- S-F4 Info — fixed `Retry-After` without jitter; clamp the client wait. → Clamp added (C5); jitter
  recorded under Risks.

### Testing
- T-F1 Major — no existing cells for history restore, vault reset, owner. → Resolved: listed as new
  cells with pairs.
- T-F2 Major — membership sites lack paired `TEAM_BUSY`/`CONFLICT` cells; bare-409 cells would not
  fail on the old mapping. → Resolved: per-site pair.
- T-F3 Major — `team-entry-rekey.test.ts` stubs the error class. → Resolved: `importActual`.
- T-F4 Major — integration covers only create and removal; removal cell unlisted. → Resolved: flip
  both, add PUT, bulk import, confirm-key.
- T-F5 Minor — no-write/audit and header assertions. → Resolved: stated for every cell.
- T-F6 Major — bulk-import `TEAM_BUSY` cell missing. → Resolved.
- T-F7 Major — client tests underspecified. → Resolved: per-file cells incl. `invalidateTeamKeys`
  not called and non-`TEAM_BUSY` 409 not retried.
- T-F8 Minor — status/helper/constant cells. → Resolved.
- T-F9 Minor — helper cells assert header presence/absence. → Resolved.
- T-F10 Minor — invariant not CI-enforced. → Accepted (SC3); integration cells are the backstop.

### Recurring Issue Check

Preserved from each expert's output; non-N/A entries:
- Functionality: R1 ok; R2 ok; R3 F-F1/F-F2; R8 F-F2; R10 ok; R12 F-F4; R17 F-F1; R18 F-F4;
  R22 ok; R29 F-F1/F-F3/F-F6; R34 F-F2; R38 F-F1; R40 ok; R42 F-F1/F-F2/F-F6/F-F7; R51 ok;
  all others N/A.
- Security: R1 ok; R2 ok; R3 ok; R12 ok; R17 ok; R29 S-F3; R34 ok; R37 S-F3; R38 ok; R42 S-F3;
  RS2 S-F4; all others N/A.
- Testing: R1 ok; R2 ok; R3 T-F2; R8 ok; R12 ok; R16 ok; R17 T-F7; R19 T-F3; R29 ok; R37 ok;
  R38 T-F7; R42 T-F10; RT1 T-F3; RT2 ok; RT3 T-F8; RT4 T-F4; RT5 T-F3; RT6 T-F8; RT7
  T-F1/T-F2/T-F6; RT8 T-F5; RT9 T-F10; RT10 T-F2/T-F6; RT11 ok; all others N/A.
