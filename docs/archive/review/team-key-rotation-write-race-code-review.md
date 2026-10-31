# Code Review: team-key-rotation-write-race
Date: 2026-10-31
Review round: 1

Scope: GitHub issue #979 (team entry writes racing team key rotation). No Phase 1
plan was written; the issue body is the requirement.

## Changes from Previous Round
Initial review.

## Deviation log (orchestrator, pre-review)
- The full PUT path (`updateTeamPassword`) had the same unlocked version read as
  create; fixed in the same commit (version check moved inside its transaction,
  before the entry `FOR UPDATE`).
- Team history restore was left unchanged: it writes the history row's old
  `teamKeyVersion` back by design (F-29 in the rotate-key route), and racing a
  rotation produces the same state as a sequential restore.

## Functionality Findings
- **F1 Critical** — rotate-key applied the client snapshot (fetched outside the
  transaction) with no per-entry check. An edit or history restore committed
  between the snapshot and the rotation was overwritten; a v0 → v1 upgrade left
  the row undecryptable (v0 blob written over `itemKeyVersion = 1` with an old
  wrap). Converges with Security S-F3.
- **F2 Major** — confirm-key read `teamKeyVersion` unlocked: a distribution
  racing a rotation marked the member `keyDistributed` with only the old key.
  Converges with Security S-F2.
- **F3 Minor** — rotation took `FOR UPDATE`; `FOR NO KEY UPDATE` is enough and
  does not block unrelated inserts whose FK to `teams` takes KEY SHARE.
- **F4 Minor** — a writer waiting on a long rotation past Prisma's 5s
  transaction timeout answered 500 (P2028) instead of 409.
- **F5 Minor** — rotate-key comments claimed every entry writer holds the team
  row `FOR SHARE`, and that the member read was TOCTOU-safe.

## Security Findings
- **S-F1 Major** — the member set (rotation's second input) was not serialised:
  member DELETE, SCIM user delete, SCIM group deactivation and vault reset never
  touch `teams`, so a removal committing after rotation read the members left
  an orphan new-version `team_member_keys` row wrapped to the removed member
  (no FK from `team_member_keys` to `team_members`). Converges with
  Functionality A1.
- **S-F2 Minor** — confirm-key (= F2).
- **S-F3 Minor [Adjacent]** — rotation snapshot (= F1).
- **S-F4 Minor [Adjacent]** — rotation never re-wraps `team_password_entry_histories`;
  v1 history rows keep old-key wraps of the live ItemKey.

## Testing Findings
- **T-1 Minor** — the two-entry bulk-import race test passed without the
  `FOR SHARE` (the second entry's plain read of v2 aborted the import).
- **T-2 Minor** — on a failure path the race harness left the request promises
  un-awaited (running into `afterEach`), and `holdRowLock` leaked its client if
  `BEGIN` or the lock threw.
- Seed: one item adopted as T-2 (remedy corrected); one rejected (no other raw
  query in the PUT path contains `FROM teams`; a misroute fails loudly).

## Adjacent Findings
- A1 (Functionality → Security) = S-F1.
- S-F3 (Security → Functionality) = F1.
- S-F4 (Security) — see Resolution Status.

## Quality Warnings
None. Local pre-screen's Major ("bare `prisma` makes `FOR SHARE` ineffective")
was rejected with evidence: the `prisma` proxy routes to the ambient
`withTeamTenantRls` transaction (`src/lib/prisma.ts`), and removing the
`FOR SHARE` (mutation M2) turned the create race test red. A clarifying
comment was added at the call site.

## Recurring Issue Check
### Functionality expert
- R1: OK (team guard twins the personal one on another table)
- R3: finding F2
- R5: findings F1, A1
- R34: finding F1 (pre-existing in a changed file)
- R42: F2 and A1 were extra members of the class
- R48: OK (the unlocked checks were removed, not left beside the new ones)
- R49: finding F5
- Others: N/A

### Security expert
- R3: finding S-F2
- R5: findings S-F1, S-F3
- R34: S-F1/S-F2 siblings found; S-F4 recorded below
- R42: S-F1 expands the class to the member set
- R48: checked (personal vs team restore differ by design)
- R49: folded into S-F4
- RS3: OK (no new untrusted inputs beyond `snapshotIv`, validated as a hex IV)
- RS1, RS2, RS4–RS6: N/A

### Testing expert
- RT1: OK; RT4: T-1; RT5: OK; RT7: T-1; RT8: OK; RT10: OK; RT11: T-2; R19: OK
- Others: N/A

## Environment Verification Report
N/A — no environment constraints declared (no Phase 1). Verification:
- verified-local: `npm run test:integration` (1123 passed; the two audit-anchor
  S3 files need `ANCHOR_TEST_S3_ENDPOINT` and pass with it set), `npx vitest run`
  (1108 files), `npx tsc --noEmit`, eslint on changed files.

## Resolution Status

### Class derivation (R42)
Rotation reads two inputs under the team lock and writes the next version:
- Entries carrying `team_key_version`: writers derived from
  `teamPasswordEntry.(create|update|updateMany|upsert)` and raw
  `team_password_entries` writes. Create, bulk import and full PUT lock the team
  `FOR SHARE`; history restore writes old versions by design and is caught by
  the rotation snapshot predicate when it lands mid-rotation; bulk
  trash/archive/restore, folder delete, partial PUT and deletes do not touch
  key material.
- Key-holding members: writers derived from `teamMemberKey.(delete|deleteMany)`
  and `teamMember.(delete|deleteMany|update|updateMany)` touching
  `deactivatedAt` / `keyDistributed`. Member DELETE, SCIM user delete, SCIM group
  deactivation, vault reset and confirm-key lock the team `FOR SHARE` first.
  Member reactivation and adds create `keyDistributed = false` members, which
  rotation does not include.

### F1 Critical rotation snapshot applied without a check — Fixed
- Action: each rotated entry carries `snapshotIv` (blob IV for v0, wrapped
  ItemKey IV for v1+, from rotate-key/data); `updateMany` also matches
  `itemKeyVersion` and that IV, so an entry changed since the snapshot answers
  `ENTRY_COUNT_MISMATCH` and the whole rotation rolls back. IVs are random per
  encryption, so an equal IV means the same ciphertext.
- Modified: `src/app/api/teams/[teamId]/rotate-key/route.ts`,
  `src/components/team/security/team-rotate-key-button.tsx`.
- Tests: integration "a rotation built from a snapshot an edit has since
  replaced is rejected and leaves the edit intact" (red on the previous commit
  and with the predicate removed); unit tests pin the v0 and v1 predicates.

### S-F1 Major member removal not serialised with rotation — Fixed
- Action: `src/lib/team/team-key-rotation-lock.ts` —
  `lockTeamsAgainstRotation` / `lockMemberTeamsAgainstRotation` take
  `teams ... FOR SHARE` (id-ordered) as the first statement of member DELETE,
  SCIM user delete, SCIM group replace/patch and vault reset. They fail closed:
  fewer locked team rows than the visible memberships throws
  `TeamRotationLockError`. Vault reset locks teams before its `users FOR UPDATE`
  (rotation holds the team lock while its member-key insert takes KEY SHARE on
  `users`), and its bypass grant gained `team`.
- Tests: integration (member DELETE and vault reset racing a parked rotation;
  red on the previous commit, with each lock removed, and with `team` dropped
  from the vault-reset grant); unit tests pin lock order and the fail-closed
  refusal for member DELETE and both SCIM paths.

### F2 Major confirm-key version read unlocked — Fixed
- Action: confirm-key reads the version through `lockTeamKeyVersion` as its
  first statement; a lock timeout answers the same 409.
- Tests: integration (distribution racing a parked rotation is refused, member
  stays pending; red on the previous commit and with only confirm-key reverted);
  unit tests for lock order and the timeout.

### F3 Minor `FOR UPDATE` → `FOR NO KEY UPDATE` — Fixed
- Rotation's first statement; still conflicts with every `FOR SHARE` holder
  (mutation removing it reddens seven race tests).

### F4 Minor 500 on a long rotation — Fixed
- `lockTeamKeyVersion` sets `lock_timeout` (`TEAM_KEY_LOCK_TIMEOUT_MS`, 3s,
  below Prisma's 5s default) and maps 55P03 to `TeamRotationInProgressError`;
  entry writes and confirm-key answer 409 `TEAM_KEY_VERSION_MISMATCH`.
- Tests: integration "a write that waits past the lock timeout … answers 409"
  (red with the timeout removed); unit tests for the mapping and for a
  non-timeout failure propagating unchanged.

### F5 Minor overclaiming comments — Fixed
- Rotate-key comments now name the writers that hold the lock and say the
  member read follows the lock member removal also takes.

### T-1 Minor bulk race not sensitive to the lock — Fixed
- The race imports one entry; the two-entry whole-import rollback stays
  covered by the stale-version test.

### T-2 Minor race-harness cleanup — Fixed
- Request promises are settled in `finally` before `afterEach`; `holdRowLock`
  rolls back and releases its client when `BEGIN` or the lock throws.

### S-F4 Minor history rows not re-wrapped on rotation — Out of scope (pending user decision)
- **Anti-Deferral check**: security-class member (rule 7) — deferral requires
  explicit user approval.
- **Justification**: v1 rotation re-wraps the ItemKey but never replaces it, so
  any member who ever decrypted a v1 entry keeps its ItemKey; re-wrapping
  history rows alone does not revoke that. Closing the class means re-keying
  ItemKeys on rotation (re-encrypting live and history blobs), a design change
  across rotate-key/data, the client, history writes and tests.
- **Worst case**: a removed member who keeps the old team key and obtains
  database or backup ciphertext unwraps the ItemKey from a pre-rotation history
  row and decrypts that entry, including edits made after the removal.
- **Likelihood**: low — needs a removed insider plus a database or backup leak.
- **Cost to fix**: several hours (design + client + server + tests); over the
  30-minute threshold.
- **Orchestrator note**: TODO(team-rotation-history-rekey): follow-up issue for
  re-keying ItemKeys and history rows on team rotation.

---

# Round 2

## Changes from Previous Round
Round 1's fixes verified (snapshot predicate, removal locks, confirm-key lock,
`FOR NO KEY UPDATE`, bounded wait, T-1/T-2). New findings: one pre-existing
Major growing the member-set class (S-R2-1), one pre-existing Major in a
changed file (F6), defects in round 1's own lock helper (F7–F10), and test
gaps (T-3–T-9).

## Functionality Findings
- **F6 Major [Adjacent]** — confirm-key's final `teamMember.update` matched only
  `id`/`teamId`: a deactivation (or another distribution) committing after the
  plain member read was overwritten, keying a deactivated member.
- **F7 Minor** — removal locks had no bounded wait: a removal behind a long
  rotation expired its 5s transaction into a 500; `TeamRotationLockError` was
  unmapped (= Testing A-1).
- **F8 Minor** — the bounded wait's `lock_timeout` stayed set for the rest of
  the transaction, turning unrelated waits (FK checks, entry `FOR UPDATE`)
  into unmapped 55P03.
- **F9 Minor** — the membership set was read before it was locked; a
  membership joined and keyed in between escaped the lock.
- **F10 Minor** — the fail-closed check fired on a team deleted concurrently.
- **F11 Minor** — a comment still said `FOR UPDATE`.

## Security Findings
- **S-R2-1 Major (pre-existing)** — tenant-level deactivation (SCIM user
  PUT/PATCH `active=false`, directory sync) leaves `team_members` active and
  `keyDistributed`, so every later rotation must wrap the new team key to the
  departed user. Round 1's derivation missed tenant membership as an input.
- Verified clean: the `team` grant widening (R43), `snapshotIv` abuse (it also
  closes a v1 → v0 blob-path downgrade), other member-key inserts, error surfaces.

## Testing Findings
- **T-3 Major** — the lock-timeout test released its blocker only after the
  blocked request returned; a timeout regression deadlocked it into later tests.
- **T-4 Major** — `settledOrBlocked` did not report which stop condition fired.
- **T-5 Major** — vault-reset unit mocks answered every raw query with `{ id }`;
  the lock-order test anchored on the wrong query.
- **T-6 Major** — SCIM user delete and group deactivation locks never ran on
  real SQL under SCIM's RLS context.
- **T-7 Major** — no client test pinned which IV the button sends as `snapshotIv`.
- **T-8 Minor** — the snapshot auto-fill silently omitted a missing row; the
  member-added test asserted status only.
- **T-9 Minor** — no fail-closed test for `replaceScimGroup`.

## Recurring Issue Check (round 2)
- Functionality: R3 → F6; R5 → F9; R34 → F6; R42 → F7, F8; R43 OK; R48 OK; R49 → F11.
- Security: R3/R5 OK on fixed paths; R34/R42 → S-R2-1; R43 OK; RS1–RS3 OK.
- Testing: RT1 → T-5, T-7; RT4 → T-4; RT5 → T-6; RT7 → T-6, T-7; RT8 → T-8;
  RT10 → T-9; RT11 → T-3; R19 → T-5.

## Resolution Status (round 2)

### F6 Major confirm-key check-and-set — Fixed
- `updateMany` with `deactivatedAt: null, keyDistributed: false`; a miss
  throws inside the transaction (the key upsert rolls back) → 404.
- Red-proved: predicate removed, count check removed (unit, one each).

### F7 / A-1 Minor removal waits — Fixed
- Removal locks use the same bounded wait; `isTeamRotationConflict` maps both
  refusals to 409 in member DELETE, SCIM Users DELETE, SCIM Groups PUT/PATCH,
  `/api/vault/reset` and `/api/vault/admin-reset`.
- Red-proved: 409 mapping removed; bounded wait removed (integration).

### F8 Minor lock_timeout leak — Fixed
- `readLockTimeout` / `restoreLockTimeout` (in `tenant-rls-grants.ts`, the
  module `check-bypass-rls` sanctions for `set_config`) restore the previous
  value right after the lock statement.
- Red-proved: restore removed → "the write's other waits keep their own
  timeout" fails.

### F9 / F10 Minor membership set — Fixed
- `lockMemberTeamsAgainstRotation` returns the locked set; callers check the
  teams they actually changed with `assertTeamsLocked`: vault reset after its
  `users FOR UPDATE` (which stops new memberships), SCIM user delete on its
  `DELETE ... RETURNING team_id`. A team deleted meanwhile drops out of both.
- Red-proved: each post-check removed (unit).

### F11 Minor — Fixed.

### T-3 – T-9 — Fixed
- T-3: `withRotationStandIn` releases on its own deadline (below the 5s
  transaction timeout) with an upper-bound assertion; under the bounded-wait
  mutation the test now fails alone.
- T-4: the harness returns `"settled" | "blocked-on-parked"` and throws on a
  write that waited on the blocker; every race asserts `"blocked-on-parked"`.
- T-5: SQL-aware mock; tests for teams-before-users, the fail-closed refusal
  and the no-membership path.
- T-6: real-DB races for SCIM user delete and group removal under
  `withTenantRls` with `assertRlsApplies`; `scim_group_mappings` added to
  `deleteTestData`. Red-proved: each lock removed.
- T-7: client test pins `itemKeyIv` for v1 and `blobIv` for v0 (red when swapped).
- T-8: auto-fill throws on a missing row; the member-added test asserts
  `details.missingKeyFor`.
- T-9: replace refusal test (red with the replace lock removed).

### S-R2-1 Major tenant deactivation leaves team key distribution — Fixed
- Fixed in this branch (same-class security member; no deferral was approved).
- A member leaving a tenant leaves its teams' key distribution: under team
  locks taken first, `keyDistributed` turns false for their memberships in
  that tenant (`endTeamKeyDistribution` / `lockTenantMemberTeamsAgainstRotation`
  + `revokeTeamKeyDistribution`, which checks the rows its `UPDATE ... RETURNING`
  changed against the locked set). Rotation then neither requires nor accepts
  them, and member-key stops serving them a key; their memberships and old
  keys stay, and a reactivated member is distributed the current key again
  (pending-key-distributions lists them). The authorization predicate
  (`requireTeamMember`) is unchanged.
- Paths: SCIM user PUT and PATCH `active=false`, directory sync (locks taken
  at the start of the apply transaction for every member it may deactivate,
  revocation at its end), the tenant move in `src/auth.ts` (inline
  `teamMember.updateMany` so the bootstrap-migration gate reads the write;
  `team`/`teamMember` added to `AUTH_TENANT_CLAIM_MEMBERSHIP`). SCIM Users
  PUT/PATCH map the rotation refusals to 409.
- Tests: integration (SCIM deactivation racing a parked rotation waits and
  ends distribution; the next rotation leaves the member out); unit (PUT,
  PATCH, directory sync, tenant move, each with lock order and the refusal
  for an unlocked team). Red-proved: each of the seven clauses removed alone.

### R42 class "rotation member-set writers": expanded 2× — closed by mutation-verified CI guard
- `scripts/checks/check-team-rotation-input-lock.mjs` derives the class from the
  write primitive (team member key deletes, team member deletes / deactivation /
  keyDistributed updates, tenant member deletes / deactivation, raw writes to
  those tables) on the AST and requires a team-key-rotation-lock helper call
  before each write (in the enclosing function, or in every same-file caller),
  with reviewed exemptions that fail when stale and a site floor of 12 (the
  real tree has 18). Self-test: `scripts/__tests__/check-team-rotation-input-lock.test.mjs`
  (11 cases, allow and deny). Red-proven on a copy of `src`: removing the member
  DELETE lock, and removing the SCIM group patch lock, each fail it. Wired in
  `scripts/pre-pr.sh` (run in CI by `PRE_PR_STATIC_ONLY=1`).

### S-F4 Minor history / ItemKey re-key — Open (user decision)
- Unchanged from round 1. Re-keying ItemKeys would also mean re-encrypting
  team attachments, which are encrypted under the ItemKey.
