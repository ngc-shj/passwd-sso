# Coding Deviation Log: prod-csp-violation-zero

Phase 2, 2026-09-27. Every entry that leaves something open carries an
Anti-Deferral cost-justification. Finding IDs refer to
`prod-csp-violation-zero-review.md`.

## D1 — Step 2-2 implemented directly, not delegated to sub-agents

The phase file's default is to split implementation into batches for Sonnet
sub-agents. This work was implemented by the orchestrator instead.

Reason: each contract here is a handful of edits (one new module, one prop, one
import), and Round 2 established that this change's failure mode is *mechanism
precision* — a grep whose subject does not exist, a regex that matches nothing,
a step placed in a stage with no input. Six of Round 2's seven Criticals were
exactly that class. Splitting three-line edits across parallel agents adds
coordination surface to the part that was already the weakest, and buys no
parallelism worth having. R21's residue grep was still run (see D9).

## D2 — C5 converted nothing, because V6 does not exist

Not a deferral: a measurement result.

The RT7 red proof (recorded in the review artifact) reported **zero**
`style-src-attr` violations on every route, including the authenticated
dashboard with the vault unlocked, the sidebar rendered and the password list
populated — the exact page whose `sidebar-shared.tsx`, `folder-tree.tsx`,
`favicon.tsx` and `entry-icon.tsx` sites plan revision 2 listed as "in SSR HTML
by default". A style attribute that reached the parser would have produced a
violation; none did.

So no component was converted. Converting them would change working markup for
a violation class that does not occur, and F29's own remedy says not to
manufacture a deny clause by converting a site that cannot violate.

`src/components/folders/folder-tree.tsx` remains dead code (no importer; all
six references are `import type { FolderItem }`). Left in place under SC4 —
removing it here would erase the evidence that revision 2's table was
unmeasured.

## D3 — C7 ships without a browser `form-action` probe

C7's acceptance called for an E2E case that submits a form to
`http://[::1]:<port>` and asserts Chromium blocks it.

Not implemented. Anti-Deferral: C9 removes the registry side entirely — no
client can register an IPv6-literal redirect URI any more — so the inert
directive has no reachable consequence. Chromium's discard is already measured
and recorded in the review artifact (it logs on every production page load),
and I7.1's actual obligation ("no test asserts that a CSP source the browser
discards is effective") is met by the retitled test plus C9's tests, which are
red-provable in both directions. Adding a dual-stack loopback server to the E2E
suite to re-measure a browser behaviour already measured, on a path no client
can reach, costs more than it proves.

What would settle it if the trade changes: if `[::1]` is ever re-admitted to
the registry, the probe becomes load-bearing and must land with it.

## D4 — C6 has no basePath CI job; the basePath case is verified another way

The plan called for a second CI job building and serving with
`NEXT_PUBLIC_BASE_PATH=/passwd-sso` (F5, F22).

Not implemented as a job. Two reasons, one of which is a design change made
during implementation:

1. The risk F5 named was "the `<meta name="csp-nonce">` carrier breaks only
   under a basePath, because the cookie is written at `path: ${basePath}/`".
   C2 no longer depends on that carrier first: `readCspNonce()` reads the
   `nonce` IDL property of a nonced `<script>` and falls back to the meta. The
   IDL read is basePath-independent.
2. The server-side read (`getCspNonce`) is not affected by the cookie's path
   within the request that sets it: Next.js merges a middleware `Set-Cookie`
   onto the request's cookie store **by name**, which is why the meta already
   matched the response CSP nonce on a first, cookieless request when this was
   measured against a `/passwd-sso` production server at the start of this work.

Anti-Deferral for the remaining gap: a second E2E job doubles that job's
wall-clock for one route, and the residual risk is now limited to the
next-themes nonce under a basePath — covered by the explicit basePath
verification recorded in the review artifact rather than by a standing job.
What would settle it properly: adding the job when the E2E suite is next split
for runtime, so the cost lands with work that is paying it anyway.

## D5 — `IPV6_LOOPBACK_REDIRECT_RE` was written and then removed

An exported regex matching `http://[::1]:<port>/`, so the C9 refusal could
branch on it and name its own reason. Removed before commit: the shared
`REDIRECT_URI_ACCEPT_SET_MESSAGE` already names the reason in every refusal, so
the regex had no consumer. An exported constant nothing imports is dead code.

## D6 — the plan's four anticipated scans: two landed, two did not

| Scan | Landed? | Disposition |
|------|---------|-------------|
| C3 patch-marker assertion | **yes** — in `Dockerfile`, per sonner chunk | red-proved four ways (D8) |
| C5 SSR-HTML `style="` count | **yes** — inside `e2e/tests/csp-strict.spec.ts` | outside `check-gate-selftest-coverage.sh`'s member set by construction (F18) |
| C1 `"csp-nonce"` literal AST scan | no | see below |
| C4 client-chunk marker scan | no | see below |

**C1's literal scan** — Anti-Deferral: the invariant it would enforce is now
satisfied structurally. Both names live in one module
(`src/lib/security/csp-nonce-names.ts`) and every other site imports them; a
new hardcoded literal would have to be written deliberately beside a working
import. A scan would add a `scripts/checks/` member, which per F18 drags in a
sibling self-test, to defend a one-line constant. What would settle it: a
second literal appearing anywhere — then the class is real and the scan earns
its keep.

**C4's chunk scan** — Anti-Deferral: revision 2's version of it was refuted
(F-F1: `z.config` is a runtime flag and cannot change the emitted bytes), and
the marker-based replacement would assert that a `jitless` site exists in an
entry chunk, which is weaker than what C6 already does: Chromium reports the
`script-src`/eval violation directly, and the gate asserts zero. Adding a
tripwire that is strictly weaker than the adjudicator already in place is
surface without cover. C4's control class in the plan is `best-effort
tripwire` precisely for this reason.

## D7 — no second CI step was added to invoke the gate

F24 asked for one. None is needed: `e2e/playwright.config.ts` has
`testDir: "./tests"`, so `csp-strict.spec.ts` is collected by the existing
`npm run test:e2e` step, and the `webServer` condition is now
`CI || E2E_CSP_SERVER === "prod"` — additive, so CI still serves a production
build for every spec (F23/F-F4: replacing the `CI` condition would have moved
all 36 existing specs onto `next dev`).

## D8 — red proofs performed, and where

Per the project's mutation-hygiene rule, every break→observe→restore cycle ran
on a throwaway copy; no production file was mutated and restored.

| Claim | Mutation | Observed |
|-------|----------|----------|
| the gate can fail at all | none — the unfixed tree | 7 routes red, 6-7 violations each; self-test green |
| collector is not over-reporting | nonce'd `<style>` injected | zero violations (allow arm, in-spec) |
| `readCspNonce` memoizes only hits | scratch copy caches the miss | exactly "does not memoize a miss" reds |
| `readCspNonce` prefers the IDL property | scratch copy reads meta first | exactly "prefers the nonce IDL property" reds |
| `ThemeProvider` forwards the nonce | scratch copy drops `nonce={nonce}` | both nonce tests red, the two pre-existing tests stay green |
| Docker marker check can fail | scratch chunk copy with the marker stripped | `SONNER_PATCH_MARKER_ABSENT` |
| … and distinguishes a missing subject | empty scratch directory | `SONNER_PATCH_UNVERIFIABLE` (distinct message) |
| … and catches a version bump | `v = "2.0.9"` | `SONNER_VERSION_DRIFT` |
| … and catches an empty patches dir | empty scratch directory | `SONNER_PATCHES_DIR_EMPTY` |

One false-green was found and fixed by this process: the Docker marker grep was
first written directory-wide, and `meta[name="csp-nonce"]` also compiles into
the app's own `csp-nonce.ts` chunk — so it was green whether or not the patch
applied. Measured (3 chunks carried the marker, only 2 carried sonner), then
rewritten to check per sonner chunk.

## D9 — R21 residue check

`git diff | grep -nE '^\+.*(__redproof__|// TODO restore|it\.skip\(|xit\(|/\* .* removed \*/)'`
→ no matches. `git status --short` → no `__redproof__` or `.vitest` residue.
The two scratch mutation directories were created under `src/` so vitest would
collect them, and both were removed; the real `theme-provider.tsx` and
`csp-nonce.ts` were re-grepped for their load-bearing lines afterwards.

## D10 — `.vitest/` is an untracked tool artifact

The Bash wrapper writes a JSON report to `.vitest/json/output.json` on every
vitest run. It is not produced by `vitest.config.ts` and is not in
`.gitignore`. Deleted rather than committed; not added to `.gitignore` because
that is a repo-wide change this task did not ask for. Worth raising separately.

## D11 — the Docker build caught a defect in the guard added for C3

Recorded because it is the second time in this task that a check passed in one
resolution context and failed in the one that ships.

The sonner version pin was first written as
`node -e "require('sonner/package.json').version"`. It passed locally, where
the equivalent probe had been run against a *relative path*. Inside the image
it threw:

```
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './package.json'
is not defined by "exports" in /app/node_modules/sonner/package.json
```

sonner's `exports` map lists only `"."` and `"./dist/styles.css"`, so the
package-specifier form cannot reach the manifest at all; a relative path
bypasses the exports field, which is exactly why the local check did not
notice. Rewritten to `readFileSync`, which still exits non-zero when the
manifest is absent (`ENOENT`, verified with the status read unpiped).

The other self-inflicted instance, caught the same way: the marker grep was
first written directory-wide and was green whether or not the patch applied,
because the app's own `csp-nonce.ts` compiles the same selector string into a
different chunk.

Both were found by *running the thing*, not by reading it. T1 in the manual
test plan is no longer a deferred step.

## D12 — basePath verification for C1 (closes D4's residual)

D4 declined a second CI job for the basePath configuration. The residual it
left — "next-themes' nonce under a basePath" — was measured instead, against a
production build carrying `NEXT_PUBLIC_BASE_PATH=/passwd-sso`:

```
response CSP nonce            : FmD22JZL/revr0rK2C6kIQ==
<meta name="csp-nonce">       : FmD22JZL/revr0rK2C6kIQ==   (match)
inline scripts WITHOUT nonce  : 0   (was 1 — next-themes' ThemeScript)
inline scripts WITH nonce     : 16, none mismatched
style= attributes in SSR HTML : 0
```

So the basePath-scoped nonce cookie still reaches the Server Component that
renders the meta, and next-themes is nonced under a basePath as well as
without one. The standing CI job remains deferred on D4's terms.

## D13 — a mutation proof that stays GREEN is the one to distrust

The most useful thing the Phase-2 self-check produced was not a finding in the
code; it was a finding in the proof harness.

Proving the new authorize-route test discriminating meant copying `route.ts` to
`route.mutant.ts`, dropping the `isAcceptableRedirectUri` conjunct, and
repointing the test copy's import. The mutant run came back **18/18 green**,
which reads as "the test is vacuous". Four increasingly specific probes later —
the parsed query value, the DB mock's resolved rows, the returned status, the
call count — every input checked out and the behaviour still contradicted them.

The cause was the repoint. The test imports
`from "@/app/api/mcp/authorize/route"`, not `from "./route"`, so the string
substitution matched nothing and **every "mutant" run had been importing the
real file**. Adding `assert 'from "./route.mutant";' in t` surfaced it
immediately; with the alias form replaced, the mutation reds exactly the C9
deny case and nothing else.

The same shape then repeated once more, for a different reason: the consent
test's first version set `mockTxFindFirst` while the route's lookup resolves
through `mockFindFirst`, so its `[::1]` row never reached the handler and the
deny case passed on the default client's URI list. Setting both mocks makes the
mutation red.

Two rules this leaves behind, both now applied to every red proof in D8:

1. **Assert that the mutation landed AND that the subject was repointed.** A
   silent no-op in either half produces a green that is indistinguishable from
   a vacuous test.
2. **A red proof that produces a RED is self-validating** — the harness cannot
   fake a failure. A red proof that produces a GREEN proves nothing until the
   harness itself is verified. Of D8's nine, eight produced reds; the one that
   produced a green was the one that was broken.

## D14 — Phase 2 self-check dispositions

Three sub-agents ran the R1-R57 / RS* / RT* checklist against the implementation.
Thirteen distinct findings; every Critical- and Major-rated one is fixed in this
phase rather than carried to Phase 3.

| Finding | Disposition |
|---|---|
| authorize/consent adjudicate a stored row by membership alone, so rows predating the C9 narrowing survive | **Fixed.** `isAcceptableRedirectUri` is now the single predicate, applied at registration AND on the stored value at both authorize and consent. Deny + allow tests in both routes, each red-proved by a real mutation (D13) |
| the i18n hint and the architecture doc still advertised `[::1]` | **Fixed.** en/ja hints and `docs/architecture/machine-identity.md`. The form no longer recommends what its validator refuses |
| `container-scan` and nine other jobs skip silently when `changes` cannot decide — and `container-scan` is the only place the Dockerfile guards run | **Fixed as a class, not an instance.** All 17 jobs; none remains fail-open. Verified by parsing the workflow and re-deriving the member set |
| `"csp-nonce"` is held as a byte literal by the patch and the Dockerfile, which D6 had claimed did not happen | **Fixed.** Both named in `csp-nonce-names.ts` as change-coupled sites. D6's premise was false; the conclusion (no literal scan) still holds, now for a stated reason |
| NFR5 shipped with no enforcer and no Anti-Deferral entry | **Fixed.** `scripts/checks/check-dockerfile-ignore-scripts.sh` + a 7-case sibling self-test, queued in `pre-pr.sh`. Green on the real Dockerfile, red on a stripped copy, two distinct refusals for the two cannot-run cases |
| `FOREIGN_ORIGIN_ALLOWLIST` was inverted — allowlisting a origin moved it into a bucket that still failed | **Fixed.** Three buckets: app / foreign (fails, labelled) / excluded (passes) |
| the gate's header claimed a toast case and an error-page case it did not have | **Fixed by delivering two and withdrawing one.** Added the `s` root segment (a separate layout tree) and an FR2 assertion that sonner's stylesheet is live in `document.styleSheets`; `global-error.tsx` is not reachable by navigation, so the claim is withdrawn rather than faked |
| the overlay test claimed a scroll-lock assertion it never made | **Fixed.** FR3 now asserts `getComputedStyle(document.body).overflow === "hidden"` before the violation count, so V5 is verified by outcome and not by absence |
| the SSR style-attribute counter had only ever observed 0 | **Fixed.** A positive control with four fixtures, including two over-report cases (`data-mystyle`, the word in text) |
| `csp-header.test.ts` cited an e2e assertion that D3 had declined to write | **Fixed.** The citation now points at what exists |
| `CSP_NONCE_META_NAME` and `REDIRECT_URI_ACCEPT_SET_MESSAGE` were imported by no test | **Fixed.** The meta reader now pins the constant; the message has three assertions including one that it advertises no host the predicate refuses |
| the mocked 400 body pinned a message no route can emit | **Fixed.** It builds from the constant |
| the client-side `validateRedirectUris` inherits the narrowed regex but has no `[::1]` fixture | **Partly deferred.** The predicate it mirrors is now pinned in both directions in `src/lib/constants/auth/mcp.test.ts`, and the component imports the same constant rather than a copy. A UI-level fixture would re-test the regex through three layers of form state. What would settle it: a component test if `validateRedirectUris` ever stops delegating to the shared regex |

One harness note worth keeping: the Dockerfile marker guard's shell form must be
exercised under `/bin/sh`, not zsh. zsh does not word-split `$chunks`, so `$f`
becomes the whole newline-joined list and a healthy tree reads as a false red.
The builder stage is `node:24-alpine`, i.e. `sh` — matching the recorded runs.
