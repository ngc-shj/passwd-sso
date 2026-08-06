# Plan: stale-override-floors

Raise every `overrides` pin whose floor still permits a version inside a live
GitHub advisory band, and add the detection mechanism that makes the next
occurrence red instead of invisible.

**Revision 4 — final for Phase 1.** Three review rounds produced 12, 33 and 28
findings. The design settled after round 1; rounds 2 and 3 were overwhelmingly
against *this document's own mechanism specifications*, and round 3's crop was
seeded by round 2's fixes. Revision 3 removed the test tables and then added a
nine-export shape block, a forbidden-pattern regex list and a twelve-row semantic
table — new mechanism surface, which produced the next crop on schedule.

Errors round 3 caught in revision 3, each of them mine:

| Error | How it was caught |
|---|---|
| I-7.3 cited `release.yml:315` as "a legitimate pipe on a verifier line" | It is a **redirect** (`… --json --include-attestations > "$AUDIT_JSON"`). `grep -rn "audit signatures.*\|" .github/workflows/` returns nothing — no verifier line in this repo has a pipe. I took the citation from a round-2 finding without re-executing it. |
| C3 forbade `process.env` outside the token read | The same document requires a `GITHUB_API_URL`/proxy refusal, which must read `process.env`. The grep-checkable half would have won and the ambient path stayed open. |
| S11 called the endpoint "a parameter reachable only by direct import"; AC-3.3 drives the shell "as a process" | A spawned process cannot be handed a function parameter. |
| "18 distinct package names" | An independent walk yields **17** pin names. 18 needs the scope-opener parent, which S1 says is not judged — a rule I never stated. |
| C5 attributed all five forbidden forms to C7 | `uses:@v[0-9]` has no rule in `check-workflow-supply-chain.mjs`; it belongs to `check-actions-sha-pinned.sh`. |

And measured rather than argued: a reviewer copied
`check-workflow-supply-chain.mjs` to a scratchpad, widened `verifierLineRe`, added
a naive pipe alternative to `maskRe`, and ran it over the real workflows —
`release.yml orig=0 widened=2` (`:210`, `:268`). The obvious implementation of the
rule I wrote false-reds the release workflow.

**So revision 4 stops writing mechanism.** It fixes the factual errors and the
self-contradictions, keeps the design decisions and the obligations, and **deletes
the specifications that have been wrong twice and cannot be settled without
running the code** — C7's indirection rule, C3's forbidden-pattern regexes, the
export-by-export shape block, the argv spelling. What replaces them is the
property each was trying to encode. Phase 2 writes the code and *runs* it; Phase 3
reviews the result with the same three experts. Verification is deferred, not
dropped, and the findings that survive this exit are carried forward explicitly at
the end of this document.

Revision 4 is **not** shorter — 831 lines against revision 3's ~760. Revision 3 made
that claim about itself and it was true; making it again here would be the R29 defect
this document keeps catching in itself. The specification blocks did shrink (the export
list, the regex list, C7's indirection rule and the argv spelling are gone). The growth
is the errata table above, the Carried-Forward section below, and the honest statements
of what the controls do not cover — S12's loader residual, SC-G, SC-H. That is prose
that stops a wrong edit, not prose a compiler would have caught, which is the only kind
this document should still be adding.

## Project context

- **Type**: web app (Next.js 16: root app + `cli/` + `extension/`), plus a CI gate
  suite under `scripts/checks/`.
- **Test infrastructure**: unit (`vitest`) + integration (real Postgres) + E2E
  (Playwright) + CI/CD (GitHub Actions), plus a gate self-test convention enforced
  by `scripts/checks/check-gate-selftest-coverage.sh`.
- **Verification environment constraints**:
  - **VE-1 — `scripts/pre-pr.sh` does no network I/O.** No document states this as
    a contract; it is an observed property. C5 preserves it: the local step probes
    for a token *without* a request and prints a skip line otherwise. `pre-pr`
    green does not imply this gate is green.
  - **VE-2 — the advisory database is a moving external input.** The verdict at
    time T is not reproducible at T+n. Self-tests inject advisory data; a test
    hitting the live API is rejected. One recorded response is committed as an
    RT1 anchor (O-9).
  - **VE-3 — rate limits, and they bite.** Unauthenticated `api.github.com` allows
    60 req/h per IP; the gate makes one request per distinct queried package name,
    **18 today**. A round-2 reviewer exhausted the budget mid-review and the next
    call returned a non-array body. **A token is a precondition for every
    acceptance step that reaches the API** — AC-3.2 alone is 8 × 18 = 144
    requests — and such a step refuses up front rather than half-completing.
    **Two steps are deliberately exempt because they require the opposite
    environment**: AC-5.4's token-absent half, and AC-3.3, which reaches a local
    fixture server and no API. The precondition is evaluated per step, not per
    suite.
  - **VE-4 — macOS verification host `mrx33`** (Darwin 25.5.0, bash 3.2.57,
    uid 501). No bash 4+ constructs; no hardcoded uid. `timeout(1)` is absent on
    stock macOS: a bounded run resolves `command -v timeout || command -v gtimeout`
    and refuses loudly if neither exists.
  - **VE-5 — Docker/Trivy is NOT reachable by this change.** The runner image is a
    Next.js standalone build, so the app's `node_modules` never ships; every Trivy
    HIGH here is an npm-bundled package that only the Dockerfile patch layer moves
    (`project_cve_gate_two_surfaces`, corrected by measurement). Verifying this
    change by watching Trivy is misleading — it would go green regardless.

## Objective

1. **Close the current class member by member**: every `overrides` pin whose range
   intersects a live advisory band is raised to at or above the maximum
   `first_patched_version` over its intersecting bands.
2. **Change the mechanism.** This class has escaped three times. A remembered rule
   that has failed three times is not a control.

### Why "raise the floor" and not "the lockfile already resolves clean"

Five of the six members currently resolve to a non-vulnerable version. Their defect
is not a shipped vulnerability — it is that **the override no longer guarantees what
it was written to guarantee**. `"postcss": ">=8.5.12"` was written to make 8.5.12 the
floor for `GHSA-6g55-p6wh-862q`. It still permits 8.5.12–8.5.22
(`GHSA-fxqj-rqcc-2cmp`) and 8.5.12–8.5.17 (the HIGH `GHSA-r28c-9q8g-f849`). Any
future resolution landing in that window is unguarded, and `npm audit` reports
nothing because it only reports bands intersecting versions **currently** in the
lockfile (`docs/security/dependency-cve-response.md`, Step 4).

## Requirements

- **F1** Every member has its pin raised so the pin range no longer intersects any
  live advisory band for that package.
- **F2** Lockfiles regenerated in all three trees. Only `node_modules/hono` moves.
- **F3** A gate reports, per manifest and per override entry, any pin whose range
  intersects a live advisory band, and exits non-zero.
- **F4** The gate runs in CI on a wall-clock schedule AND on every pull request.
- **F5** `docs/security/dependency-cve-response.md` names the gate and the traps.
- **N1** No unconditional network in `scripts/pre-pr.sh` (VE-1).
- **N2** No network in the gate's self-test (VE-2).
- **N3** No reimplementation of range comparison. `semver.intersects` — the library
  npm resolves with — is the only predicate.
- **N4** Reuse the manifest-discovery and overrides-walking primitives in
  `scripts/checks/check-override-key-disjointness.mjs` (R1). **Reuse is not
  inheritance of its silent-skip behaviour**: that file's `ENOENT → continue` on an
  unreadable manifest, and its fallback when `git ls-files` does not answer, are
  correct for its own predicate and are refusals for this one (N5).
- **N5** Fail closed. Every outcome that is neither "checked and clean" nor "checked
  and stale" is a violation with its own named token, never a pass.

## Member-set derivation (R42)

The class-defining primitive:

> an `overrides` **pin** whose range intersects the `vulnerable_version_range` of
> any live (non-withdrawn) GitHub advisory **for that same package**.

Census executed at `8d688731c`, reproduced independently three times (twice in
round 3, by walks sharing no code with `collectScopes`). Structural rows come from
a manifest walk; advisory rows from one query per distinct queried name. The
commands are in the review artifact; `--report` reproduces the structural rows and
the per-package advisory counts, and the aggregate advisory figures are a **census,
not a gate output** — revision 3 cited one command for all of them, which four of
the rows do not come from.

| quantity | value |
|---|---|
| walker entries | **25** |
| of which version pins | **24** (19 root + 2 cli + 3 extension) |
| of which scope openers (object-valued keys) | **1** (`extension` → `@crxjs/vite-plugin`) |
| `"."` self-pin keys present today | **0** |
| unparseable-selector keys present today | **0** |
| distinct package names carried by pins | **17** |
| distinct names **queried** (17 pin names + 1 scope-opener parent, per S1) | **18** |
| advisories returned across the 18 | **158** |
| withdrawn, skipped per S4 | **6** |
| live same-package vulnerability entries | **223** |
| of those with `first_patched_version: null` | **0** |
| live `type: unreviewed` advisories | **0** |
| advisories returned for `affects=X` carrying no exact-npm-`X` band (S12 layer 1) | **0** |

### Members — 6 of 24 pins

| # | manifest | key | pin | lock resolves | required floor | intersecting live advisories |
|---|---|---|---|---|---|---|
| M1 | `package.json` | `hono` | `^4.12.27` | **4.12.31** | **4.12.34** | `GHSA-8j4g-w8fx-2239` [medium] `< 4.12.34` → 4.12.34 |
| M2 | `package.json` | `@hono/node-server` | `^2.0.5` | 2.0.11 | **2.0.10** | `GHSA-9mqv-5hh9-4cgg` [medium] `>= 2.0.0, <= 2.0.9` → 2.0.10 |
| M3 | `package.json` | `postcss` | `>=8.5.12` | 8.5.25 | **8.5.23** | `GHSA-fxqj-rqcc-2cmp` [medium] `<= 8.5.22` → 8.5.23; `GHSA-r28c-9q8g-f849` [**high**] `<= 8.5.17` → 8.5.18 |
| M4 | `package.json` | `brace-expansion@1` | `^1.1.17` | 1.1.18 | **1.1.18** | `GHSA-rgw5-rvv9-x895` [high] `< 1.1.18` → 1.1.18 |
| M5 | `package.json` | `brace-expansion@2` | `^2.1.3` | 2.1.4 | **2.1.4** | `GHSA-rgw5-rvv9-x895` [high] `>= 2.0.0, < 2.1.4` → 2.1.4 |
| M6 | `cli/package.json` | `postcss` | `>=8.5.10` | 8.5.23 | **8.5.23** | the two above **+** `GHSA-6g55-p6wh-862q` [**high**] `<= 8.5.11` → 8.5.12 |

The required floor is `max(first_patched_version)` over the intersecting set — which
is why M3 and M6 both land on 8.5.23 despite carrying different band sets. They are
the only multi-band members, and they are why that rule exists rather than "the floor
of the one advisory". `first_patched_version` is a bare string (`"4.18.0"`, measured);
a round-2 claim that it is an object was withdrawn on measurement in round 3.

**Severity vocabulary**: the API returns `low | medium | high | critical`. `moderate`
is `npm audit`'s word and never appears in an API response.

### Non-members worth naming

- `extension/package.json` → `"rollup": "$rollup"` → resolves against the same
  manifest's `devDependencies.rollup` = `^4.62.3`. Clean.
- `extension/package.json` → `@crxjs/vite-plugin > rollup: "^2.80.0"` (nested scope,
  governs `node_modules/@crxjs/vite-plugin/node_modules/rollup` → 2.80.0). Clean **by
  exactly one patch version**: `GHSA-mw96-cpmx-2vgc` [high] `< 2.80.0`.
- `extension/package.json` → `@crxjs/vite-plugin` is a **scope opener**, not a pin
  (S1). 0 published advisories today — which is why it is also the witness that
  layer-1 integrity is vacuously true on an empty list.
- `brace-expansion@>=3.0.0 <5.0.9` → `^5.0.9`. Current.
  `scripts/checks/check-dockerfile-prisma-pin.sh:68` reads **only** this key
  (`/^brace-expansion@>=3/`) when asserting `BE_VER=5.0.9`, so M4/M5 do not touch
  that coupling.
- `undici`, `qs`, `lodash`, `cross-spawn`, `@babel/core`, `nodemailer`, `effect`,
  `find-my-way`, `js-yaml` ×3, `esbuild` ×2, `sharp`, `body-parser` — all current.

### Why CI is green today

All three audit jobs run `npm audit --omit=dev --audit-level=high`
(`.github/workflows/ci.yml:687`, `:716`, `:743`). M1 arrives through `shadcn` (a
devDependency) → `@modelcontextprotocol/sdk` → `hono`, and is `medium`. `--omit=dev`
drops it and `--audit-level=high` would drop it anyway. No CI job runs a full-scope
`npm audit`. Full-scope, by hand: `{"moderate":1,"high":0,"critical":0}` — the single
finding is M1.

**Reachability (playbook Step 0)**: a ReDoS in hono's CORS middleware, reached only by
code that mounts it. This repo does not; `hono` is present solely because `shadcn`
bundles an MCP server. Runtime exposure is effectively nil — recorded so a later reader
does not re-litigate it. The fix is still made, because an override that no longer
bounds what it claims to bound is the defect.

## Semantic decisions

These are the questions no toolchain asks and every implementer must answer. Left
open, the cheapest answer to each is a silent skip.

| # | Case | Decision |
|---|---|---|
| S1 | Override key whose value is an object | **Scope opener, not a pin.** Excluded from pin judgement *because its nested scope yielded at least one judged entry* — counting both nested pins and nested `"."` self-pins — never because of its `typeof`. A scope that yielded nothing is a refusal. A value that is an **array or any non-plain object** is a refusal and is **not recursed into**, so one key never yields two rows. The scope opener's **parent name IS queried** even though it is not judged, so a `"."` self-pin appearing under it later is decided from data already fetched and layer-3 visibility covers it: that is why the queried set is 17 + 1 = 18. |
| S2 | The `"."` key inside a nested scope | A **self-pin** for the scope's parent package, judged against that package's bands. **The parent is carried on the scope record, not parsed back out of the display path.** `{"pkg@1": {".": "^1.0.0"}}` must be judged against `pkg`, not `pkg@1` — the API answers `200 []` for the latter, so getting this wrong is a silent green (R51). A `"."` at depth 0, and a `"."` whose value is an object, are refusals. |
| S3 | An advisory carrying bands for other packages | Filter `vulnerabilities[]` to `package.ecosystem === "npm" && package.name === pkg`, by **exact equality**. An entry lacking `package.name` is a refusal. Prefix matching is wrong in both directions: `hono`/`@hono/node-server` share a prefix and are different subjects, and `lodash`/`lodash-es` is the pair that makes a prefix test discriminating in a self-test. |
| S4 | A **withdrawn** advisory | Not a live band. Excluded, and **counted and named** in `--report` so the exclusion is visible. The **PR run is authoritative for merge**; the weekly run is detection. A disagreement between them means the advisory changed in between — information, not a conflict. |
| S5 | `first_patched_version: null` on a live advisory | A violation naming the band, with **no floor** in the message and a token saying so. Documented remedies: bound the pin below the band, or drop the dependency. |
| S6 | An unbounded `>=X` pin intersecting a band above its floor | A violation naming **both** remedies — raise the floor above the band, or bound the pin below it. Measured: `intersects(">=8.5.23", ">= 9.0.0 < 9.1.0")` is true; `intersects(">=8.5.23 <9", …)` and `intersects(">=9.1.0", …)` are both false. There is no wedge. |
| S7 | A live `type: unreviewed` advisory | In scope, tagged in the violation line. Dropping them would be fail-open on real npm CVEs. |
| S8 | A truncated advisory list | A violation. The gate does not paginate. The predicate is a `rel="next"` link relation, **not** a `"next"` substring — a header carrying only `rel="prev"`/`rel="last"` is not truncation. A full page with no link relation at all is also truncation: absence at the ceiling is the ambiguous case. Measured headroom: the largest list today is `hono` at 44 of 100. |
| S9 | A key whose **selector** `semver` cannot parse | The walker routes these to a third bucket, never to the judged one. They carry their pin and are judged as refusals. Today the disjointness gate reds on such a key first, so this is defence in depth — but completeness that depends on another gate's rule is a claim stronger than the mechanism. |
| S10 | The outcome partition | Five, not three: **clean**, **stale**, **refused** (a structural problem with the manifest — an unreadable manifest, a discovery fallback, a bad `$ref`, a non-range pin **including a string `semver.validRange` rejects**, an empty scope, a top-level `"."`), **undecidable** (the advisory query failed, was truncated, or returned a shape the boundary check rejected), and **not-judged** (a scope opener, whose children carry the verdict). Exit non-zero on `stale`, `refused` or `undecidable`; `not-judged` rows appear in `--report` and do not affect the exit. A run producing several prints all of them; none is collapsed into another. |
| S11 | The control's ambient-input boundary | The effective advisory origin comes from exactly two places: a **compiled-in default** pinned to `https://api.github.com`, and an **explicit command-line argument**. The pin's subject is *how the origin was supplied*, not its spelling: an origin arriving through ambient state is refused unconditionally; an explicitly-argued origin is accepted; the default is pinned. The ambient set is `GITHUB_API_URL`, `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`, `NODE_EXTRA_CA_CERTS`, and `NODE_OPTIONS` (which can carry `--import`/`--require`). Reading `process.env` is *required* to implement that refusal — revision 3 forbade it wholesale and would have deleted the refusal to satisfy the grep. |
| S12 | What a positive control can and cannot prove | Needs more than a row — below. |

### S12 — the limits of the positive control (R49)

Measured:

```bash
gh api "/advisories?ecosystem=npm&affects=this-package-does-not-exist-zzz9&per_page=100"  # -> []
gh api "/advisories?ecosystem=npm&affects=%00bad&per_page=100"                            # -> []
```

The API answers `200 []` for a nonexistent **and** a malformed `affects`. A genuinely
advisory-free package must still pass (`@crxjs/vite-plugin`), so `[]` is
unconditionally clean for the rest. A one-package canary proves the **channel is
live**, not that each package was checked. Three layers:

1. **Per-package integrity, needing no baseline**: every advisory returned for
   `affects=X` must carry ≥1 `ecosystem === "npm" && package.name === X` band.
   Measured today: **0 violations across all 18** — free headroom, no suppression
   list, no threshold (R53). Vacuously true on an empty list, so `@crxjs/vite-plugin`
   still passes. Failure direction to name in the message: a *foreign-ecosystem*
   band on an otherwise-correct advisory is the false-red shape here.
2. **A canary asserted structurally, not byte-exactly**: the advisory is present,
   not withdrawn, and carries a `brace-expansion` band whose normalized range contains
   a known-vulnerable version. Revision 3 also asserted `severity === "high"`, which
   re-imports the byte-exactness cost it was avoiding — a severity re-classification
   is not a channel failure. Two distinct refusals so the operator knows which
   happened: *channel dead* (advisory absent) vs *constant stale* (present, asserted
   property no longer holds — the constant needs review, not the tree).
3. **Visibility over the residual**: `--report` prints the per-package advisory count
   for all 18. A per-package empty stays a pass but stops being invisible.

**What this does not close, stated plainly**: an adversary or misconfiguration able to
shape responses *per package* serves the real canary payload and empties the rest.
TLS to a public CA and the ambient-origin refusal are what stand between the gate and
that adversary — and **neither stops a Node loader** (`NODE_OPTIONS=--import …`),
which is why the loader vars are in S11's ambient set rather than being treated as
covered by the host pin. Anyone reading this control as stronger than that is reading
it wrong.

## Technical approach

### Which of the playbook's three moves applies

`docs/security/dependency-cve-response.md` Step 4 offers three. All six members:
**move 1 — raise an existing key's floor in place**. M1/M2/M3/M6 use the unbounded form
(selector `*`), where adding a ranged key beside it is forbidden by the playbook and
widening is a no-op. M4/M5 are bare-major selectors whose new band sits *inside* the
selector. No new keys, so `check-override-key-disjointness.mjs` has no new pairs — re-run
as an acceptance criterion, not assumed.

### The gate's shape — properties, not an export list

Revision 3 specified nine exports and their signatures, and round 3 found the list
internally inconsistent in three places. The properties are what matter; Phase 2 names
the functions and the compiler holds the shapes.

- **P-1** Every behavior this plan declares is reachable from a **pure, exported,
  network-free function**: the manifest walk, `$ref` resolution, band normalization,
  the API→internal transform, the S3 and S4 filters, the truncation predicate, the
  response-shape check, the judgement, and both output formats. Any declared behavior
  that ends up reachable only in the network shell is a defect in the shape, to be
  fixed by moving it — not a gap to be covered by a test.
- **P-2** The **async boundary is in the entry point only**. The walk yields the
  package list; the entry point fetches into a keyed map; the synchronous core judges.
  A package in the walk but absent from the map, or present as a failure, is
  `undecidable` — never `clean`.
- **P-3** The **test seam is an explicit argument**, never ambient state (S11). The
  entry point accepts manifest paths and an origin; the self-test supplies them
  directly and the process-level test supplies them on the command line.
- **P-4** The command line distinguishes **flags from manifest paths**, and every way
  it can go wrong is a named refusal rather than a skip: an unrecognized flag, a path
  that cannot be read, a discovery fallback, and a walk that yielded zero rows of any
  kind. Revision 3 cited `check-override-key-disjointness.mjs:260` as the precedent
  without stating this; that form treats every argument as a path and swallows
  `ENOENT`, so `--report` would become a path, be skipped, and a mistyped scratchpad
  path would report clean.
- **P-5** Report mode changes **what is printed, never the verdict**. The exit status
  is identical under every flag.

### The trap that cost the first derivation

GitHub returns comma-separated bands (`">= 7.0.0, < 7.28.0"`); `semver` throws on them.
The first derivation reported **21 of 21 entries as members** — an instrument artifact.

The regression case must sit where the mutation is observable: with a comma band,
deleting the normalizer turns an intersect-*miss* into a *throw*, and a throw is also a
violation, so a case expecting a violation stays green under the mutation. The case must
expect no violation. Revision 2 wrote that sentence and put the case in the Deny column
of its own table; the tables are gone, and the rule is O-6.

### Network-shell hardening

- **Origin**: per S11 — compiled default, explicit argument, ambient refused.
- **Shape validation at the boundary**, fail-closed, as a pure export (P-1).
- **Output sanitization**: GitHub Actions interprets `::`-prefixed step output as
  workflow commands. Strip control characters, refuse a leading `::`, cap length. A
  legitimate band and a summary containing `<`, `>` and quotes must survive intact —
  that is the operator's diagnostic.
- **Caches are keyed maps, never plain objects**: `JSON.parse` makes `__proto__` an own
  property and `Object.entries` yields it, so a plain-object cache keyed by a name from
  `overrides` gives `cache["constructor"]` a truthy non-array hit.
- **Timeout and retry**: a per-request timeout; bounded retries on transport errors and
  5xx **only**. 401/403/429 are not retried — retrying a rate limit deepens it, and a
  rejected token must be distinguishable from an exhausted budget.

Measured cost: 18 sequential requests ≈ 7–9 s, ~840 KB. Linear; R45 does not apply.

### CI and local wiring

| Trigger | Where | Why |
|---|---|---|
| Weekly + `workflow_dispatch` | new `.github/workflows/override-floor-staleness.yml` | The input moves without the repo moving (VE-2). Mirrors `dependency-signatures.yml`. |
| Every pull request | new job in `.github/workflows/ci.yml` | A newly-authored stale floor must not merge on the strength of "the sweep runs Monday". |
| Local, probe-gated | `scripts/pre-pr.sh` | Feedback before CI, without breaking VE-1. |

## Contracts

### C1 — Raise the six stale override floors

| key | from | to |
|---|---|---|
| `package.json` → `hono` | `^4.12.27` | `^4.12.34` |
| `package.json` → `@hono/node-server` | `^2.0.5` | `^2.0.10` |
| `package.json` → `postcss` | `>=8.5.12` | `>=8.5.23` |
| `package.json` → `brace-expansion@1` | `^1.1.17` | `^1.1.18` |
| `package.json` → `brace-expansion@2` | `^2.1.3` | `^2.1.4` |
| `cli/package.json` → `postcss` | `>=8.5.10` | `>=8.5.23` |

**Control class**: not a control — a data correction.

**Invariants**:
- **I-1.1** (enforced by C3) No override pin intersects a live advisory band for its
  own package.
- **I-1.2** (enforced by npm) No new override key, so key-disjointness is unchanged by
  construction.
- **I-1.3** `Dockerfile` `BE_VER` stays ≥ the `brace-expansion@>=3…` floor — asserted
  (AC-1.4), not assumed.
- **I-1.4** The five open-ended pins are left **unbounded** (S6, SC-F).

**Forbidden patterns** — literal-reintroduction tripwires only; the general predicate is
C3's, via `semver.intersects`. The exact pre-fix literals for `hono` and for both
`postcss` pins, and a *ranged* `hono@…` key beside the whole-package key (the playbook
forbids mixing the two forms for one package). Phase 2 writes the greps and, per O-12,
runs each against the corrected file to prove it does not match its own fix.

**Acceptance criteria**:
- **AC-1.1** the gate exits 0.
- **AC-1.2** full-scope `npm audit` reports 0 vulnerabilities in all three trees.
- **AC-1.3** `npm install --package-lock-only` run at the root, in `cli/`, and in
  `extension/`. npm does not record `overrides` in the lockfile, so M2–M6 are expected
  to produce **no** lockfile diff; the only expected movement is `node_modules/hono`. A
  wider diff is explained in the PR body; an **absent** root diff means the hono bump
  did not take and is a stop condition.
- **AC-1.4** `check-dockerfile-prisma-pin.sh` exits 0.
- **AC-1.5** `check-override-key-disjointness.mjs` exits 0.

### C2 — Extend the shared overrides-walking primitives

**Subject**: `scripts/checks/check-override-key-disjointness.mjs`. The walker must
additionally carry, for every entry it yields, **the pin value** and **the identity of
the package the entry pins** — including for `"."` self-pins, whose subject is the
enclosing scope's parent and must be carried on the record rather than recoverable only
from a display string (S2, I-2.4).

Two of the changes S1 requires are **not** purely additive, and revision 3's I-2.1
claimed otherwise: refusing to recurse into an array, and treating a `"."`-only scope as
having yielded children, both change existing behaviour. AC-2.1 cannot test them,
because they are behaviours the 25 existing cases never exercised — AC-2.2 must.

**Control class**: not a control — a shared primitive whose correctness is load-bearing
for the C3 control.

**Invariants**:
- **I-2.1** No existing consumer's behavior changes on any input the 25 existing cases
  cover.
- **I-2.2** Unparseable **selectors** stay in their own bucket, not the judged one; they
  now carry their pin so C3 can judge them (S9) rather than inherit a silent pass.
- **I-2.3** `"."` keys do not enter the judged bucket. The disjointness gate's exclusion
  of `"."` from its own overlap arithmetic is correct for *its* predicate and is pinned
  by its own test at `check-override-key-disjointness.test.mjs:116`; it must not be
  "fixed" while satisfying C3's.
- **I-2.4** A package's identity for C3 comes from the carried name, never from splitting
  a display string (R51).

**Forbidden pattern**: a second copy of the walker in the new gate — the R1 defect this
contract prevents.

**Consumer-flow walkthrough**: `findOverlappingKeys` and `findAmbiguousEdges` read
`{key, range}` and none of the new fields. The new gate reads the **name and the pin**
for every entry in all three buckets, plus the depth needed to separate a top-level
`"."` from a nested one — the selector is not what is judged. The 25 existing self-test
cases must stay green **unedited**.

**Acceptance criteria**:
- **AC-2.1** The 25 existing cases pass with no edit to their bodies.
- **AC-2.2** *New* cases in the same file assert the new shape and the two
  behaviour changes: the pin value on a plain key, a nested key and a scope-opening key;
  a `"."` landing in its own bucket and not the judged one; the carried parent name on a
  scope whose key carries a selector; an unparseable-selector key carrying its pin; an
  array value refusing rather than recursing; and a `"."`-only scope counting as having
  yielded children. Each assertion names the scope record it inspects — the walk is
  post-order, so the first element is the first *nested* scope whenever one exists, and
  an assertion against it passes by accident.

### C3 — The staleness gate

**Control class**: **fail-closed verification gate**. Bypassable by editing the gate, as
every `scripts/checks/*` gate is, but it cannot pass without deciding: every outcome in
N5 denies. **Not** an enforceable boundary — nothing stops an operator committing a stale
floor and merging without CI. Its positive control proves the channel is live, not that
each package was checked (S12).

**Adjudication authority**: `semver.intersects` for range containment (N3); the API's
`vulnerable_version_range` for the bands, normalized only for separator syntax.

**Invariants**:
- **I-3.1** Every entry the walk yields lands in exactly one member of S10's partition.
  No silent skip.
- **I-3.2** Band normalization precedes every comparison; a throw out of the comparison
  is a violation, never a swallowed error.
- **I-3.3** The pure exports perform no I/O (P-1, P-2).
- **I-3.4** A package in the walk but absent from the fetch map, or present as a
  failure, is `undecidable`.
- **I-3.5** Exit non-zero when any row is `stale`, `refused` or `undecidable` —
  identical under every flag (P-5). Violations and refusals are both printed; neither is
  collapsed into the other.
- **I-3.6** The member set at HEAD after C1 is empty — measured, not asserted.
- **I-3.7** No ambient input influences the origin, the canary or the verdict (S11).

**Forbidden patterns**: revision 3 wrote five regexes and round 3 found one of them
self-contradictory. What they were encoding, kept as properties for Phase 2 to grep and
red-prove per O-12: no swallowed comparison error; no I/O in the pure exports; no
severity filter (a filter would re-open the medium band that hid M1 from CI); no prefix
matching where S3 requires exact equality; and no ambient read that influences the
origin, canary or verdict — as distinct from the ambient reads S11 *requires* in order
to refuse.

**Acceptance criteria**:
- **AC-3.0** Report mode against **scratchpad copies** of the pre-C1 manifests
  reproduces exactly M1–M6 with the floors in the member table. No tracked file is
  modified — `git status --porcelain` is empty afterwards, and that is asserted, so an
  aborted run cannot silently revert C1. This retires the scratchpad derivation rather
  than leaving it as an untested twin (RT9), and it has now been non-executable in two
  revisions for two different reasons — P-4 is what makes it executable.
- **AC-3.1** the gate exits 0 at the branch tip.
- **AC-3.2** Executed against scratchpad copies on the same terms, over **eight**
  shapes: the six members plus the nested `@crxjs/vite-plugin > rollup` and the `$ref`
  target `rollup`, each reverted to a version inside a known band. Each exits non-zero
  and names the package **and** its GHSA id. A gate red-proven only on top-level pins is
  proven only on top-level pins.
- **AC-3.3** The shell is driven **as a process** against a local fixture server,
  reached by the explicit origin argument (S11, P-3) — never by ambient state. Covers at
  minimum: a rate-limit response with zero retries; repeated 5xx exhausting retries; a
  5xx followed by success returning exit 0, with the success payload carrying the canary
  so that path is exercised rather than bypassed; a non-JSON body; a refused connection;
  and an ambient origin refused before any request. Exempt from VE-3's token
  precondition — it reaches no API.
- **AC-3.4** Report mode at the branch tip lists every entry the walk yields with 0 in
  the member set. The expected entry count is derived **by a second instrument** — a
  short manifest walk in the test sharing no code with the walker — because a count
  produced by the function under test and compared against itself cannot fail. A
  disagreement names both numbers and the symmetric difference. The R53 headroom
  measurement is the member count: 0, with no suppression list and no tuned threshold.

### C4 — Gate self-test

**Subject**: a sibling self-test, required by
`scripts/checks/check-gate-selftest-coverage.sh`.

Revisions 2 and 3 specified cases and mutation rows; round 2 found three columns
transposed and four rows pointing at cases that cannot observe them. Phase 2 authors the
cases from the obligations below and **runs** the mutation loop; Phase 3 reviews the
result. What survives here is what running the tests would not tell you.

- **O-1** Every deny case has a paired allow case **on the same fixture shape**,
  differing in one axis (RT10). This gate reds every PR repo-wide (I-5.3), so a false
  deny blocks all merges — over-blocking is the failure mode that gets gates switched
  off. An allow case that changes two axes proves nothing about either.
- **O-2** Assertions are on content — package name, GHSA id, and the required floor or
  the no-patch token — never on array length.
- **O-3** Every pure export is reached by at least one case (RT5), and the shell is
  reached as a process (AC-3.3). Any declared behavior not reachable from an export is a
  defect in the shape (P-1), not a gap in the cases.
- **O-4** Every semantic decision S1–S12 has at least one deny/allow pair, **and so does
  every hardening mechanism**: the ambient-origin refusal, shape validation, the `::`
  output refusal, the keyed cache, the request timeout, the retry policy, the canary's
  two distinct refusals, and the per-package integrity rule.
- **O-5** The multi-band `max(first_patched_version)` rule (M3/M6's shape) has a case
  where two bands disagree on the floor and the higher wins, plus a case where they tie
  and both ids must still be named.
- **O-6** The comma-band regression case sits on the **allow** side, where deleting the
  normalizer turns a pass into a throw-violation and reds it. On the deny side the
  mutation is unobservable.
- **O-7** Axis combinations are exercised, not only axes: `$ref` pin × comma band;
  nested scope × the boundary version; open-ended pin × an inclusive upper bound; `"."`
  self-pin × withdrawn advisory; unparseable selector × intersecting band.
- **O-8** Fixtures are in-memory or under a temporary directory with cleanup that runs
  on the failure path.
- **O-9** One committed **recorded** API response, untrimmed, driven through the
  transform and the shape check. Its role is the **RT1 anchor** — recorded evidence that
  the shape the core parses is a shape the API emitted — *not* upstream-rename detection,
  which a static file cannot do and which the live-response shape check is what actually
  provides. Revision 3 claimed the latter. `lodash` is the subject because one of its
  advisories carries four bands across four package names, so **one fixture answers two
  subjects** (`lodash` and `lodash-es`) and that pair is what makes a prefix-vs-exact
  mutation discriminating. Select the element by its GHSA id, not by index, and refuse
  if the lookup fails or the element has become withdrawn.
- **O-10** The mutation record names the observed failure **mode**, not merely that a
  case red. A red produced by a throw, or by a refusal token other than the clause under
  test, does not count as a proof — the comma-band trap is general, and every clause
  upstream of a throw-capable call has it. Prefer expression edits over deletions where a
  deletion would throw. The pair's **allow** half is re-run under the same mutation and
  recorded as still passing; a mutation that reds both halves is too coarse or is
  throwing.
- **O-11** No expected value is produced by the code under test, or read from a constant
  the code under test also reads. Identity-bearing constants — the canary's advisory id
  and its asserted properties — are spelled literally in the test. Otherwise editing the
  canary constant, which is the edit an operator is tempted to make when the gate reds,
  reds nothing.
- **O-12** Every forbidden pattern this plan names is run against the **corrected** file
  and shown not to match it, and against a file carrying the defect and shown to match.
  A pattern that matches its own fix is the failure this obligation exists to catch.

**Acceptance criteria**:
- **AC-4.1** the self-test passes.
- **AC-4.2** `check-gate-selftest-coverage.sh` exits 0 with `gate-selftest-debt.txt`
  byte-identical.
- **AC-4.3** A mutation loop is **run**, on a scratchpad copy, never the tracked file.
  One mutation per decision clause, applied singly, each **observed** to red at least one
  named case with the failure mode recorded per O-10. The pairing is output of the run,
  not a prediction in this document. A mutation producing a load failure rather than a
  test failure is not a proof. Bounded per VE-4. Clauses to cover, at minimum: band
  normalization; the comparison predicate; `$ref` resolution; nested-scope recursion;
  `"."` self-pins; the S3 name filter, deleted **and** relaxed to a prefix test (if one
  case reds under both, that case is not discriminating and needs splitting — O-9's
  `lodash`/`lodash-es` pair is the one that discriminates); the S4 withdrawn filter; the
  unparseable branches; the severity non-filter; S10's partition; report completeness;
  the exit code under report mode; the canary's two refusals **and its constant** (O-11);
  the per-package integrity rule; and the ambient-origin refusal.

### C5 — CI and local wiring

**Subject**: `.github/workflows/override-floor-staleness.yml` (new, weekly +
`workflow_dispatch`), a new job in `.github/workflows/ci.yml`, and a local step.

**Control class**: fail-closed verification gate (the scheduled half is detection).

**Job steps** (both CI jobs): a job timeout; SHA-pinned checkout with
`persist-credentials: false`; Node from `.nvmrc`; `npm ci --ignore-scripts` (the gate
imports `semver`, a root **devDependency**, so a bare checkout fails to resolve it; and
`--ignore-scripts` matches all four existing audit-family jobs); then the gate with
`GITHUB_TOKEN` in `env:`.

**Invariants**:
- **I-5.1** Actions SHA-pinned. **Enforced by `check-actions-sha-pinned.sh`** (AC-5.1) —
  not by C7, which has no rule for it. Revision 3 attributed this to C7.
- **I-5.2** `permissions: contents: read` only.
- **I-5.3** The PR job has **no** `paths-filter`. The gate is repo-wide across three
  manifests; filtering on root `package.json` would skip a `cli/`-only stale floor — M6's
  exact shape.
- **I-5.4** Both jobs set `GITHUB_TOKEN`. The API is public, so an unauthenticated run
  *works* — which is the hazard: it works until the 60/h IP budget is exhausted, then
  reds for a reason unrelated to the tree (observed during review).
- **I-5.5** A job timeout, matching `dependency-signatures.yml`. Without one a wedged
  request runs to the six-hour default.
- **I-5.6** The token probe is **shell logic in `scripts/pre-pr.sh`, outside the step** —
  the house pattern the Postgres-reachability probe already uses. No token → print a skip
  line and stay green; the line is printed, never silent. **The gate itself has no
  token-absent branch**: without a token it makes its requests, is rate-limited, and
  exits non-zero. Putting the probe inside the gate would give both CI jobs a
  skip-and-green branch that a missing secret produces — a fail-open ambient branch, the
  same shape S11 closes for the origin.
- **I-5.7** The step invokes an existing `scripts/checks/` file, so
  `check-gate-selftest-coverage.sh`'s file-keyed member set already covers it. It is
  **not** an inline `run_step "Static: …" bash -c`, which the meta-gate's second member
  set requires a debt entry for and AC-4.2 forbids; nor a `queue_step` wrapping an inline
  `bash -c`, which evades the anchor entirely — using the other spelling to dodge an
  anti-evasion control is the failure that control exists to catch. It also introduces
  **no new `scripts/checks/` file**, which would need its own sibling self-test that no
  contract owns.
- **I-5.8** The token-present-but-offline case reds, and that is intended: a red naming
  an unreachable API is the correct signal, and VE-1's offline property covers the
  token-absent path, which is the one a developer on a plane is in.

**Forbidden patterns** in the new workflow and job — four forms whose mechanism is C7:
`continue-on-error: true`, `|| true`, `set +e`, and a pipe from the gate invocation
whose status is not protected by `pipefail`. (`uses:@v[0-9]` is I-5.1's, enforced by a
different gate.) Revision 2 listed five and asserted "these patterns close the rest";
round 2 executed the check and found four unenforced; round 3 found the fifth was never
C7's to enforce.

**Acceptance criteria**:
- **AC-5.1** `check-actions-sha-pinned.sh` exits 0.
- **AC-5.2** `check-workflow-supply-chain.mjs` exits 0. (`actionlint` is absent from the
  repo — `rg -l actionlint scripts/ .github/` returns nothing. Revision 2 also claimed
  `pre-pr` had no workflow-lint step; that half was wrong, `scripts/pre-pr.sh:303` queues
  `Static: workflow-supply-chain`, which is this check.)
- **AC-5.3** The scheduled workflow is dispatched and the run is **observed** green — not
  inferred from well-formed YAML.
- **AC-5.4** `pre-pr` run twice: with a token and a scratchpad-copied stale manifest → red
  naming the package (invoked directly with that path, since the step itself passes no
  manifest argument and `git ls-files`-based discovery would not see a scratchpad copy);
  with both token vars unset → green **and** the skip line present in stdout. The
  token-absent half is exempt from VE-3's precondition (VE-3), and asserting the line
  rather than the exit code is deliberate: a silent skip is indistinguishable from a pass.

### C6 — Playbook update

**Subject**: `docs/security/dependency-cve-response.md`.

Step 4 gains the gate: path, what it decides, that it needs network and is therefore only
probe-gated locally (VE-1), and report mode with its exit semantics (P-5). A fourth row
in the incident table for the 2026-08 sweep: `npm audit` cannot decide floor staleness,
because it reports only bands intersecting currently-resolved versions. The comma-band
trap, including that its regression test must sit on the allow side. The severity
vocabulary. And S12's residual — what the positive control does not prove.

- **AC-6.1** `check-doc-paths.mjs` exits 0.
- **AC-6.2** Every command in the new prose is executed once and its output matches what
  the doc claims (R29). The member table is regenerated from report mode; the aggregate
  census figures are labelled as a census with the command that produced them, since
  report mode does not emit them.

### C7 — Give C5's prohibitions a mechanism

**Subject**: `scripts/checks/check-workflow-supply-chain.mjs`.

**Why a contract and not a note**: round 2 executed the real exported function with
`runsVerifier` forced true — i.e. simulating the obvious one-line widening —
and `continue-on-error` was caught while `|| true`, `| tee` and `set +e` were not.
The masked-verifier rule has a *second* precondition, a per-line regex that no `run:`
line invoking the new gate matches, and the mask regex itself contains neither `set +e`
nor a pipe alternative. No workflow sets `shell:` or `defaults.run.shell`, so GitHub's
default applies with **no `pipefail`** — a pipe really does discard the gate's status.

**This is a member set, not a predicate.** Widening one of three is how the correction
reproduces the defect it corrects, one level down.

**Changes**: widen both the workflow-level flag and the per-line predicate, and extend
the mask set with `set +e` and an unprotected pipe.

**What revision 3 got wrong here, corrected**:
- The deciding tie is **`release.yml:210`**, not `:315`. `:315` is
  `npm audit signatures --json --include-attestations > "$AUDIT_JSON"` — a redirect — and
  no verifier line in the repo has a pipe. `:210`'s block contains
  `echo "$VIEW" | node -e "…dist?.attestations…"` under `set -euo pipefail`, and it is
  matched by the `dist.attestations` half of the per-line predicate.
- The check joins `run: |` block scalars into **one logical line**, so a rule scoped to
  "the verifier line" is in fact scoped to the whole block, and `pipefail` anywhere in
  that joined line is the protection. Measured: a naive pipe alternative produces
  **two false violations on `release.yml`** (`:210`, `:268`). The block-scalar header
  and a JavaScript `||` inside the block are two further false-red surfaces in the same
  joined text.
- **The indirection rule is dropped.** Revision 3 proposed forbidding an `npm run` alias
  for the gate so the flag could not be flipped off by a spelling. There are 18 real
  `npm run` invocations in these workflows and no decidable predicate that separates an
  alias for this gate from any other, short of resolving `package.json` scripts — which
  is a second parser standing in for npm, the mistake N3 exists to prevent. The residual
  is stated in SC-H instead of being closed badly.

**Invariants**:
- **I-7.1** Additive to the member set — the existing anchors stay.
- **I-7.2** Not a repo-wide ban: a workflow running no verifier keeps `continue-on-error`
  on an unrelated step. The rule is whole-file scoped, so a workflow that *does* run the
  gate and has an unrelated masked step **is** a violation — a deliberate consequence of
  the existing scope, written down rather than discovered.
- **I-7.3** `release.yml` and `dependency-signatures.yml` stay green **unedited**, and
  the `release.yml:210` allow case is asserted to match the per-line predicate first, so
  the allow is not vacuous.

**Acceptance criteria**:
- **AC-7.1** New fixtures covering each of the four forms on the new gate, plus the two
  allow cases: `release.yml:210`'s real protected pipe, and an unrelated workflow's
  `continue-on-error`.
- **AC-7.2** One mutation per widened clause, each **observed** to red its own fixture
  while `release.yml` stays green (O-10 applies).
- **AC-7.3** `check-workflow-supply-chain.mjs` exits 0 against the real
  `.github/workflows/`.
- **AC-7.4** Residuals stated rather than implied: a non-literal
  `continue-on-error: ${{ … }}` remains unmatched, and so does an aliased invocation
  (SC-H).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Raise the six stale override floors + lockfile regeneration | locked |
| C2 | Extend the overrides walker (pin, carried identity, S1 behaviour changes) | locked |
| C3 | The staleness gate | locked |
| C4 | Gate self-test (obligations O-1…O-12; cases authored in Phase 2) | locked |
| C5 | CI + local wiring | locked |
| C6 | Playbook update | locked |
| C7 | Give C5's prohibitions a mechanism | locked |

## Testing strategy

The decision core is where correctness lives: every transform, filter and predicate is a
pure export driven with injected data (P-1), and the network path is reduced to fetch /
validate / return a result. The shell is tested as a process against a local fixture
server reached by an explicit argument (P-3). O-1…O-12 are the contract; Phase 2 authors
the cases and runs the mutation loop, and Phase 3 reviews the result.

Verified, not assumed: `vitest.config.ts:11` includes `scripts/__tests__/**/*.test.mjs`,
and `coverage.include` is an explicit `src/`-only allowlist, so `scripts/checks/*` is not
pulled into the 75% global or per-file thresholds.

**Not covered**: a GitHub API change that is well-formed but semantically different.
Shape validation on live responses bounds renames and type changes; a semantic change
reds fail-closed.

## Considerations & constraints

- **Only M1 is a real exposure.** M2–M6 are stale guarantees, not shipped
  vulnerabilities — though M3 and M6 intersect HIGH bands, which the PR body says.
- **The gate can go red without a repo change.** That is its purpose (VE-2) and its cost.
  The same property `npm audit --omit=dev` already has in `audit-app`. Recorded so nobody
  "fixes" it later with a severity filter.
- **A transient network fault must not read as a stale floor.** Retry on transport errors
  and 5xx only, distinct tokens per cause, a job timeout. The unbounded transient path is
  the pressure that produces a `continue-on-error`.
- **The positive control proves the channel is live, not that each package was checked**
  (S12), and neither TLS nor the origin pin stops a Node loader.
- **Docker/Trivy is untouched** (VE-5).

### Scope contract

| ID | Deliberately out of scope | Owner |
|----|---------------------------|-------|
| SC-A | A gate over the **npm-bundled** tree in the runner image (the `ip-address`-shaped hole: a Dockerfile `<PKG>_VER` with no `package.json` override to compare against). Different surface (VE-5), different mechanism. | Handoff item 3 / issue #756 |
| SC-B | Raising `pre-pr.sh`'s Test step to `npm run test:coverage` to match CI. Unrelated subject; awaiting an operator decision on runtime cost. | Handoff item 2 |
| SC-C | Auto-remediation (a bot that opens the floor-raising PR). Write-capable automation on a security-relevant manifest is a materially larger trust decision than a read-only checker. | not filed |
| SC-D | Extending the gate to `dependencies`/`devDependencies` pins generally. Dependabot covers direct deps; overrides are the surface with no owner. | not filed |
| SC-E | A dated, GHSA-keyed exemption file for an unpatchable advisory. **Worst case**: a live advisory with no patched version intersects a pin and the gate reds every PR with only S6's two remedies available. **Likelihood**: low — measured **0 of 223** live same-package vulnerability entries across all 18 queried packages have a null patch once withdrawn advisories are excluded; both instances raised in round 1 were withdrawn. **Cost to fix**: ~1 day for machinery with no current instance, and every exemption file is a suppression surface. Revisit when report mode first prints a live no-patch violation; S5 makes that arrival loud and named. | this plan, on first occurrence |
| SC-F | Bounding the five open-ended `>=` pins. **Worst case**: a future advisory on a higher major intersects an unbounded pin and reds CI until someone acts. **Likelihood**: medium over years, zero today. **Cost to fix**: one line each, but the *consequence* is a resolution-behaviour change — an override capped at `<9` forces 8.x on any consumer asking for `^9`, a real break with no present cause. S6 establishes two remedies exist and the gate names both. | this plan, on first occurrence |
| SC-G | Per-package response-shaping resistance beyond TLS and the origin refusal (S12's residual). **Worst case**: an adversary able to shape responses per package serves the canary and empties the other 17, and the gate reports clean. **Likelihood**: very low — requires defeating TLS to a public CA, controlling the runner's egress, or injecting a Node loader, at which point the same adversary can edit the gate. **Cost to fix**: a per-package baseline of expected advisory counts is a second moving-input problem with its own staleness class. Layer 1 and layer 3 make the residual visible rather than closed. | not filed |
| SC-H | Forbidding an aliased (`npm run …`) invocation of the gate in a workflow, so C7's flag cannot be flipped off by a spelling (R51). **Worst case**: someone replaces the literal invocation with an alias and the four masking prohibitions silently stop applying to that workflow. **Likelihood**: low — it requires editing the workflow the gate runs in, which is already the "edit the gate" bypass C3's control class names. **Cost to fix**: no decidable predicate exists short of resolving `package.json` scripts inside the workflow checker, which is a second parser standing in for npm (N3's mistake). Revisit if an alias is ever introduced; AC-7.4 records the residual so a reader does not assume coverage. | not filed |

## Implementation Checklist

Authored in Phase 2 Step 2-1 from impact analysis. Phase 3 reads this as the list of
files that must appear in the diff.

### Files to modify or create

| File | Contract | Why |
|---|---|---|
| `package.json` | C1 | five floor raises (hono, @hono/node-server, postcss, brace-expansion@1, brace-expansion@2) |
| `cli/package.json` | C1 | postcss floor raise |
| `package-lock.json` | C1 | regenerated; only `node_modules/hono` expected to move |
| `cli/package-lock.json`, `extension/package-lock.json` | C1 | regenerated; no diff expected (npm does not record `overrides`) |
| `scripts/checks/check-override-key-disjointness.mjs` | C2 | carry pin + package identity + `"."` self-pins; refuse to recurse into arrays |
| `scripts/__tests__/check-override-key-disjointness.test.mjs` | C2 | new cases only; the 25 existing bodies unedited (AC-2.1) |
| `scripts/checks/check-override-floor-staleness.mjs` | C3 | new gate |
| `scripts/__tests__/check-override-floor-staleness.test.mjs` | C4 | sibling self-test — required by `check-gate-selftest-coverage.sh` member set (1) |
| `scripts/__tests__/fixtures/advisories/lodash.json` | C4 / O-9 | recorded RT1 anchor, untrimmed |
| `.github/workflows/override-floor-staleness.yml` | C5 | weekly sweep |
| `.github/workflows/ci.yml` | C5 | PR job |
| `scripts/pre-pr.sh` | C5 | probe-gated local step (I-5.6, I-5.7) |
| `scripts/checks/check-workflow-supply-chain.mjs` | C7 | widen the member set |
| `scripts/__tests__/check-workflow-supply-chain.test.mjs` | C7 | new fixtures (AC-7.1) |
| `docs/security/dependency-cve-response.md` | C6 | playbook |

**No new `scripts/checks/` file beyond C3's gate** (I-5.7): a second file would need its
own sibling self-test that no contract owns, and AC-4.2 forbids a debt entry.

### Shared code that MUST be reused (R1)

| Symbol | Location | Use |
|---|---|---|
| `discoverManifests` | `check-override-key-disjointness.mjs:54` | manifest discovery — but its `git ls-files` fallback is a **refusal** for C3, not a silent fallback (N4) |
| `splitOverrideKey` | same, `:76` | package-name/selector split, including the scoped-name `lastIndexOf("@")` subtlety (I-2.4) |
| `collectScopes` / `topLevelScope` | same, `:93` / `:123` | the walker C2 extends; a second copy in the new gate is the R1 defect |
| `semver.intersects` | `semver` (root devDependency) | the only range predicate (N3) |
| `extractRunCommands` | `check-workflow-supply-chain.mjs:234` | C7 binds the widened match to extracted `run:` commands, not raw file text |
| `findMaskedVerifierViolations` | same, `:65` | C7 extends this function's member set rather than adding a parallel rule |

### Gates that fire on files this change adds

| Gate | Trigger | Obligation |
|---|---|---|
| `check-gate-selftest-coverage.sh` | new `scripts/checks/*.mjs` | sibling self-test, no new debt entry (AC-4.2) |
| `check-mjs-imports.mjs` | new `.mjs` under `scripts/` | every relative/alias import must resolve |
| `check-actions-sha-pinned.sh` | new workflow | SHA-pinned `uses:` (I-5.1, AC-5.1) |
| `check-workflow-supply-chain.mjs` | new workflow | its own widened rules must pass on it (AC-7.3) |
| `check-doc-paths.mjs` | doc change | every cited path resolves (AC-6.1) |
| `check-override-key-disjointness.mjs` | manifest change | no new key pairs (AC-1.5) |
| `check-dockerfile-prisma-pin.sh` | manifest change | `BE_VER` ≥ the `brace-expansion@>=3` floor (AC-1.4) |
| `check-no-pipe-into-grep-q.sh` | new shell in `pre-pr.sh` | no `… | grep -q` exit-status masking |

### CI parity gaps (Step 2-1 item 7)

The crude command-string diff reported seven CI-only gates; four were false — `pre-pr.sh`
invokes `bypass-rls`, `crypto-domains`, `migration-drift` and `team-auth-rls` via
`node scripts/checks/check-*.mjs` rather than the `npm run` alias CI uses. Verified by
grep, not assumed.

Three real gaps remain, all pre-existing and none reachable by this change:

- `npm run typecheck` — CI-only. This change adds `.mjs` and YAML, not TypeScript.
- `npm run licenses:check{,:ext,:cli}:strict` — CI-only. No dependency is added.
- `bash scripts/check-state-mutation-centralization.sh` — CI-only. Scans `src/`.

**Deferred parity gap** (Anti-Deferral): closing these three is
`scripts/pre-pr.sh`'s subject, not this PR's, and is the same operator decision as SC-B
(the Test-step coverage gap). Worst case: a future PR that does touch TypeScript,
dependencies or `src/` state discovers the failure at push rather than locally.
Likelihood: certain eventually, zero for this change. Cost to fix: small per gate, but it
changes `pre-pr`'s runtime for every developer, which is the operator call SC-B is
already waiting on.

## Carried-Forward Plan Findings

Phase 1 exits here. These round-3 findings are not resolved in this document; each is
recorded per the Anti-Deferral format so Phase 2 reads them as work, not as absence.
Phase 2 Step 2-1 reads this section explicitly.

### R3-CF1 [Major] The command-line contract's exact shape — Out of scope (deferred to Phase 2)
- **Source findings**: round 3 — TEST-F30, FUNC-R3-F7.
- **Anti-Deferral check**: out of scope (different phase), tracked here.
- **Justification** — Worst case: an unrecognized flag is read as a manifest path and
  silently skipped, so `--report` reports nothing and a mistyped scratchpad path reports
  clean; AC-3.0, AC-3.2 and AC-5.4 all depend on it. Likelihood: high if unstated, which
  is why P-4 states the *properties* (flags vs paths, and four named refusals). Cost to
  fix: minutes in code, and two review rounds have now been spent getting the spelling
  wrong in prose. What settles it: writing the argument parser and running AC-3.0.
- **Orchestrator sign-off**: P-4 carries every property that would produce a wrong
  result; only the spelling is deferred.

### R3-CF2 [Major] AC-3.3's fixture-server reachability under the origin pin — Out of scope (deferred to Phase 2)
- **Source findings**: round 3 — TEST-F29 (Critical), SEC-R3-F1, SEC-R3-F2, FUNC-R3-F4.
- **Anti-Deferral check**: out of scope (different phase), tracked here.
- **Justification** — Worst case: the shell, the canary, the retry policy and the exit
  path ship untested for a third revision, and Phase 2 resolves it by weakening the pin
  in a way that is markerless in the diff. Likelihood: medium — S11 now states the
  boundary (ambient refused, explicit argument accepted, default pinned), which is the
  part prose can settle. Cost to fix: the remaining question is whether the pin is
  applied to the default or the effective origin, and running one fixture case answers
  it. What settles it: writing AC-3.3's first case.
- **Orchestrator sign-off**: the design decision (S11) is made; the residual is
  implementation, and O-4 requires the ambient-origin refusal to carry a deny/allow pair.

### R3-CF3 [Minor] O-9's fixture cannot detect an upstream rename — Accepted, with the claim corrected
- **Source findings**: round 3 — TEST-F37, FUNC-R3-F9.
- **Anti-Deferral check**: acceptable risk, quantified.
- **Justification** — Worst case: a reader believes the committed fixture guards against
  a field rename and does not notice that only the live-response shape check does.
  Likelihood: certain if the claim stands, which is why O-9 now states the fixture's role
  as the RT1 anchor and attributes rename detection to the shape check. Cost to fix:
  already fixed in O-9. Residual: nothing regenerates the fixture on a schedule, so it
  can go stale silently — O-9 requires selecting the element by id and refusing if the
  lookup fails or the element became withdrawn, which converts staleness into a red.
- **Orchestrator sign-off**: the false claim is removed; the residual is bounded by a
  refusal.

### R3-CF4 [Minor] The `not-judged` row's effect on the census arithmetic — Out of scope (deferred to Phase 2)
- **Source findings**: round 3 — SEC-R3-F7, TEST-F36, FUNC-R3-F3.
- **Anti-Deferral check**: out of scope (different phase), tracked here.
- **Justification** — Worst case: report mode counts scope-opener rows inconsistently
  with AC-3.4's second instrument and the criterion reds for an arithmetic reason rather
  than a coverage one. Likelihood: medium. Cost to fix: minutes, once both are written.
  What settles it: AC-3.4's first run, which names the symmetric difference by design.
- **Orchestrator sign-off**: S10 names the member and S1 states the queried-vs-judged
  rule (17 + 1 = 18); the counting convention is a Phase-2 detail the criterion itself
  surfaces.

## User operation scenarios

1. **A new advisory lands on a package we override.** Monday's scheduled run reds. Report
   mode names the entry, every intersecting GHSA id and the required floor. The operator
   raises the pin, regenerates the lock, the PR job confirms green.
2. **Someone copies an old floor during a CVE response.** The PR job reds before merge —
   the case the weekly sweep alone would miss for up to seven days.
3. **A `cli/`-only stale floor** (M6's shape). No paths-filter (I-5.3), so a PR touching
   only `cli/package.json` is judged against all three manifests.
4. **The operator runs `pre-pr` without a token.** The skip line prints and the run stays
   green (I-5.6). A direct gate invocation makes 18 unauthenticated requests, then is
   rate-limited, and exits non-zero — a green that means "I could not check" is what this
   closes.
5. **The advisory source returns empty for everything** — an outage, a proxy, a redirected
   origin. The canary fails and the gate exits non-zero, rather than reporting the
   cleanest run in its history. A proxy or loader variable is refused before any request.
6. **GitHub re-splits the canary advisory's bands, or re-classifies its severity.** The
   structural assertion still holds, so nothing reds. Had the assertion been byte-exact,
   the operator's only remedy would have been editing the positive control.
7. **A CVE lands on a package that is a nested scope's parent.** The operator writes
   `{"@crxjs/vite-plugin": {".": "^2.7.1"}}` — npm's only spelling — and the gate judges
   it against `@crxjs/vite-plugin` (S2), including when the scope key carries a selector
   (I-2.4), and including when the `"."` is the scope's only child (S1). Before this plan
   that pin was invisible to every check here.
