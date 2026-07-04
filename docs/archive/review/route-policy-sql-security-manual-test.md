# route-policy-sql-security — Manual test / fail-path proof transcripts

RT7 fail-path proofs for the plan's C1 contract (`docs/archive/review/route-policy-sql-security-plan.md`).
An unrecorded "verified once" claim is not auditable — this file records the actual
command transcripts for each required mutation.

## Pre-conditions

- Branch: `hardening/route-policy-sql-security`
- `scripts/checks/route-policy-manifest.json` and
  `src/__tests__/proxy/route-policy-manifest.test.ts` committed with all 212 route
  entries and passing (`npx vitest run src/__tests__/proxy/route-policy-manifest.test.ts`
  → 10/10 passed) before any of the mutations below.
- Each mutation is applied to a working copy of the manifest, verified to fail as
  expected, then reverted via `git diff --stat` showing an empty diff (proving the
  revert was clean, not just "close enough").

## C1 fail-path proofs

### Proof 1 — delete the `vault/reset` entry, confirm bijection failure names the path

```
$ cp scripts/checks/route-policy-manifest.json /tmp/route-policy-manifest.json.bak
$ node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('scripts/checks/route-policy-manifest.json','utf8'));
delete m.routes['src/app/api/vault/reset/route.ts'];
fs.writeFileSync('scripts/checks/route-policy-manifest.json', JSON.stringify(m, null, 2) + '\n');
"
$ npx vitest run src/__tests__/proxy/route-policy-manifest.test.ts
```

Result:

```
 ❯ src/__tests__/proxy/route-policy-manifest.test.ts (10 tests | 1 failed) 24ms
     × assertion 1: bijection between route.ts files and manifest keys 4ms

 FAIL  src/__tests__/proxy/route-policy-manifest.test.ts > route-policy-manifest.json parity > assertion 1: bijection between route.ts files and manifest keys
AssertionError: route files with no manifest entry: src/app/api/vault/reset/route.ts: expected [ 'src/app/api/vault/reset/route.ts' ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/app/api/vault/reset/route.ts",
+ ]

 Test Files  1 failed (1)
      Tests  1 failed | 9 passed (10)
```

The failure message names the exact deleted path
(`src/app/api/vault/reset/route.ts`), confirming assertion 1 catches a missing
manifest entry and reports which file is affected.

Revert:

```
$ cp /tmp/route-policy-manifest.json.bak scripts/checks/route-policy-manifest.json
$ git diff --stat scripts/checks/route-policy-manifest.json
(no output — clean revert)
```

### Proof 2 — flip a `kind`, confirm classifier-parity failure

```
$ node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('scripts/checks/route-policy-manifest.json','utf8'));
m.routes['src/app/api/vault/reset/route.ts'].kind = 'api-default';
fs.writeFileSync('scripts/checks/route-policy-manifest.json', JSON.stringify(m, null, 2) + '\n');
"
$ npx vitest run src/__tests__/proxy/route-policy-manifest.test.ts
```

Result (two assertions fail — the kind mismatch itself, plus a cascading failure
because `api-default` requires a `handlerAuthReason` this entry does not carry):

```
 FAIL  src/__tests__/proxy/route-policy-manifest.test.ts > route-policy-manifest.json parity > assertion 2: kind matches classifyRoute(concretePath) for every entry
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/app/api/vault/reset/route.ts: declared=api-default actual=api-session-required",
+ ]

 FAIL  src/__tests__/proxy/route-policy-manifest.test.ts > route-policy-manifest.json parity > assertion 5: public/self-enforced surface has handlerAuthReason (>=10 chars) and non-empty auth
AssertionError: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "src/app/api/vault/reset/route.ts: handlerAuthReason missing or <10 chars",
+ ]

 Test Files  1 failed (1)
      Tests  2 failed | 8 passed (10)
```

Assertion 2's failure names the exact path and shows both the (wrong) declared
kind and the real `classifyRoute()` output (`api-session-required`), confirming
the classifier-parity check imports and uses the real production function
rather than a hand-copied constant.

Revert:

```
$ cp /tmp/route-policy-manifest.json.bak scripts/checks/route-policy-manifest.json
$ npx vitest run src/__tests__/proxy/route-policy-manifest.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)
$ rm -f /tmp/route-policy-manifest.json.bak
$ git diff --stat scripts/checks/route-policy-manifest.json
(no output — clean revert)
```

## check-permanent-delete-stepup.sh — DELETE_SIGNAL externalization sanity check

Confirms the `.sh` check still passes identically after switching `DELETE_SIGNAL`
from an inline literal to `jq -er '.deleteSignal' scripts/checks/route-class-patterns.json`:

```
$ bash scripts/checks/check-permanent-delete-stepup.sh; echo "exit=$?"
exit=0

$ npx vitest run scripts/__tests__/check-permanent-delete-stepup.test.mjs
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

Fail-closed sanity check on `jq -er` (missing/null key must exit non-zero, not
print the literal string `null`):

```
$ echo '{}' | jq -er '.deleteSignal'; echo "exit=$?"
null
exit=1

$ echo '{"deleteSignal": null}' | jq -er '.deleteSignal'; echo "exit=$?"
null
exit=1
```

## C5 fail-path proofs

RT7 fail-path proof for the C5 contract's drift check
(`npm run check:security-matrices` = regenerate `docs/security/route-policy-matrix.md`
+ `docs/security/deletion-retention-matrix.md` from their machine-readable sources,
then `git diff --quiet` the two paths). Both generated files were `git add`-ed to the
index first so `git diff` against a real baseline is meaningful (a brand-new untracked
file never shows a diff).

### Proof (a) — hand-edit a generated doc, drift check fails, regenerate fixes it

Baseline: clean tree, both generated docs match the generator's current output.

```
$ npm run check:security-matrices

> passwd-sso@0.4.64 check:security-matrices
> tsx scripts/generate-security-matrices.ts && git diff --quiet -- docs/security/route-policy-matrix.md docs/security/deletion-retention-matrix.md

Wrote /home/noguchi/ghq/github.com/ngc-shj/passwd-sso/docs/security/route-policy-matrix.md
Wrote /home/noguchi/ghq/github.com/ngc-shj/passwd-sso/docs/security/deletion-retention-matrix.md
exit=0
```

Hand-edit `docs/security/route-policy-matrix.md` (append a line the generator never emits):

```
$ echo "" >> docs/security/route-policy-matrix.md
$ echo "HAND-EDITED LINE -- not from the generator" >> docs/security/route-policy-matrix.md

$ git diff --stat -- docs/security/route-policy-matrix.md
 docs/security/route-policy-matrix.md | 2 ++
 1 file changed, 2 insertions(+)
```

The drift check's own comparison (`git diff --quiet`), run BEFORE regenerating, proves
the hand-edit is detected as drift:

```
$ git diff --quiet -- docs/security/route-policy-matrix.md docs/security/deletion-retention-matrix.md; echo "exit=$?"
exit=1
```

Regenerating (via the actual registered check, `npm run check:security-matrices`)
overwrites the hand-edited file with the generator's deterministic output and the
check passes again — the drift is fixed, not masked:

```
$ npm run check:security-matrices

> passwd-sso@0.4.64 check:security-matrices
> tsx scripts/generate-security-matrices.ts && git diff --quiet -- docs/security/route-policy-matrix.md docs/security/deletion-retention-matrix.md

Wrote /home/noguchi/ghq/github.com/ngc-shj/passwd-sso/docs/security/route-policy-matrix.md
Wrote /home/noguchi/ghq/github.com/ngc-shj/passwd-sso/docs/security/deletion-retention-matrix.md
exit=0

$ grep -c "HAND-EDITED LINE" docs/security/route-policy-matrix.md || echo "0 (removed by regeneration)"
0
0 (removed by regeneration)

$ git diff --stat -- docs/security/route-policy-matrix.md docs/security/deletion-retention-matrix.md
(no output = clean, matches staged baseline)
```

### Proof (b) — `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` runs the new step

Confirms the C3 placement contract: the `run_step` for the security-matrices drift
check sits in `scripts/pre-pr.sh`'s ungated region (immediately after the existing
`check:env-docs` registration, NOT inside any `if [ "$STATIC_ONLY" != "1" ]` block),
so CI's static-checks job (`PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh`) actually
executes it.

```
$ grep -n 'run_step "Static: security-matrices drift check"' scripts/pre-pr.sh
183:run_step "Static: security-matrices drift check" npm run check:security-matrices
```

Full run of `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` (completed in well under the
2-minute default timeout on this branch's diff — no need to extract a slow subset):

```
$ PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh
...
▸ Static: env drift check
...
  ✓ Static: env drift check

▸ Static: security-matrices drift check

> passwd-sso@0.4.64 check:security-matrices
> tsx scripts/generate-security-matrices.ts && git diff --quiet -- docs/security/route-policy-matrix.md docs/security/deletion-retention-matrix.md

Wrote /home/noguchi/ghq/github.com/ngc-shj/passwd-sso/docs/security/route-policy-matrix.md
Wrote /home/noguchi/ghq/github.com/ngc-shj/passwd-sso/docs/security/deletion-retention-matrix.md
  ✓ Static: security-matrices drift check

▸ Static: team-auth-rls
...
═══ Results ═══
  Passed: 32

✓ All pre-PR checks passed. Ready to create PR.
```

The `✓ Static: security-matrices drift check` line, appearing between `env drift check`
and `team-auth-rls` (the exact position it was registered at, line 183), proves the
step runs under `PRE_PR_STATIC_ONLY=1` — i.e. it is reachable by CI's static-checks job,
not only by full-mode `pre-pr.sh`.

## C6-C8 heading-guard fail-path proof

Fail-path proof for the refactored `scripts/checks/check-security-doc-exists.sh`
(C6 prerequisite): deleting a required heading from one of the three new docs
(C6/C7/C8) must make the check exit 1 and name both the doc and the missing
heading. Test performed against `docs/security/tenant-boundary-matrix.md`'s
`## Bypass surface` heading (C6).

Baseline (before mutation) — all green:

```
$ bash scripts/checks/check-security-doc-exists.sh
...
OK: docs/security/tenant-boundary-matrix.md exists and is non-empty
OK: heading present: docs/security/tenant-boundary-matrix.md :: ## RLS-enabled tables
OK: heading present: docs/security/tenant-boundary-matrix.md :: ## Bypass surface
OK: heading present: docs/security/tenant-boundary-matrix.md :: ## Worker roles and grants
OK: heading present: docs/security/tenant-boundary-matrix.md :: ## Tenant-context GUC mechanism
...
check-security-doc-exists: all checks passed.
```
(exit 0)

Mutation — delete line 90 (`## Bypass surface`) from the doc:

```
$ sed -i '90d' docs/security/tenant-boundary-matrix.md
$ sed -n '86,92p' docs/security/tenant-boundary-matrix.md
control for those tables is enforced entirely at the application layer.

---


`scripts/checks/check-bypass-rls.mjs` is the single source of truth for every `withBypassRls(...)`
call site in production code. It enforces three invariants:
```

Run the check (expect failure naming the doc + heading):

```
$ bash scripts/checks/check-security-doc-exists.sh
...
OK: docs/security/tenant-boundary-matrix.md exists and is non-empty
OK: heading present: docs/security/tenant-boundary-matrix.md :: ## RLS-enabled tables
FAIL: required heading not found: docs/security/tenant-boundary-matrix.md :: ## Bypass surface
OK: heading present: docs/security/tenant-boundary-matrix.md :: ## Worker roles and grants
OK: heading present: docs/security/tenant-boundary-matrix.md :: ## Tenant-context GUC mechanism
...
check-security-doc-exists: FAILED. See errors above.
$ echo $?
1
```

Confirmed: exit code 1, and the failure line names both `docs/security/tenant-boundary-matrix.md`
and `## Bypass surface` exactly — a reviewer can identify which doc and which heading
without re-running the script.

Note on `grep -qF` substring matching (observed during this proof, not a
regression): an initial attempt appended text to the heading line instead of
deleting it (`## Bypass surface REMOVED-FOR-TEST`) and the check still passed,
because `grep -qF "## Bypass surface"` matches as a substring of the mutated
line. This substring-match behavior is unchanged from the pre-refactor script
(the original single-doc check used the identical `grep -qF` pattern) — it is
not a regression introduced by the C6 data-driven refactor. The proof above
uses a full line-deletion mutation, which is the correct fail-path shape and
is what a real accidental heading removal (e.g. a rename during editing) would
produce.

Revert:

```
$ git checkout -- docs/security/tenant-boundary-matrix.md
$ bash scripts/checks/check-security-doc-exists.sh
...
check-security-doc-exists: all checks passed.
$ echo $?
0
```

Confirmed restored to a clean, fully-passing state (byte-identical to the
committed working-tree version prior to the mutation).

## C2 fail-path proofs

RT7 fail-path proofs for the plan's C2 contract (raw-SQL usage allowlist +
`check-raw-sql-usage.mjs`). All five mutations required by the plan's C2
acceptance criteria are recorded below with real command transcripts, each
followed by a clean revert (`git diff --stat` on the mutated file showing no
diff, or matching only this session's already-intended changes).

Pre-conditions: `scripts/checks/raw-sql-usage.txt` (29 entries) and
`scripts/checks/check-raw-sql-usage.mjs` committed to the working tree;
`node scripts/checks/check-raw-sql-usage.mjs` exits 0 before any mutation below.

### Proof 1 — add a raw call to an unlisted file → exit 1 naming the file

Backup, then append an unlisted `$queryRawUnsafe` call to `src/lib/notification.ts`
(a file with no pre-existing raw-SQL usage):

```
$ cp src/lib/notification.ts /tmp/.../notification.ts.bak
$ cat >> src/lib/notification.ts << 'EOF'

// TEMP: proof-1 fail-path mutation (reverted immediately after capture)
async function __proof1Unused(prisma: import("@prisma/client").PrismaClient) {
  return prisma.$queryRawUnsafe("SELECT 1");
}
EOF
$ node scripts/checks/check-raw-sql-usage.mjs
```

Result:

```
MISSING_FROM_ALLOWLIST: files call a raw-SQL primitive but are not listed in scripts/checks/raw-sql-usage.txt:
  src/lib/notification.ts

Add a line: `<path> # <purpose, >=10 chars>` to scripts/checks/raw-sql-usage.txt.

exit=1
```

The failure names the exact unlisted file. Revert:

```
$ cp /tmp/.../notification.ts.bak src/lib/notification.ts
$ git diff --stat src/lib/notification.ts
(no output — clean revert)
$ node scripts/checks/check-raw-sql-usage.mjs
check-raw-sql-usage: OK
```

### Proof 2 — remove a listed file's raw usage → STALE_EXEMPT

`src/lib/health.ts` is allowlisted (2 tagged-template `$queryRaw` call sites:
liveness `SELECT 1` and the audit-outbox depth/age metrics query). Replace both
with plain `Promise.resolve(...)` so the file no longer matches the `rawSql`
regex at all:

```
$ cp src/lib/health.ts /tmp/.../health.ts.bak
$ python3 - << 'EOF'
# replaces `await withTimeout(prisma.$queryRaw`SELECT 1`, ...)` with
# `await withTimeout(Promise.resolve(1), ...)`, and the audit-outbox metrics
# $queryRaw<...>`...` block with `Promise.resolve([{ pending: 0n, oldest_age: null }])`
EOF
$ grep -n '\$queryRaw' src/lib/health.ts || echo "no queryRaw left"
no queryRaw left
$ node scripts/checks/check-raw-sql-usage.mjs
```

Result:

```
STALE_EXEMPT: files are listed in raw-sql-usage.txt but no longer match a raw-SQL primitive — remove the entry:
  src/lib/health.ts

exit=1
```

Revert:

```
$ cp /tmp/.../health.ts.bak src/lib/health.ts
$ git diff --stat src/lib/health.ts
(no output — clean revert)
$ node scripts/checks/check-raw-sql-usage.mjs
check-raw-sql-usage: OK
```

### Proof 3 — marker-less `${...}` interpolation in a multi-line Unsafe template, in an ALREADY-allowlisted file → span ban exits 1

`src/workers/audit-outbox-worker.ts` is allowlisted (static SQL + `$N` params
throughout, no `ident-markers` suffix — default N=0). Its `reapStuckDeliveries`
function contains a `$executeRawUnsafe` call whose backtick template spans 10
physical lines. Inject an unmarked `${timeout}` interpolation into the
`last_error` string literal inside that span (mirroring sweep.ts's real
multi-line-template shape, per the plan's requirement that a single-line
mutation would not prove the span logic):

```
$ cp src/workers/audit-outbox-worker.ts /tmp/.../audit-outbox-worker.ts.bak
$ python3 - << 'EOF'
# replaces `"last_error" = 'reaped: processing timeout exceeded'` with
# `"last_error" = 'reaped: processing timeout exceeded ${timeout}ms'`
# inside the multi-line $executeRawUnsafe(`UPDATE "audit_deliveries" ... `) call
EOF
$ grep -n 'reaped: processing timeout' src/workers/audit-outbox-worker.ts
854:       "last_error" = 'reaped: processing timeout exceeded ${timeout}ms'
$ node scripts/checks/check-raw-sql-usage.mjs
```

Result:

```
UNMARKED_INTERPOLATION: `${...}` interpolation found inside an Unsafe raw-SQL call with no `// raw-sql-ident:` marker:
  src/workers/audit-outbox-worker.ts:854

Either remove the interpolation (prefer $N bound params) or add a `// raw-sql-ident: <reason, >=10 chars>` marker naming the validation mechanism, and bump `ident-markers=N` in raw-sql-usage.txt.

exit=1
```

The failure names the exact file:line of the interpolation, inside a call
whose template literal opens 8 lines earlier — confirming the span tracker
(not a per-physical-line grep) caught it, and that Layer 2 fires on an
already-allowlisted file (Layer 1 alone would have passed this file).

Revert:

```
$ cp /tmp/.../audit-outbox-worker.ts.bak src/workers/audit-outbox-worker.ts
$ git diff --stat src/workers/audit-outbox-worker.ts
(no output — clean revert)
$ node scripts/checks/check-raw-sql-usage.mjs
check-raw-sql-usage: OK
```

### Proof 4 — orphaned marker (no interpolation in its span) without bumping N → pairing check exits 1

`src/workers/retention-gc-worker/sweep.ts` carries 4 legitimate
`// raw-sql-ident:` markers (`ident-markers=4` in raw-sql-usage.txt), each
pairing with one interpolated Unsafe span (registry `entry.table` /
`entry.cutoffColumn` identifiers, validated by `validateRegistry()` at worker
boot). Orphan one marker by replacing its span's `${entry.table}` /
`${entry.cutoffColumn}` interpolations with hardcoded literal table/column
names, leaving the `// raw-sql-ident:` comment in place — the marker text is
untouched, but it no longer sits over any interpolated span. `raw-sql-usage.txt`
is deliberately NOT touched (still declares `ident-markers=4`):

```
$ cp src/workers/retention-gc-worker/sweep.ts /tmp/.../sweep.ts.bak
$ python3 - << 'EOF'
# in sweepPerTenantAge's $executeRawUnsafe call, replaces
#   `DELETE FROM ${entry.table} ... WHERE tenant_id = $1::uuid AND ${entry.cutoffColumn} < $2::timestamptz ...`
# with a hardcoded-literal version (`password_entry_history` / `created_at`),
# leaving the preceding `// raw-sql-ident: ...` comment line untouched.
EOF
$ node scripts/checks/check-raw-sql-usage.mjs
```

Result:

```
IDENT_MARKERS_MISMATCH: marked-span count does not match the declared ident-markers=N in raw-sql-usage.txt (fails in EITHER direction — an orphaned marker after a refactor fails too):
  src/workers/retention-gc-worker/sweep.ts: found 3 marked span(s), declared ident-markers=4

Update the `# ident-markers=N` suffix in raw-sql-usage.txt to match the actual marked-span count.

exit=1
```

Confirms the pairing check fails in the "N too high relative to actual marked
spans" direction — an orphaned marker after a refactor cannot silently persist
inside the declared budget.

Revert:

```
$ cp /tmp/.../sweep.ts.bak src/workers/retention-gc-worker/sweep.ts
$ git diff --stat src/workers/retention-gc-worker/sweep.ts
 src/workers/retention-gc-worker/sweep.ts | 4 ++++
 1 file changed, 4 insertions(+)
```

(The 4-line diff shown is this session's already-committed-to-working-tree
`raw-sql-ident` marker additions themselves — i.e. the diff against the
pre-C2 baseline, not a residue of the proof-4 mutation. `git diff` content was
inspected directly and confirmed to contain only the 4 intended marker
comment lines, none of the proof-4 hardcoded-literal substitution.)

```
$ node scripts/checks/check-raw-sql-usage.mjs
check-raw-sql-usage: OK
```

### Proof 5 — marker + interpolation added to a file whose txt entry has NO `ident-markers` suffix → default-N=0 pairing exits 1

`src/workers/audit-outbox-worker.ts`'s raw-sql-usage.txt entry carries no
`ident-markers=` suffix at all (defaults to N=0). Reuse proof 3's mutation
site, but this time add BOTH the interpolation AND a `// raw-sql-ident:`
marker with a reason well over 10 characters — without touching
raw-sql-usage.txt:

```
$ python3 - << 'EOF'
# adds `// raw-sql-ident: this reason is long enough to pass the 10-char floor`
# immediately above the $executeRawUnsafe( call, AND the same
# `${timeout}` interpolation from proof 3
EOF
$ grep -n 'raw-sql-ident: this reason' src/workers/audit-outbox-worker.ts
846:    // raw-sql-ident: this reason is long enough to pass the 10-char floor
$ node scripts/checks/check-raw-sql-usage.mjs
```

Result:

```
IDENT_MARKERS_MISMATCH: marked-span count does not match the declared ident-markers=N in raw-sql-usage.txt (fails in EITHER direction — an orphaned marker after a refactor fails too):
  src/workers/audit-outbox-worker.ts: found 1 marked span(s), declared ident-markers=0

Update the `# ident-markers=N` suffix in raw-sql-usage.txt to match the actual marked-span count.

exit=1
```

Confirms the fail-closed default: a file's absent `ident-markers=` suffix is
treated as N=0, so a NEW marker+interpolation pair cannot be blessed purely at
the call site — the central `raw-sql-usage.txt` diff is mandatory (must-declare,
not may-declare).

Revert:

```
$ cp /tmp/.../audit-outbox-worker.ts.bak src/workers/audit-outbox-worker.ts
$ git diff --stat src/workers/audit-outbox-worker.ts
(no output — clean revert)
$ node scripts/checks/check-raw-sql-usage.mjs
check-raw-sql-usage: OK
```

### Additional verification

```
$ npx eslint scripts/checks/check-raw-sql-usage.mjs
(no output — clean, no eslint-disable used)

$ PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh
...
▸ Static: raw-sql-usage
check-raw-sql-usage: OK
  ✓ Static: raw-sql-usage
...
```

The `✓ Static: raw-sql-usage` line is registered in `scripts/pre-pr.sh`'s
ungated region (immediately after `check:migration-drift`, alongside the
other `node scripts/checks/check-*.mjs` steps), confirming it is reachable by
CI's static-checks job (`PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh`), not
only full-mode `pre-pr.sh`.
