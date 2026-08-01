# Plan: bump-brace-expansion-override

Date: 2026-08-01
Branch: `chore/bump-brace-expansion-override`
Revision: 5 (after Phase 1 review rounds 1-4 — see `bump-brace-expansion-override-review.md`)

## Project context

- **Type**: `config-only` — the diff touches root `package.json` (`overrides`),
  `package-lock.json`, and one security runbook document. No `src/` code, no schema,
  no runtime behavior.
- **Test infrastructure**: unit + integration + E2E + CI/CD (vitest 1006 files /
  13955 tests, 97 real-DB integration files, Playwright E2E, 7 GitHub Actions
  workflows, `scripts/pre-pr.sh` with 55 registered steps).
- **Verification environment constraints**:
  - `VC1` — **Trivy container scan is CI-only.** `scripts/pre-pr.sh` does not build
    the Docker image or run Trivy (`project_ci_gates_beyond_pre_pr`). Locally
    verifiable only by an explicit `docker build` + `trivy image` run.
    Classification for this change: **not applicable** — see C4; the npm-bundled
    `brace-expansion` copy is 5.0.8, the first release outside every band of the
    advisory, so no Dockerfile change. No `blocked-deferred` path is created.
  - `VC2` — **npm resolution depends on the npm version, and neither side is fully
    pinned.** Local is Node 26.5.0 / npm 11.17.0. CI pins **Node** via
    `node-version-file: ".nvmrc"` (24) but never runs `corepack enable` and does not
    honor `packageManager: npm@11.17.0`, so CI's npm is whatever ships with the
    resolved Node 24 build. Neither environment pins npm itself. For an
    override-floor bump the resolution is insensitive to npm minor versions;
    recorded so a future lockfile-sensitive change does not over-trust either side.
    Classification: `verifiable-CI` (CI's `npm ci` is the check that matters for
    merge, without being a reproducibility guarantee). See SC6.
  - Per the `config-only` rule: reviewers MUST NOT raise Major/Critical findings
    that ask for new automated test infrastructure for this change. Existing gates
    are the verification surface.

## Objective

Clear the `high` advisory `GHSA-mh99-v99m-4gvg` from the repository root so that
`npm audit` is 0 findings on **both** scopes (`--omit=dev` and full); close the same
advisory's remaining uncovered version bands, which `npm audit` cannot report; and
close the one other member of that defect class in the same `overrides` block
(`js-yaml`, C6) so the change fixes the class rather than the reported instance.

**Scope honesty**: the full-scope result is a one-shot state, not an invariant — no
CI gate enforces it (SC5). The Objective is "make it clean and prove it", not "keep it
clean automatically".

## Background — why the existing override did not already cover this

`package.json` already carries `brace-expansion` overrides. They are **stale with
respect to the current advisory**, which is the failure mode recorded in
`project_cve_gate_two_surfaces` ("an existing override becomes stale when a NEW
advisory covers the pinned version itself") and `project_dependabot_prod_audit_gate_blocks_dev_pr`
("npm picks the lowest satisfying already-in-tree version, so a floor at or below the
advisory ceiling does not force an upgrade").

This is the **second** advisory to hit these same entries. The first was
`GHSA-3jxr-9vmj-r5cp`, fixed in commit `34aa7758b`
(`fix(security): patch brace-expansion (1.x/2.x) + js-yaml DoS CVEs (#703)`).

### Advisory range — the full bands, not the tree-intersected ones

**Authority**: `gh api /advisories/<ghsa-id>`. `npm audit --json` is **not** the
authority — it reports only the bands that intersect the versions currently resolved
in the lockfile, so it structurally cannot show a band that nothing currently
resolves into. Reading the range from `npm audit` is what produced the gap that
review round 1 caught.

```bash
gh api /advisories/GHSA-mh99-v99m-4gvg \
  --jq '[.vulnerabilities[] | {vulnerable: .vulnerable_version_range, patched: .first_patched_version}]'
```

`GHSA-mh99-v99m-4gvg` (high — DoS via unbounded expansion length → OOM):

| band | first patched |
|---|---|
| `< 1.1.17` | 1.1.17 |
| `>= 2.0.0, < 2.1.3` | 2.1.3 |
| `>= 3.0.0, < 3.0.3` | 3.0.3 |
| `>= 4.0.0, < 5.0.8` | 5.0.8 |

`npm audit` reported only the first two — the only bands intersecting the tree.

`GHSA-3jxr-9vmj-r5cp` (high — DoS via exponential-time expansion) additionally covers
`>= 3.0.0, < 5.0.7`. Published 3.x tops out at **3.0.6** and 4.x at **4.0.1**, both
below 5.0.7, so **majors 3 and 4 have no safe version at all** — the in-major fix
3.0.3 is still vulnerable to the other advisory. The first clean release across both
is **5.0.8**.

### Current state vs. required coverage

| override key | floor | resolved | covered band | verdict |
|---|---|---|---|---|
| `brace-expansion@1` | `^1.1.16` | 1.1.16 | `[1.0.0, 2.0.0)` | floor below the ceiling — **stale** |
| `brace-expansion@2` | `^2.1.2` | 2.1.2 | `[2.0.0, 3.0.0)` | floor below the ceiling — **stale** |
| — | — | — | `[3.0.0, 5.0.0)` | **no key exists — uncovered** |
| `brace-expansion@>=5.0.0 <5.0.8` | `^5.0.8` | 5.0.8 | `[5.0.0, 5.0.8)` | correct, but too narrow a lower bound |

## Runbook reconciliation

`docs/security/dependency-cve-response.md` is the repo's playbook for this exact class
of change and it must be consulted, not re-derived. Two of its statements are wrong in
ways this change has to correct (C5):

1. **Step 4** says: *"If a new CVE has appeared on the same package, write a new
   override block with the new bounds rather than mutating the existing one."* Followed
   literally here it produces a **silently dead override**, because npm resolves
   overlapping keys for the same package by first-match in JSON key order with no
   warning:

   ```
   {"brace-expansion@1":"1.1.16","brace-expansion@>=1.0.0 <1.1.17":"^1.1.17"}
     → resolves 1.1.16 (the vulnerable version), exit 0, no diagnostic
   ```

   The advice is sound for a genuinely new advisory on a **disjoint** band; it is wrong
   when the new advisory covers versions an existing key already selects — which is
   this case. Hence this plan **mutates** the `@1`/`@2` floors and **widens** the
   5.x key rather than adding overlapping blocks.

2. **Step 3** says: *"`npm run pre-pr` runs the same `npm audit` step locally that CI
   does."* It does not — `scripts/pre-pr.sh` contains zero `npm audit` invocations
   (verified). A responder following Step 3 believes the audit was confirmed locally
   when none ran.

## Member-set derivation (R42)

Two classes are universally quantified here, and both member sets are derived from
their defining primitive rather than from a supplied list.

### Class A — every `brace-expansion` copy reachable from this repository

Defining primitive: every tracked lockfile, and every `packages` key ending in
`brace-expansion` within it.

```bash
git ls-files | grep -E 'package-lock\.json$'
# → cli/package-lock.json, extension/package-lock.json, package-lock.json

node -e "const l=require('./<lockfile>');for(const [k,v] of Object.entries(l.packages))
  if(k.endsWith('node_modules/brace-expansion')) console.log(v.version, v.dev?'(dev)':'(prod)', k)"
# 'node_modules/' must be part of the suffix. A bare endsWith('brace-expansion') also
# matches @isaacs/brace-expansion — a different package with its own version history.
```

| # | lockfile | path | version | scope | in any band |
|---|---|---|---|---|---|
| M1 | root | `node_modules/brace-expansion` | 1.1.16 | dev | **yes** |
| M2 | root | `node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion` | 2.1.2 | dev | **yes** |
| M3 | root | `node_modules/@typescript-eslint/parser/node_modules/brace-expansion` | 5.0.8 | dev | no |
| M4 | root | `node_modules/@ts-morph/common/node_modules/brace-expansion` | 5.0.8 | dev | no |
| M5 | root | `node_modules/shadcn/node_modules/brace-expansion` | 5.0.8 | dev | no |
| M6 | root | `node_modules/glob/node_modules/brace-expansion` | 5.0.8 | **prod** | no |
| — | `cli/package-lock.json` | — | — | — | no copies present |
| — | `extension/package-lock.json` | — | — | — | no copies present |
| M7 | Docker runner image | `/usr/local/lib/node_modules/npm/node_modules/brace-expansion`, pinned by `BE_VER` in `Dockerfile` | 5.0.8 | image | no |

### Class B — every band of the advisory the `overrides` block must cover

This is the class review round 1 found missing. The defining primitive is the
advisory's own `vulnerable_version_range` list (see the `gh api` command above), **not**
`npm audit` output.

| band | covering key after this change | resolves to |
|---|---|---|
| `[1.0.0, 2.0.0)` | `brace-expansion@1` → `^1.1.17` | 1.1.18 |
| `[2.0.0, 3.0.0)` | `brace-expansion@2` → `^2.1.3` | 2.1.4 |
| `[3.0.0, 5.0.8)` | `brace-expansion@>=3.0.0 <5.0.8` → `^5.0.8` | 5.0.9 |
| `[5.0.8, ∞)` | none needed — outside every band | — |

The three keys are **disjoint and gapless** below 5.0.8, so the first-match hazard
above cannot arise. `A \ B` = ∅ for both classes.

### Class C — every bounded-range entry in the `overrides` block with the same defect

R42 trigger (b): the seed was one advisory on one package. The defect class is *"a
bounded-range override key that covers fewer bands than its package's current
advisories"*, and `brace-expansion` is one member, never the set. Every entry in the
root `overrides` block plus `cli/package.json` and `extension/package.json` was swept
against its own live advisories.

```bash
gh api "/advisories?ecosystem=npm&affects=<pkg>&per_page=30" \
  --jq '.[]|select(.withdrawn_at==null)|"\(.ghsa_id) \(.severity) :: \([.vulnerabilities[]|select(.package.name=="<pkg>")|.vulnerable_version_range]|join(" | "))"'
```

**Verdicts are derived from the resolved version, not from the key's syntax.** An
unbounded `>=` floor is *not* structurally immune: npm picks the highest satisfying
version by default, but that is a resolution behavior, not a guarantee, and a floor
value can itself sit inside a newly-published band. Every entry below was checked by
reading the **committed lockfile's resolved version** and comparing it against the
package's live advisory list — never by inspecting the override key alone.

```bash
# resolved version, from the lockfile (NOT `npm ls`, which reads a possibly-stale node_modules)
node -e "const l=require('./<lockfile>');for(const [k,v] of Object.entries(l.packages))
  if(k.endsWith('node_modules/<pkg>')) console.log(v.version, k)"
```

**The `node_modules/` prefix in the suffix is load-bearing.** A bare
`endsWith('/<pkg>')` also matches any scoped package whose name ends in `<pkg>` — for
`postcss` it returns `node_modules/@tailwindcss/postcss` (4.3.3, an entirely different
package) alongside the real `node_modules/postcss` (8.5.22), and the same collision
fires for `lodash` (`@types/lodash`) and `nodemailer` (`@types/nodemailer`). The
false rows carry no marker, so a sweep that reads the first line gets the wrong
version silently. Verified:
`"node_modules/@tailwindcss/postcss".endsWith("node_modules/postcss") === false`, while
`"node_modules/vite/node_modules/postcss".endsWith("node_modules/postcss") === true`.

| entry | resolved | verdict |
|---|---|---|
| `brace-expansion@1`, `@2`, `>=5.0.0 <5.0.8` | 1.1.16 / 2.1.2 / 5.0.8 | **defective** — the seed (C1) |
| `js-yaml@>=4.0.0 <4.3.0` | 4.3.0 | **defective** — covers only the 4.x band (C6) |
| `qs`, `hono`, `@hono/node-server`, `lodash`, `cross-spawn`, `@babel/core`, `nodemailer`, `find-my-way`, `sharp`, `body-parser` | — | clean — floors at or above every currently patched version |
| `postcss` (root) | **8.5.22** | clean — above `GHSA-r28c-9q8g-f849`'s patched 8.5.18 (`<= 8.5.17`, high, published 2026-07-24) |
| `postcss` (cli) | **8.5.23** | clean — same advisory, same reasoning |
| `effect`, `esbuild` (root), `esbuild` (cli) | — | clean — no live advisory band sits above their floors |
| `rollup` (extension) | — | clean |
| `undici` (extension), key `>=7.28.0 <8` | 7.28.0 | clean **by floor** — 7.28.0 is the `first_patched_version` for every advisory touching the 7.x line. The `<8` cap is **not** security-justified: every 8.x-touching advisory is patched (8.2.0 or 8.5.0) and `latest` is well past both. The cap's actual rationale (peer/engine constraint from the extension's build chain) is unverified and out of scope here — recorded so nobody cites this row as evidence that 8.x is unsafe. |

`A \ B` = ∅: both defective members are fixed in this PR (C1, C6).

**Method note.** A round-3 reviewer reported `cli/`'s postcss as live-vulnerable at
8.5.15. That was an artifact of `npm ls`, which reads the **installed**
`cli/node_modules` — stale on this machine at 8.5.15 — rather than the committed
lockfile, which pins 8.5.23. The `8.5.15` string does appear once in
`cli/package-lock.json`, but as a *dependency range* (`"postcss": "^8.5.15"`), not a
resolved version. This is why the command above reads the lockfile: `npm ls` answers a
question about one developer's disk, `npm ci` and CI answer the question about the repo.

## Requirements

**Functional**

- F1: `npm audit` at the repository root reports 0 vulnerabilities at every severity.
- F2: `npm audit --omit=dev --audit-level=high` continues to report 0 — the gate the
  three CI `Audit: * dependencies` jobs actually run must not regress.
- F3: No production dependency version changes. This is a dev-tree-only bump.
- F4: Every band of `GHSA-mh99-v99m-4gvg` is covered by an override key, including the
  bands nothing currently resolves into.
- F5: `docs/security/dependency-cve-response.md` no longer contains the two incorrect
  statements identified above.
- F6: The one other member of the same defect class in the `overrides` block
  (`js-yaml`, Class C) is fixed in this PR, so the change closes the class rather than
  the reported instance.

**Non-functional**

- N1: The `package-lock.json` diff is bounded to entries reachable from the bumped
  overrides. Unrelated churn introduced by the newer local npm is a defect, not an
  acceptable side effect (VC2).
- N2: The existing override style is preserved — caret floor, same key shape. This
  block is edited by several past security PRs and a re-styled entry makes those diffs
  harder to read.

## Technical approach

Three key changes in the `overrides` block:

```jsonc
"brace-expansion@1": "^1.1.17",              // was ^1.1.16 — floor raised above the ceiling
"brace-expansion@2": "^2.1.3",               // was ^2.1.2 — floor raised above the ceiling
"brace-expansion@>=3.0.0 <5.0.8": "^5.0.8",  // was >=5.0.0 <5.0.8 — lower bound widened
```

then `npm install` — not `npm audit fix`, which does not go through the `overrides`
block and would leave the root cause in place for the next advisory.

The third line replaces the existing `>=5.0.0 <5.0.8` key rather than adding alongside
it: the new selector is a strict superset, so keeping both would create the overlapping-key
hazard the runbook reconciliation section describes.

**Cross-major force — accepted risk.** `brace-expansion` 5.x dropped the default export
(`import expand from` → `import { expand } from`), so a hypothetical 3.x/4.x consumer
forced to 5.0.8 would fail at ESM link time. This is the same hazard
`dependency-cve-response.md` Step 2 flags for 1.x/2.x. It is accepted because (a) there
is no safe 3.x/4.x version to force to instead, (b) nothing resolves there today, (c)
the failure mode is a loud link-time error, never a silent wrong result, and (d)
`npm install` exits 0 in every override shape tested, so the override cannot break the
install itself.

**The 3.x/4.x band is reachable, not hypothetical.** `minimatch@10.0.0` declares
`brace-expansion: ^4.0.0` (verified: `npm view minimatch@10.0.0 dependencies`), which
sits inside the vulnerable band `>=4.0.0 <5.0.8`. `minimatch` is already present three
times in this repo's tree (M3, M5, M6), pinned to 10.2.x which declares `^5.0.8`. A
downgrade or a second parent resolving an older `minimatch@10.x` lands directly in the
band the widened key closes. An earlier draft claimed the ecosystem had renamed this
dependency to `@isaacs/brace-expansion`; that is **false** — `minimatch@10.2.6` depends
on plain `brace-expansion@^5.0.8`, and `@isaacs/brace-expansion` appears zero times in
any of this repo's lockfiles.

No concurrency / isolation-level primitive is involved, so the plan-stage real-DB probe
requirement does not apply.

## Contracts

### C1 — `overrides` covers every band of the advisory, with disjoint keys

- **Change**: the three lines above.
- **Invariants**:
  - I1 (**detection only, verified manually per T11** — deliberately *not* "verified by
    gate"; see this contract's Control class): every band in the advisory's
    `vulnerable_version_range` list is selected by exactly one override key whose value
    resolves outside every band.
  - I2: the override keys for `brace-expansion` are **pairwise disjoint**. Rationale:
    npm resolves overlapping keys by silent first-match in JSON key order, so an
    overlap makes correctness depend on an unlinted property of the file.
  - I3: no key for a package **other than** `brace-expansion` is added, removed, or
    reordered.
- **Control class** (R49): **detection or audit only**. Raising an override floor denies
  nothing at runtime; it changes what npm resolves at install time, and the actual
  enforcement is the CI `npm audit` step. Nothing else in the plan may treat this as a
  boundary.
  - **Adjudication authority** (R47): npm's semver resolver as invoked by `npm install`,
    and the **GitHub Advisory Database record fetched by GHSA id** for the band list.
    `npm audit` adjudicates only "which bands intersect us today", never "what the
    advisory covers".
- **Forbidden patterns**:
  - `pattern: "brace-expansion@1": "\^1\.1\.16"` — reason: the stale floor must be gone, not supplemented.
  - `pattern: "brace-expansion@2": "\^2\.1\.2"` — reason: same.
  - `pattern: "brace-expansion@>=5\.0\.0 <5\.0\.8"` — reason: the narrow key must be replaced by the widened one, not kept alongside it (overlap → first-match hazard).
  - `pattern: audit fix` (in any committed script or doc added by this change) — reason: the fix belongs in `overrides`.
- **Acceptance** (kept symmetric with C6's, since the two contracts carry the
  same-shaped invariants):
  - `node -p "require('./package.json').overrides"` shows the three keys.
  - A pairwise-disjointness read of the `brace-expansion@*` keys — sorted by lower
    bound, each key's lower bound is `>=` the previous key's upper bound.
  - The resolved versions, read **from the lockfile** (not `npm ls`), satisfy
    M1 ≥ 1.1.17 and M2 ≥ 2.1.3 — same command as the Class A derivation. (Also covered
    by T4/T11; restated here so C1's acceptance stands alone, as C6's does.)

### C2 — `package-lock.json` re-resolved, churn bounded

- **Invariants**:
  - I4: `npm ci` from the committed lockfile reproduces the tree. **Note the limit**:
    `package-lock.json` `packages[""]` records `name, version, dependencies,
    devDependencies, engines` and **not** `overrides` (verified), so `npm ci` will
    *not* fail on a `package.json`-only override edit with a stale lockfile. I4 is
    therefore a reproducibility check, not a same-ness check between the two files —
    the same-ness is established by running `npm install` and committing the result,
    and confirmed by C3's audit on the reinstalled tree.
  - I5 (N1): every changed lockfile hunk names `brace-expansion` or one of its direct
    parents (`minimatch`, and the packages holding a nested copy). A hunk naming an
    unrelated package is a VC2 regression and must be reverted before commit. **This
    check is a manual read of the diff, not a mechanical gate** — recorded so it is
    not mistaken for automation (T2).
  - I6: `lockfileVersion` stays 3.
- **Control class** (R49): **detection or audit only**.
- **Forbidden patterns**:
  - `pattern: "lockfileVersion": [^3]` — reason: an npm-version-induced format change is out of scope and would make the diff unreviewable.
- **Acceptance**: expected changed paths are M1 and M2 only (M3-M6 are already 5.0.8
  and the widened key does not move them — confirmed by probe). Any other changed path
  is checked by name against the Class A table before T5 is treated as passed.

### C3 — Both audit scopes clean; production scope proven not regressed

- **Invariants**:
  - I7: `npm audit` (full, dev included) → `found 0 vulnerabilities`.
  - I8: `npm audit --omit=dev --audit-level=high` → exit 0. This is the scope the three
    CI jobs run; C3 must prove it did not regress, not merely that the new scope became
    clean. **I8 was already green before the change** — it is a regression guard, and
    cannot prove the fix worked. I7 is the check that proves the fix.
  - I9: `cli/` and `extension/` audits remain 0 on both scopes.
- **Control class** (R49): **fail-closed verification gate** — the audit commands exit
  non-zero on a finding and cannot pass without deciding. Bypassable only by editing
  the gate, which this change does not touch. **Not durable**: nothing re-runs I7 after
  merge (SC5).
- **Acceptance**: the commands run and their output is recorded in the deviation log.

### C4 — No second-surface (Trivy / Dockerfile) change is required

- **Subject**: the `project_cve_gate_two_surfaces` obligation — a transitive CVE can red
  two independent gates, and fixing one leaves the other red.
- **Determination**: the npm-bundled copy (M7) is pinned by `Dockerfile` `BE_VER=5.0.8`.
  5.0.8 is the first patched version of the widest band (`>= 4.0.0, < 5.0.8`) and lies
  outside every band of both advisories, so neither reaches the Trivy surface.
- **Invariants**:
  - I10: `Dockerfile` is unchanged by this PR.
  - I11: the determination is re-derived against the **full advisory band list from
    `gh api /advisories/<ghsa-id>`**, not against `npm audit` output and not against
    memory of a previous advisory. This matters by one patch release: had `BE_VER` been
    5.0.7, the `npm audit`-derived range would have declared it clean while the
    advisory covers it.
- **Control class** (R49): **detection or audit only** — this contract records a
  determination; it enforces nothing.
- **Acceptance**: `git diff --name-only` does not list `Dockerfile`; the `BE_VER` value
  and the full band list are both cited in the deviation log.

### C5 — `docs/security/dependency-cve-response.md` corrected

- **Change**: two edits to the runbook.
  1. **Step 4** — narrow the "new block rather than mutating" advice to *disjoint*
     bounds, state the first-match hazard, and name all **three** available moves so a
     responder does not default to accumulating narrow blocks:
     - *(a) raise an existing key's floor in place* — when the new advisory covers
       versions that key already selects;
     - *(b) widen an existing key's selector* — when the new band is adjacent to one an
       existing key already covers (this PR's `>=5.0.0 <5.0.8` → `>=3.0.0 <5.0.8` is
       this move: the floor value did not change, the selector's lower bound did);
     - *(c) add a new block* — only when its selector is provably disjoint from every
       existing key for the same package.
     Disjointness check to state explicitly: *for the keys sorted by lower bound, each
     key's lower bound must be `>=` the previous key's upper bound.* npm resolves
     overlapping keys by silent first-match in JSON key order, with no warning — so an
     overlap makes the fix depend on an unlinted property of the file.
  2. **Step 3 and the Quick reference row** — remove the claim that `npm run pre-pr`
     runs the CI `npm audit` step. It does not; name the audit commands explicitly as a
     separate manual step.
- **Invariants**:
  - I12: every command the runbook tells a responder to run for verification exists and
    performs the check the surrounding prose claims. Derivation for this round: each
    command in the doc was run or read against `scripts/pre-pr.sh` / `package.json`
    scripts; the two failures above are the complete delta.
  - I13: the amendment cites this incident (both GHSA ids) so the next responder has
    the history in one place.
- **Control class** (R49): **detection or audit only** — documentation. It shapes what a
  human does; it enforces nothing. Explicitly *not* a substitute for SC5's absent gate.
- **Forbidden patterns**:
  - `pattern: npm run pre-pr.*npm audit` — reason: the false-equivalence claim must not survive in any form.
- **Acceptance**: `grep -n 'npm audit' scripts/pre-pr.sh` returns nothing **and** the
  runbook no longer asserts otherwise; the Step 4 bullet names the disjointness
  condition.

### C6 — `js-yaml` override covers every band of its current advisories

- **Subject**: the sibling entry in the same `overrides` block carrying the identical
  defect (Class C). Found by applying C1's own method — read the full band list from
  `gh api`, not from `npm audit` — to the rest of the block.
- **Current state**: `"js-yaml@>=4.0.0 <4.3.0": "^4.3.0"` covers one band of one
  advisory. The resolved copy is 4.3.0 (dev-only, via `eslint` → `@eslint/eslintrc` and
  `shadcn` → `cosmiconfig`), which sits safely inside that covered band — which is
  exactly why `npm audit` reports nothing, the same blind spot that hid the
  `brace-expansion` 3.x/4.x gap.
- **Advisory sweep** (9 non-withdrawn advisories; union of vulnerable bands):

  | band | uncovered today | covering key after this change | resolves to |
  |---|---|---|---|
  | `[3.0.0, 3.15.0)` — `GHSA-52cp-r559-cp3m` (high) + 4 others | **yes** | `js-yaml@>=3.0.0 <3.15.0` → `^3.15.0` | 3.15.1 |
  | `[4.0.0, 4.3.0)` — `GHSA-52cp-r559-cp3m` (high) + 2 others | no | `js-yaml@>=4.0.0 <4.3.0` → `^4.3.0` (unchanged) | 4.3.1 |
  | `[5.0.0, 5.2.2)` — `GHSA-pm4m-ph32-ghv5` (high) + 2 others | **yes** | `js-yaml@>=5.0.0 <5.2.2` → `^5.2.2` | 5.2.3 |
  | `< 3.0.0` — 5 advisories: `GHSA-xxvw-45rp-3mj2` (critical) + `GHSA-8j8c-7jfh-h6hx` (**high**, code injection) + 3 medium | **yes** | none — see SC7 | — |

- **Change**: add two keys; leave the existing 4.x key untouched.

  ```jsonc
  "js-yaml@>=3.0.0 <3.15.0": "^3.15.0",   // new
  "js-yaml@>=4.0.0 <4.3.0": "^4.3.0",     // unchanged
  "js-yaml@>=5.0.0 <5.2.2": "^5.2.2",     // new
  ```

- **Invariants**:
  - I14 (detection only, verified manually per T13): every band listed above except the
    `< 3.0.0` row is selected by exactly one key whose value resolves outside every band.
  - I15: the three `js-yaml` keys are **pairwise disjoint**. `[3.0.0,3.15.0)`,
    `[4.0.0,4.3.0)`, `[5.0.0,5.2.2)` share no version. The gaps between them
    (`[3.15.0,4.0.0)` and `[4.3.0,5.0.0)`) are clean territory needing no key.
  - I16: `js-yaml` stays resolved at 4.3.x — **zero lockfile churn expected**, since
    nothing resolves into either newly-covered band.
- **Control class** (R49): **detection or audit only**, same as C1 — this is
  install-time resolution, not a runtime denial. Adjudication authority is the GitHub
  Advisory Database record fetched by GHSA id.
- **Forbidden patterns**:
  - `pattern: "js-yaml": "` (a bare unbounded key) — reason: would force every major to one version, breaking 3.x/4.x consumers; the runbook's Step 2 warning applies.
- **Acceptance**:
  - `node -p "require('./package.json').overrides"` shows three `js-yaml` keys.
  - **A pairwise-disjointness read of the `js-yaml@*` keys** — sorted by lower bound,
    each key's lower bound is `>=` the previous key's upper bound. (This mirrors C1's
    acceptance for `brace-expansion@*`; the two contracts carry the same-shaped
    invariant and must carry the same check.)
  - The resolved version is still 4.3.x, read **from the lockfile**, not `npm ls`:
    `node -e "const l=require('./package-lock.json');for(const [k,v] of Object.entries(l.packages)) if(k.endsWith('node_modules/js-yaml')) console.log(v.version,k)"`.
  - `git diff package-lock.json` shows no `js-yaml` hunk.
- **Consumer cross-check** (same obligation C1 discharges for `brace-expansion`):
  `js-yaml` has no `packageVersion` pin in `scripts/license-allowlist.json`, no
  reference in `Dockerfile`, and no copy in `cli/package-lock.json` or
  `extension/package-lock.json` — verified by grep. Recorded so Phase 3 re-verifies
  rather than trusting this sentence.

### Consumer-flow walkthrough

C1-C5 define no API response shape, persisted-state shape, message payload, or event
payload. The cross-boundary artifacts are `package-lock.json` and the runbook:

- `Consumer: CI npm ci steps (.github/workflows/ci.yml — every job with a setup-node step)` reads the whole lockfile and uses it to reproduce the tree. Fails closed on a lockfile it cannot satisfy — but see I4's recorded limit regarding the `overrides` block.
- `Consumer: Dockerfile builder stage` reads the lockfile via `npm ci` and uses it to install production dependencies; unaffected because no production entry changes (F3).
- `Consumer: scripts/checks/check-licenses.mjs (strict license audit)` reads the installed tree and compares against `scripts/license-allowlist.json`. `brace-expansion` has **no** `packageVersion` pin there (verified: `grep -n 'brace-expansion' scripts/license-allowlist.json` → no match), so a version bump cannot break a pin the way the sharp bump did (`project_sharp_override_license_pin`). Recorded so Phase 3 re-verifies rather than trusting this sentence.
- `Consumer: a human CVE responder` reads `dependency-cve-response.md` and uses its Step 2/3/4 instructions to choose an override shape and to verify. C5 exists because two of those instructions currently mislead.

## Testing strategy

No new tests. This is a `config-only` change with no `src/` diff; the verification
surface is the existing gates.

| # | Check | Command | Proves | Can it fail if the fix is wrong? |
|---|---|---|---|---|
| T1 | full audit clean | `npm audit` | F1 / I7 | yes — the finding reappears |
| T2 | prod audit not regressed | `npm audit --omit=dev --audit-level=high` | F2 / I8 | only as a regression guard — it was already green |
| T3 | sub-package audits | `(cd cli && npm audit)`, `(cd extension && npm audit)` | I9 | **no** — `cli/` and `extension/` carry no `brace-expansion` or `js-yaml` copy at all and are already green, so this cannot detect a wrong fix in the root block. Recorded as a no-change assertion only |
| T4 | Class A re-derived | the lockfile enumeration command | C2 acceptance — assert M1 ≥ 1.1.17, M2 ≥ 2.1.3 | yes |
| T5 | churn bounded (manual read) | `git diff --stat package-lock.json`, then check each changed version line by name against the Class A table | N1 / I5 | manual — see review-finding **T2** in `bump-brace-expansion-override-review.md` (a finding label, not this table's row T2) |
| T6 | lockfile reproducible | `npm ci` in a clean checkout, then `npx prisma generate` | I4 | deferred to CI (SC3) |
| T7 | strict license audit **against the real lockfile** | `npm run licenses:check:strict` | license-allowlist consumer | yes — this is the command CI's `license-audit` job runs. (`npx vitest run scripts/__tests__/check-licenses.test.mjs` runs the tool against synthetic fixtures and is byte-identical with or without this change — it does **not** prove anything about this diff.) |
| T8 | toolchain still works | `npx eslint .` | no dev-toolchain regression | yes |
| T9 | full suite | `npx vitest run` | Mandatory Checks (CLAUDE.md) | yes |
| T10 | production build | `npx next build` | Mandatory Checks (CLAUDE.md) | yes |
| T11 | Class B coverage | for each band from `gh api /advisories/GHSA-mh99-v99m-4gvg`, name the covering key and confirm its value resolves outside every band, then confirm the keys sorted by lower bound are non-overlapping | F4 / I1 / I2 | **manual** — semver containment done by hand against `gh api` output; no scripted checker exists. "Yes" only if the person executing it actually performs the arithmetic |
| T12 | runbook claims hold — **paired positive/negative control covering all three of C5's edits** | **(a) Step 3 sentence**: before → `grep -n 'runs the same.*npm audit' docs/security/dependency-cve-response.md` **must match** (verified: matches line 98 today); after → must not match. **(b) Quick reference row**: before → `grep -n 'Full pre-PR parity check' docs/security/dependency-cve-response.md` **must match** (this row carries the same false implication in table form and contains no `npm audit` substring, so grep (a) and C5's forbidden pattern both miss it); after → must not match, **and** — because the grep keys on a literal string, a cosmetic rename would satisfy it without fixing the substance — a **read of whatever replaced the row**, confirming it does not present `npm run pre-pr` as covering the audit step. The read is not optional: without it, (b) degrades into the same can't-fail shape it was written to close. **(c) Step 4 rewrite**: after → `grep -n 'lower bound' docs/security/dependency-cve-response.md` must match, and a read confirming all three moves (raise-in-place / widen-selector / disjoint-block) are named. **(d) control**: `grep -n 'npm audit' scripts/pre-pr.sh` → no match | F5 / I12 | (a) **yes** — positive control matches line 98 today and must stop matching. (b) **partly** — the grep half is mechanical, but only the paired read can distinguish a real fix from a rename that dodges the literal string. (c) **yes**. (d) **no** — it already returns no match on the unmodified repo, so it is evidence about `pre-pr.sh`, never about whether C5 landed |
| T13 | Class C coverage (`js-yaml`) | for each band from the `js-yaml` advisory sweep, name the covering key; **confirm the three `js-yaml@*` keys sorted by lower bound are non-overlapping** (I15 — the same check T11 performs for `brace-expansion@*`); then read the resolved version **from the lockfile** (expect 4.3.x) and confirm `git diff package-lock.json` has no `js-yaml` hunk | C6 / I14 / I15 / I16 | **manual** for the band mapping and the disjointness read; mechanical for the resolution and churn assertions |

T8 is the one non-obvious check: `eslint@9.39.5 → minimatch@3.1.5 → brace-expansion@1.1.16`
and `@typescript-eslint/typescript-estree → minimatch@9.0.9 → brace-expansion@2.1.2` are
the two consumers being bumped, so ESLint is the tool most likely to notice a behavioral
difference in brace expansion.

`scripts/pre-pr.sh` runs T8/T9/T10 plus the 46 static gates; running it once covers them.
The audit checks (T1-T3) and the license check (T7) are **not** part of pre-pr
(`project_ci_gates_beyond_pre_pr`, verified) and must be run separately.

## Considerations & constraints

### Scope contract

- **SC1** — the 5.x upper bound stays at `^5.0.8` even though 5.0.9 exists. No advisory
  covers 5.0.8; `^5.0.8` resolves to 5.0.9 on a fresh install anyway. Owner: whichever
  future advisory covers the 5.x line.
- **SC2** — `Dockerfile` `BE_VER` is left at 5.0.8 (C4). Owner: same as SC1.
- **SC3** — T6 (`npm ci` in a clean checkout) is delegated to CI rather than run locally.
  **Anti-Deferral cost-justification**: a local clean-checkout `npm ci` re-installs the
  full dev tree and then requires `npx prisma generate` to restore the Prisma client
  (`feedback_prisma_generate_branch_switch`), costing several minutes and risking leaving
  the working `node_modules` in a state that breaks the other local checks. CI runs
  `npm ci` on every job with the `.nvmrc`-pinned Node, which is cheaper and closer to the
  environment that matters at merge — though not a reproducibility guarantee, since CI
  does not pin npm itself (VC2). Deferring costs nothing CI does not recover before merge.
- **SC4** — other dev-tree advisories `npm audit` does not currently report are out of
  scope; this PR closes the reported finding and its uncovered bands, not a general
  dependency refresh.
- **SC5** — **no CI gate for the full-scope audit is added.** The three `Audit: *` jobs
  run `--omit=dev`, so a dev-tree advisory is invisible to this repo's own gates — which
  is why this one was found only by an ad hoc run.
  **Anti-Deferral cost-justification**: adding a fourth audit step changes the repo's
  gate policy and can turn unrelated in-flight PRs red on dev-tree advisories that have
  nothing to do with them — a maintainer policy decision, not a side effect of a
  dependency bump. Cost of deferring: a future dev-only high advisory stays undetected by
  CI until someone runs `npm audit` by hand; GitHub's native Dependabot alerting provides
  asynchronous, non-blocking detection meanwhile. Owner: surfaced to the maintainer as a
  recommended follow-up PR.
- **SC7** — the `js-yaml` band `< 3.0.0` gets **no** override key. **Five**
  non-withdrawn advisories reach below 3.0.0 (all with unbounded lower ends):
  `GHSA-xxvw-45rp-3mj2` (**critical**, `<2.0.5`), `GHSA-8j8c-7jfh-h6hx` (**high**, code
  injection, `<3.13.1`), and `GHSA-2pr6-76vf-7546` / `GHSA-mh29-5h37-fv8m` /
  `GHSA-h67p-54hq-rp68` (medium). An earlier revision undercounted this as
  "critical + two medium"; the high-severity code-injection advisory was omitted.
  **Anti-Deferral cost-justification**: there is no in-major fix — the only release
  clean of *all five* is 3.15.0, so covering the band means force-upgrading a
  0.x/1.x/2.x consumer across **up to three majors** depending on where it starts,
  exactly the break `dependency-cve-response.md` Step 2
  warns about, and with a far larger API delta than the `brace-expansion` 4→5 case
  (C1/R-d), where the jump was one major and the failure mode a single missing export.
  Cost of deferring: a hypothetical future dependency pinning `js-yaml@^2` resolves
  unprotected. Assessed as negligible — nothing in this repo's three lockfiles resolves
  below 4.3.0, and `js-yaml` 2.x predates 2018. Owner: revisit only if a `< 3.0.0` copy
  ever appears in the tree, at which point `npm audit` **will** report it (unlike the
  Class B/C gaps, this band would be occupied and therefore visible).
- **SC6** — `corepack enable` is not added to CI. Pre-existing and repo-wide; every job
  is affected equally and none is affected *by this change*.
  **Anti-Deferral cost-justification**: pinning the package manager changes how every job
  installs, which is a much larger blast radius than this PR. Cost of deferring: CI's npm
  can drift with the runner image; immaterial for an override-floor bump, material for a
  future lockfile-sensitive change — recorded here so that change knows the pin is
  Node-only. Owner: unassigned.

### Risks

- **R-a (VC2)** — local npm may rewrite lockfile entries beyond the intended packages.
  Mitigated by C2/I5: inspect the diff and revert unrelated hunks; if the churn cannot be
  bounded, fall back to a surgical lockfile edit of the affected entries only.
- **R-b** — a caret floor lets npm choose 1.1.18 / 2.1.4 / 5.0.9 rather than the exact
  advisory-clearing patch. Acceptable (all outside every band) and consistent with the
  existing style (N2); `npm audit signatures` runs on whatever npm resolves. The resolved
  versions must be recorded, not assumed.
- **R-c** — the advisory bands must be read from `gh api /advisories/<ghsa-id>` at
  implementation time, not copied from this plan and **not** from `npm audit`. An advisory
  can be widened after the plan is written. Reading it from `npm audit` is what caused the
  Class B gap in revision 1.
- **R-d** — the widened `>=3.0.0 <5.0.8` key force-upgrades a hypothetical future 3.x/4.x
  consumer across a breaking API change (5.x dropped the default export). Accepted: there
  is no safe 3.x/4.x to force to, nothing resolves there today, and the failure would be a
  loud link-time error rather than a silent wrong result.

## User operation scenarios

- **S1 — a developer runs `npm ci` after pulling this change.** Expected: install
  succeeds, `npx eslint .` and `npx vitest run` behave as before, `npm audit` prints
  `found 0 vulnerabilities`.
- **S2 — CI runs on the PR.** Expected: the three `Audit: *` jobs stay green (they run
  `--omit=dev`, already green — F2 guards against this turning red), `npm audit signatures`
  stays green, `license-audit` stays green, Trivy stays green (C4), build/test/lint
  unaffected.
- **S3 — Dependabot opens a later dev-dependency PR.** Expected: it no longer inherits a
  red full-scope audit from main. This does not change the CI gate behavior described in
  `project_dependabot_prod_audit_gate_blocks_dev_pr`, since that gate is `--omit=dev`.
- **S4 — a third advisory hits `brace-expansion`.** Expected: the responder opens
  `dependency-cve-response.md`, and after C5 its Step 4 tells them to raise the floor in
  place for an overlapping band rather than adding a dead block, and its Step 3 no longer
  claims `pre-pr` audited anything. The structural gap (no full-scope CI gate) remains
  open under SC5.
- **S5 — a future transitive dep requests `brace-expansion@^4`.** Expected: the widened
  key forces 5.0.9. If that dep uses the 4.x default export, the failure is a loud ESM
  link error at build time, not a silent vulnerable resolution (R-d).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `overrides` covers every advisory band, keys pairwise disjoint | locked |
| C2 | `package-lock.json` re-resolved, churn bounded to the member set | locked |
| C3 | Both audit scopes clean; production scope proven not regressed | locked |
| C4 | No Trivy/Dockerfile second-surface change required (re-derived from the full band list) | locked |
| C5 | `dependency-cve-response.md` corrected (Step 3 false claim, Step 4 overlap hazard + three moves) | locked |
| C6 | `js-yaml` override covers every band of its current advisories (Class C, closes the defect class) | locked |
