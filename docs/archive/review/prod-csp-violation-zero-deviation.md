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
