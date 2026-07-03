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
