# Code Review: prisma-prev-hash-default-drift
Date: 2026-11-19
Review round: 1

Standalone Phase 3 (no plan or deviation log). The local LLM was unavailable,
so there was no pre-screening and no seed. Each expert reviewed the full diff.

## Changes from Previous Round
Initial review.

The change under review:
- `schema.prisma` now spells `audit_chain_anchors.prev_hash`'s default
  `@default("AA==")`. It was `@default(dbgenerated("'\\x00'::bytea"))`. Prisma
  introspects the same database default as the bytes literal, so the old
  spelling never compared equal. Every `prisma migrate dev` therefore asked for
  a new migration, and eight migrations carry the resulting no-op
  `ALTER COLUMN "prev_hash" SET DEFAULT '\x00'::bytea`.
- `ci-integration.yml` gains a `prisma migrate diff --from-config-datasource
  --to-schema prisma/schema.prisma --exit-code` step after `migrate deploy`.

## Functionality Findings
- F1 [Minor] `@default("AA==")` is an opaque literal. Everywhere else the
  genesis byte is written `'\x00'::bytea`, and nothing tells a reader the two
  are the same value. A later "fix" back to `dbgenerated(...)` would bring the
  drift back. The CI step would catch that, but only after a push.

Verified without a defect:
- `"AA=="` renders as `DEFAULT '\x00'` (`migrate diff --from-empty`).
- The client type is unchanged (`prevHash?: Bytes`).
- No Prisma client call creates an anchor. Every insert is raw SQL that sets
  `prev_hash` explicitly.
- No other default in the schema drifts.
- Both flags exist in Prisma 7.10.1, and exit codes are 0 for no diff, 1 for an
  error, 2 for a diff.
- The step resolves the same `DATABASE_URL` that `migrate deploy` used.
- The job's path filter covers the schema, the migrations and package files.

## Security Findings
No findings.

Verified without a defect:
- The genesis value stays a single 0x00 byte. It equals `GENESIS_PREV_HASH` in
  `src/lib/audit/audit-chain-verify.ts`.
- The only production writer is the outbox worker's raw `INSERT`, which
  supplies the value itself.
- The step adds no secrets or permissions.
- On a connection or authentication failure, `migrate diff` prints the host
  and user but not the password.
- `--from-config-datasource` leaves no shadow database behind.
- Prisma does not model RLS policies or grants, so the gate can never ask
  anyone to drop them.

## Testing Findings
- T-1 [Minor] The step comment said the migrated database "must be exactly what
  schema.prisma describes". `migrate diff` does not compare RLS policies, CHECK
  constraints, partial indexes or functions. A fresh database containing all of
  these still diffs clean.
- T-2 [Minor] No local command runs the same check. A developer would first see
  the drift in CI, or as the phantom `migrate dev` prompt this change removes.

Verified without a defect:
- I ran the step on a fresh `postgres:16` database migrated from scratch, as
  in CI:
  - fixed schema: exit 0
  - main's schema: exit 2
  - a schema edit with no migration: exit 2
  - a missing database: exit 1
- `Integration result` is a required check on `main`.
- No test depends on the old spelling.

## Adjacent Findings
- `docs/operations/ci-required-checks.md` still said "Until then, neither check
  blocks a merge". The ruleset now requires both aggregates. Reported by the
  testing expert and fixed in this round.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R3: checked. The full schema diff is empty after the fix, so no other default
  has the same spelling problem.
- R16: checked. A fresh migrations-only database and the dev database both diff
  clean.
- R29: checked.
- R33: checked. The `migrate deploy` steps in `ci.yml` are functional tests,
  and one gate location is enough.
- R42: checked.
- R44: checked. Exit codes were captured without a pipe.
- R50: checked. The step was shown to fail on the old schema.

### Security expert
- R16, R29, R33, R49, R50: checked.
- RS1: N/A.
- RS2: N/A.
- RS3: N/A.
- RS4: checked.
- RS5: N/A.
- RS6: N/A.

### Testing expert
- R16, R29, R33, R44, R50: checked.
- R49: T-1.
- RT1: N/A.
- RT2: checked (T-2).
- RT3, RT4: N/A.
- RT5: checked.
- RT6: N/A.
- RT7: checked. Red-proven, and wired into a required check.
- RT8, RT9: N/A.
- RT10: checked.
- RT11: checked.

## Environment Verification Report
N/A — no environment constraints declared.

## Resolution Status
### F1 [Minor] Opaque base64 default
- Action: added a comment above the field. It says `"AA=="` is base64 for the
  single 0x00 genesis byte, and that `dbgenerated(...)` brings the drift back.
- Modified file: prisma/schema.prisma (the `prevHash` field of `AuditChainAnchor`)

### T-1 [Minor] Step comment overclaims
- Action: the comment now limits the claim to what Prisma models: tables,
  columns, defaults, indexes, foreign keys and enums. It names what
  `migrate diff` does not compare.
- Modified file: .github/workflows/ci-integration.yml (the drift-check step)

### T-2 [Minor] No local equivalent
- Action: added `npm run db:check-drift`, and the CI step now runs that script,
  so local runs and CI execute the same command line.
  - Through npm it returns 0 on the current schema and a non-zero code on a
    drifted copy of the schema.
  - It is listed under Common Commands in CLAUDE.md.
- Not adopted: running it from `scripts/pre-pr.sh`.
  - Anti-Deferral check: the finding marked this part optional.
  - Worst case: a drift reaches CI, and the required `Integration result`
    check blocks the merge.
  - Likelihood: low. Only a schema or default edit without a migration causes
    it.
  - Cost to fix: the pre-PR run would depend on a reachable, migrated local
    database, so a check that is deterministic today would come to depend on
    machine state.
- Modified files: package.json, .github/workflows/ci-integration.yml, CLAUDE.md

### Adjacent: stale required-check sentence
- Action: the sentence now states that a repository admin added the rule and
  that both checks block a merge.
- Modified file: docs/operations/ci-required-checks.md
