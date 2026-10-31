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
