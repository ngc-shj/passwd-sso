# Plan Review: prod-csp-violation-zero
Date: 2026-09-26
Review round: 1

## Changes from Previous Round

Initial review.

## Round-1 execution record (read this before the findings)

This round did NOT run to the skill's specification, and the gap is recorded here rather than
papered over.

- **Functionality expert — NOT DELIVERED.** The sub-agent was launched and was stopped by the
  user mid-run. Its work is cancelled; no findings from that perspective exist for Round 1.
- **Security expert — NOT DELIVERED.** Same cause, same status. For a change whose entire
  subject is a security header on a zero-knowledge password manager, this is the most
  consequential of the two gaps.
- **Testing expert — delivered**, 17 findings (3 Critical / 9 Major / 5 Minor), below.
- **Ollama pre-screening — delivered**, 3 findings, below.

Phase 1 Step 1-4 is therefore **not discharged**. Round 2 re-runs all three experts against the
revised plan; the Go/No-Go gate does not open before that.

### Orchestrator verification of the Testing expert's load-bearing claims

Sub-agent findings are not taken at face value. Every Critical and every Major that names a
file was re-derived by the orchestrator:

| Finding | Claim | Orchestrator re-derivation | Verdict |
|---------|-------|---------------------------|---------|
| F3 | `Dockerfile:14`, `release.yml:80`, `ci.yml:269,718,747,774` use `npm ci --ignore-scripts`; `ci.yml:561` (E2E) uses plain `npm ci` | `grep -n "npm ci" Dockerfile`, `grep -rn "npm ci" .github/workflows/*.yml` | **Confirmed.** Also `dependency-signatures.yml:55` and `override-floor-staleness.yml:45`, which the finding did not list — the member set is 7 sites, not 6 |
| F5 | E2E job env has no `NEXT_PUBLIC_BASE_PATH` | `sed -n '505,562p' .github/workflows/ci.yml` — env block carries `DATABASE_URL`, `AUTH_URL`, `E2E_ALLOW_DB_MUTATION` and no basePath | **Confirmed** |
| F6 | Playwright pins chromium 1243; only 1208/1234 are installed | `playwright-core/browsers.json` → `chromium=1243 chromium-headless-shell=1243`; `ls ~/.cache/ms-playwright` → 1208, 1234 | **Confirmed** |
| F7 | `retries: process.env.CI ? 1 : 0` | `e2e/playwright.config.ts:20` | **Confirmed** |
| F8 | the plan's `NextIntlClientProvider` derivation returns 9 layouts, not 2 | `grep -rl "NextIntlClientProvider" src/app --include='layout.tsx'` → 9 files | **Confirmed.** The replacement derivation the finding proposes, `find src/app -mindepth 2 -maxdepth 2 -name layout.tsx`, returns exactly the two root segments — verified |
| F9 | `csp-builder.ts:52` carries `"csp-nonce"` in a comment, absent from the plan's stated current set | `grep -rn '"csp-nonce"' src ...` → 4 files | **Confirmed** |
| F10 | 78 non-test zod importers, 0 carrying a `"use client"` directive | re-run by the orchestrator before the plan was written; same numbers | **Confirmed** |
| F11 | `patches/**` appears in no `dorny/paths-filter` filter | `sed -n '30,95p' .github/workflows/ci.yml` | **Confirmed** |
| F2 | `scripts/checks/check-gate-selftest-coverage.sh` exists and its member set excludes `e2e/tests/*.spec.ts` | file present (9.3K); member set not re-read in full this round | **Existence confirmed; member-set claim carried as unverified** |

### Quality warning on the Testing expert's Recurring Issue Check

The section the expert emitted is **not valid evidence that the R1-R57 catalogue was checked**.
Its rule names do not match the catalogue: it lists e.g. `R22 (plan の置き場所)`,
`R29 (prisma generate)`, `R30 (破壊的 docker 操作)` — these are topics from the orchestrator's
project memory index, not triangulate rules (the real R22 is *Perspective inversion for
established helpers*, R29 is *Citation, derived-claim and rationale accuracy*, R30 is *Markdown
autolink footguns*). The expert appears to have reconstructed a checklist from an unrelated
list rather than from the catalogue.

Consequence: the findings themselves are grounded and re-verified above, and are kept. The
`## Recurring Issue Check` block is recorded verbatim below as what was produced, but it does
**not** discharge the per-rule obligation. Round 2 must supply a correct one.

## Functionality Findings

None — the expert was cancelled before delivering. See the execution record above.

## Security Findings

None — the expert was cancelled before delivering. See the execution record above.

## Testing Findings

### F1 — Critical: an authenticated route that redirects to signin still passes I6.1

C6's I6.1 verifies only that the response CSP header contains `'nonce-` and not
`'unsafe-inline'`. Measured: `GET /passwd-sso/ja/dashboard` unauthenticated → 307 →
`/ja/auth/signin?callbackUrl=…`, and the signin response carries the same strict CSP. So the
gate passes when session injection fails. V5 (Radix overlay) and V6 (SSR style attributes)
exist only on authenticated pages, so a broken cookie-name resolution in `e2e/helpers/auth.ts`
(which depends on `NEXT_PUBLIC_BASE_PATH`) or a broken `global-setup` seed silently degrades
the authenticated half of the gate to "re-measured an already-clean signin page, 0 violations".
A second path to the same degradation: a locked vault renders neither the password list
(`favicon.tsx:21,28`, `entry-icon.tsx:33-43` — exactly the V6 subjects) nor the sidebar folder
tree.

Impact — C6 is the sole adjudication authority for C2 and C5. That authority degrades silently
on its most fragile precondition, and FR1's "every reachable page" goes unmeasured while the
gate reports green.

Fix — before asserting anything about violations, assert per authenticated route that
(a) `page.url()` is not the post-redirect signin, (b) a page-specific landmark is visible,
(c) the vault is unlocked and at least one list row rendered. Allow side: the public routes
`/ja/auth/signin` and `/s/<token>` must pass without the authentication assertions — pin that
in the same spec. Red-prove one mutation per clause: ① skip `injectSession` → (a) reds,
② break the landmark selector → (b) reds, ③ drop the vault-unlock step → (c) reds. Route the
undecidable outcomes — non-2xx from `page.goto`, landmark timeout, seed user missing — to a
named refusal `CSP_GATE_PRECONDITION_FAILED: <route> <reason>` rather than to "0 violations";
never skip. Preserve I6.1's header assertion — it is the only dev-server detector and this fix
stacks on top of it. Boundary: the document at navigation completion; on a tie (cannot tell
whether a redirect happened) fall to refusal.

### F2 — Critical: the violation collector has no standing positive control (RT10 / RT7)

The plan defines the RT7 red proof as a one-off observed on the unfixed tree and recorded in
the review artifact. After the fix, the gate is permanently green if the collector breaks —
a misspelled event name, `addInitScript` re-running on client-side navigation and resetting the
array, the listener attached to the wrong target, the init script throwing. A test that always
passes is Critical.

The repository already has a meta-gate for this class, `scripts/checks/check-gate-selftest-coverage.sh`,
whose member set is (1) `scripts/checks/*.sh|*.mjs` and (2) inline `run_step "Static: ..."` in
`pre-pr.sh`. `e2e/tests/*.spec.ts` is outside it, so C6 lands with no RT7 coverage enforced,
and the plan does not mention the meta-gate at all.

Fix — add a standing self-test in the spec: on the target origin, `page.evaluate` a nonce-less
`<style>` into `head` and assert the collector catches exactly one `style-src-elem`; zero
caught is a failure. Allow side: the same self-test with a nonce'd `<style>` returns zero.
Red-prove: ① comment out the listener registration → self-test reds, ② rename the event →
reds, ③ delete the array push → reds. Undecidable: injection `evaluate` throws, or the init
script never attached → `CSP_GATE_COLLECTOR_UNVERIFIED`. Preserve the production routes'
zero-violation assertion; the self-test is a separate case beside it, not a relaxation.
Boundary: one `page.goto`'s document lifetime; a navigation crossing re-initialises the
collector and the crossing itself is a refusal. Additionally: either extend
`check-gate-selftest-coverage.sh`'s member set to E2E gate specs, or record in C6 why not.

### F3 — Critical: the subject under test is not the shipped artifact — `--ignore-scripts` means the sonner patch never reaches the image

C3 runs `patch-package` from `postinstall`, but:

- `Dockerfile:14` — `RUN npm ci --ignore-scripts`
- `release.yml:80` — same
- `ci.yml:269, 718, 747, 774` — same
- (orchestrator addition) `dependency-signatures.yml:55`, `override-floor-staleness.yml:45` — same

Only the E2E job (`ci.yml:561`) runs plain `npm ci` and then `npm run build && npm start` under
the gate. **The artifact the gate observes and the Docker image that ships are different
trees.** The gate goes green on a patched tree while the deployed image carries unpatched
sonner and V3 survives into production. This also voids I3.2 — under `--ignore-scripts`,
patch-package never runs, so a version bump cannot fail loudly.

Fix — make patch application an explicit build step rather than a lifecycle hook
(`npm ci --ignore-scripts && npx patch-package --error-on-fail`) in every path that produces a
shipped or tested artifact, and add a post-build verification: grep the built
`node_modules/sonner/dist/index.mjs` (or the emitted bundle) for the patch marker
`meta[name="csp-nonce"]` and fail the build when absent. Allow side: there is no legitimate
path that uses upstream unpatched sonner; a patched build must pass. Red-prove: ① empty
`patches/` → marker grep reds, ② bump sonner with `--error-on-fail` → non-zero exit,
③ point the grep at a non-existent path → must refuse, not go green on 0 hits. Undecidable:
the grep target is missing or the bundle layout changed → `SONNER_PATCH_UNVERIFIABLE`, distinct
from the 0-hit message. Preserve `--ignore-scripts`: it is a deliberate supply-chain control
with its reason recorded in `Dockerfile` and `release.yml` comments — do not remove it to make
the patch apply. Boundary: the shipped image layer; the CI `npm ci` tree is outside it, and on
a tie the shipped artifact is authoritative.

`[Adjacent] Critical: shipping an unpatched sonner in the production image — this may overlap with the Functionality expert's scope.`

### F4 — Major: I3.2's "fails loudly" is unproven on the local path

The plan classifies I3.2 as `schema-enforced, by the tool` and delegates adjudication to
patch-package's hunk matcher, but patch-package exits non-zero on a failed patch only under CI
detection; locally it warns and exits 0 unless `--error-on-fail` is passed. The plan specifies
neither the flag nor which path the acceptance ("a deliberate version bump fails it") runs on.

Fix — spell the invocation `patch-package --error-on-fail` and state the acceptance on both
paths: locally (no CI env var) bump sonner to 2.0.9, `npm install` → non-zero; on CI → non-zero.
Allow side: at 2.0.8, `npm ci` completes with exit 0 and the patch is applied (pinned by F3's
marker grep). Red-prove: ① version bump → non-zero, ② delete the patch file → F3's marker grep
non-zero. Undecidable: the `patch-package` binary is absent → the step must not be a silent
success; probe for it and exit non-zero. Preserve: install must still complete under
`legacy-peer-deps=true` (`.npmrc`). Boundary: the exit code of `npm ci` / `npm install`; a
warning-only outcome falls on the fail side.

### F5 — Major: the gate runs only at basePath `""` while production uses `/passwd-sso`

The E2E job env carries no `NEXT_PUBLIC_BASE_PATH`; `ci.yml:337-339` builds with a basePath but
never serves that build through the gate. Meanwhile `src/lib/proxy/security-headers.ts:65`
issues the nonce cookie at `path: ${basePath}/` and `src/app/layout.tsx:11` reads it into
`<meta name="csp-nonce">` — the **sole** carrier for C2 and C3. A breakage that only manifests
with a basePath (cookie path mismatch → empty meta) is invisible to a gate that never sets one,
even though the plan's own baseline was measured at `/passwd-sso`.

Fix — run the gate over at least one route in a basePath configuration (a dedicated Playwright
project, or an extra job building and serving with `NEXT_PUBLIC_BASE_PATH=/passwd-sso`), with
two deny clauses: the meta content is non-empty, and violations are zero. Allow side: the whole
existing basePath-`""` suite keeps passing unchanged. Red-prove: ① pin the cookie path to `/`
→ reds under basePath, stays green at `""` (proving the existing configuration alone cannot
detect it), ② delete the meta tag → reds in both. Undecidable: the basePath server does not
start, or no `<meta>` is found → `CSP_GATE_BASEPATH_SUBJECT_UNAVAILABLE`. Preserve the existing
absolute-path assumption documented at the top of `playwright.config.ts` — this is an addition,
not a replacement. Boundary: `NEXT_PUBLIC_BASE_PATH` at serve time; build-time-only
verification is outside it.

### F6 — Major: the gate is structurally unrunnable locally, and the red proof used a different browser

Three facts compound. (1) `playwright.config.ts:89-91` runs `npx next dev --turbopack` locally
and `npm run build && npm start` only under `CI`, so I6.1 correctly fails the local default —
but the plan classifies VEC1 `verifiable-local` without specifying any wiring for it. (2)
Setting `E2E_BASE_URL` skips `webServer` entirely and points the gate at an arbitrary server;
the config's own "Local usage" comment points it at `next dev`. (3) Playwright pins chromium
revision **1243**, and only 1208 and 1234 are installed, so `npx playwright test` cannot launch
locally — while the plan's baseline, the record the RT7 red proof rests on, was taken on
chromium **1234**.

Fix — add a `test:e2e:csp` script and switch `webServer.command` to the production build on an
explicit flag (`E2E_CSP_SERVER=prod`) rather than on `CI`. Deny: pointed at a dev server, I6.1
fails. Allow: pointed at a production server it passes, and the other specs keep running
against local dev as before. Red-prove: ① no flag → I6.1 reds, ② `E2E_BASE_URL` at a dev server
→ I6.1 reds, ③ production server → green. Undecidable: the chromium binary is absent → the
launch failure must propagate as a non-zero test failure, and `npx playwright install chromium`
goes into VEC1 as a prerequisite. **Re-take the RT7 red proof on revision 1243**, the revision
the gate will use. Preserve `E2E_BASE_URL` for the other specs; only the CSP spec defends
itself via I6.1. Boundary: the response headers of the server actually connected to, not the
configured intent.

### F7 — Major: `retries: 1` turns an intermittent violation into a flaky green (R44)

`playwright.config.ts:20` sets `retries: process.env.CI ? 1 : 0`. The plan itself concedes C4's
I4.3 is a `best-effort tripwire` because module evaluation order is not controlled, and the
sonner / react-style-singleton injection points are likewise order-dependent — order-dependent
violations are intermittent. Playwright reports a test that passed on retry as "flaky" and
still exits 0, so `npm run test:e2e` (`ci.yml:576`) goes green.

Fix — `test.describe.configure({ retries: 0 })` in the CSP spec, leaving the config-level retry
for the other specs. Deny: one or more violations on the first attempt fails. Allow: the other
E2E specs keep their CI retry. Red-prove: ① inject a 50 %-probability nonce-less style behind a
debug branch and run 10 times → at least one red (retries:0 proven), ② same branch with
`retries: 1` restored → greens appear (proving the change is load-bearing). Undecidable: add a
CI step that greps the reporter output for any "flaky" count and exits non-zero. Preserve
`fullyParallel: false` / `workers: 1`. Boundary: the first attempt; retry results are not
evidence.

### F8 — Major: I2.1's derivation does not return the set the plan states (R42)

The plan's `grep -rl "NextIntlClientProvider" src/app --include='layout.tsx'` returns **9**
files, not the stated 2: the two root-segment layouts plus
`[locale]/{admin,auth,dashboard,mcp,privacy-policy,recovery,vault-reset}/layout.tsx`. The
conclusion (two mount points suffice) survives on ancestry, but the written derivation is not a
re-runnable completeness check. It also misses subtrees that bypass both layouts —
`src/app/global-error.tsx` replaces the root layout and is therefore never a descendant of
`CspNonceInit`, even though C5 treats its inline styles.

Fix — replace the derivation with: enumerate root segments under `src/app`
(`find src/app -mindepth 2 -maxdepth 2 -name layout.tsx`, plus the root `layout.tsx` and
`global-error.tsx`) and tabulate, per member, whether it carries `CspNonceInit` and why.
Allow side: the 7 nested layouts must NOT carry it (no duplicate mount) — pin that too.
Red-prove: ① add a scratch `src/app/embed/layout.tsx` and re-run the derivation → the new member
is listed, ② remove `CspNonceInit` from `[locale]/layout.tsx` → the Radix-overlay route in C6
reds. Undecidable: `find` returns 0 → refusal, matching the "examined nothing ≠ found nothing"
pattern already used by `check-e2e-selectors.sh`. Preserve the asymmetry that `s/layout.tsx`
has no `ThemeProvider` but does have `Toaster` — C2 needs both layouts, C1 only `[locale]`.
Boundary: the root segment; nested layouts are inside it and a tie resolves to "an ancestor
already carries it".

### F9 — Major: I1.2's stated current set omits a live occurrence (R42)

`grep -rn '"csp-nonce"' src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'` returns
**4** files, not the stated 3 — `src/lib/security/csp-builder.ts:52` carries it inside a
comment. Gating the target set literally therefore fails on a file this change never touches;
loosening the allowlist to compensate makes the gate unmeasured.

Fix — re-spell the derivation over string-literal AST nodes only (ts-morph, as
`project_ast_guard_tsmorph_no_program` already does elsewhere in this repo). Deny: a non-test
module holding the literal outside the allowlist fails. Allow: the `csp-builder.ts` comment and
the three test files must not fail it. Red-prove: ① add `const x = "csp-nonce";` in a new file
→ red, ② the comment alone → green (no false positive), ③ empty the allowlist → red (allowlist
is load-bearing). Undecidable: a file fails to parse → `CSP_NONCE_LITERAL_SCAN_PARSE_ERROR`,
not a 0-hit pass. Preserve the `csp-builder.ts:51-53` comment — do not delete it to satisfy a
gate. Boundary: the TypeScript string-literal node; comments and tests are outside it.

### F10 — Major: I4.3's member set is undecidable as specified (R42)

The plan's derivation was run: **78** non-test zod importers, of which **0** carry a
`"use client"` directive. The plan's filter "any member that is a client module" therefore
returns the empty set. The real client graph is formed by directive-less `.ts` modules pulled
in transitively from client components, which source grep cannot decide. The plan defers the
enumeration to implementation without supplying a decision procedure.

Fix — move the derivation from source grep to the build artifact: after `npm run build`, scan
`.next/static/chunks/**/*.js` and assert (a) zero occurrences of `Function(` / `new Function(`,
(b) a marker showing the jitless configuration is reachable. Allow side: the server chunks
(`.next/server/**`) must still carry the JIT path (I4.2) — pin that in the same scan, in the
opposite direction. Red-prove: ① delete the `z.config` line → (a) reds, ② remove the
`typeof window` guard → the server-side assertion reds, ③ point the scan at a non-existent
directory → refusal rather than a 0-hit green. Undecidable: `.next/static/chunks` empty or
absent → `ZOD_JIT_SCAN_NO_SUBJECT`. Preserve: none of the 78 server-only modules change; moving
to a bundle scan removes the human client/server judgement entirely. Boundary: the built client
chunk; the `"use client"` directive is not an indicator of it.

Note: C4's signature names `src/lib/validations.ts`, but what exists is the **directory**
`src/lib/validations/` (an `index.ts` barrel plus 14 modules) — see F13.

### F11 — Major: `patches/**` is in no CI paths filter (R33)

`ci.yml:30-89` defines the `dorny/paths-filter` set; `patches/**` appears in none of them, and
the E2E job's condition is `app || e2e || ci`. A PR touching only
`patches/sonner+2.0.8.patch` therefore runs neither `app-ci` nor the gate — the single most
direct way to break C3 triggers no check.

As the R33 answer: the E2E gate is configured in one file (`ci.yml`), but `--ignore-scripts`
spans five files (`ci.yml`, `release.yml`, `dependency-signatures.yml`,
`override-floor-staleness.yml`, `Dockerfile`) — see F3. The plan addresses neither.

Fix — add `patches/**` and `.npmrc` to the `app` filter. Deny: a patches-only branch makes the
e2e job run. Allow: the existing behaviour where a docs-only PR skips app jobs (documented in
the filter's own comments) is unchanged. Red-prove: ① patches-only branch with the entry →
`app=true`, ② the same branch without it → `app=false` (change is load-bearing). Undecidable:
`paths-filter` cannot resolve the base ref → fall to running everything; check how an empty
`needs.changes` output evaluates against the existing `always()`. Preserve the deliberate
inclusion of `docs/operations/**` and `CLAUDE.md` in `app`. Boundary: the PR's changed-file set;
patch files are inside `app`.

### F12 — Major [Adjacent]: C5's forbidden pattern bans syntax that cannot produce the violation

C5 forbids `style=\{` across `src/**/*.tsx`. But `style-src-attr` polices the parsing of a
`style` **attribute in HTML**, not a CSSOM assignment: React DOM applies styles on client mount
via `node.style.setProperty`, so a `style={}` that only ever renders client-side produces no
violation. The plan classifies `tag-dialog.tsx:159` and `password-generator.tsx:358` as "no —
inside a closed Dialog" and then says "convert anyway; it renders once opened, and CSP applies
the same" — a rationale in no verifiable form. Measured: the production SSR HTML of
`/passwd-sso/ja/auth/signin` contains **0** `style="` attributes.

Impact (testing) — two of nine sites cannot be reddened by C6, the plan's own adjudication
authority, so RT7 is unsatisfiable for them. And the pattern has no allow side, so a future
legitimate client-only dynamic style has no route except loosening the gate.

Fix — re-base the pattern on "a `style` attribute serialised into SSR HTML" and move the check
to the built output: the `.next/server/chunks/ssr/*.js` scan I5.2 already performs, or
`grep -o 'style="'` returning 0 over the SSR HTML of each route C6 visits. Allow side: allowlist
client-only `style={}` explicitly, and pin "does not appear in SSR HTML" for each. Red-prove:
① restore `folder-tree.tsx:57` → SSR-HTML grep reds, ② restore `tag-dialog.tsx:159` → stays
green (allow side proven), ③ point the grep at an empty directory → refusal, not green.
Undecidable: a route whose HTML cannot be fetched (non-200, redirect) → joins F1's refusal.
Preserve `src/app/global-error.tsx`'s inline styles: as R3 notes, they are used precisely when
the stylesheet may not have loaded — allowlist it and keep R3's field check (reproduce a root
layout throw against the production server) in the acceptance. Boundary: the HTML string the
server returns; `style={` in JSX source is only an indicator.

`[Adjacent] Major: whether CSSOM-applied styles really are outside style-src-attr — this may overlap with the Security expert's scope.`

### F13 — Minor: C4 targets a file that does not exist, and its unit test is trivially green

C4's signature names `src/lib/validations.ts`; what exists is `src/lib/validations/` with an
`index.ts`. And the acceptance "a unit test asserts the config is a no-op when `window` is
undefined" is trivially satisfied because `vitest.config.ts:7` sets `environment: "node"`, where
`window` is already undefined — deleting the assertion leaves it green. The paired allow case
(jsdom, `jitless` actually set) needs a separate file with a `// @vitest-environment jsdom`
pragma and a module-cache reset, because the effect is at module scope; the plan specifies
neither.

Fix — a jsdom test asserting zod's global config has `jitless: true` after import, and a node
test asserting it does not. Red-prove: ① remove the `typeof window` guard → the node test reds,
② delete the `z.config` call → the jsdom test reds; run each separately so neither assertion is
decorative. Undecidable: if zod exposes no read API and internal state must be touched, say so
and make F10's bundle scan authoritative instead. Preserve server-side JIT (I4.2). Boundary:
`typeof window`, pinned on both sides. Also correct the signature to
`src/lib/validations/index.ts` — noting that barrel evaluation is not guaranteed to precede
every schema module, which is why F10's bundle scan carries the real weight.

### F14 — Minor: C6 has no positive signal that the page actually rendered (RT8)

I6.1 / I6.2 require a header shape and a route-table composition, but nothing asserts that the
"interaction that mounts a Radix overlay" mounted one, or that a toast appeared. A selector
that silently no-ops leaves the gate green at zero violations.

Fix — apply F1's deny/allow/red-prove shape to interactions: before the violation assertion,
assert `document.body` carries the scroll-lock style (already stated in C2's acceptance) and
that `[data-sonner-toaster]` is in the DOM (already stated in C3's acceptance). Red-prove:
drop the overlay-opening click, and drop the toast trigger, each on its own. Undecidable:
selector timeout → `CSP_GATE_INTERACTION_NOT_OBSERVED`. Nothing is removed; this only moves
acceptance criteria that C2 and C3 already state into C6's execution order. Boundary: the DOM
state immediately before the violation assertion.

### F15 — Minor (question): does the gate reuse the existing seed infrastructure or seed its own? (RT11)

VEC2 names `seedUser`/`seedSession`, but `e2e/global-setup.ts` already seeds 13 users, calls
`cleanup()` *before* seeding (line 194), and `global-teardown.ts` swallows cleanup failures with
a log. If the C6 spec seeds its own users with addresses outside the `e2e-%@test.local` prefix,
they fall outside `cleanup()`'s scope and survive a failed run.

Question — does C6 reuse the existing `TEST_USERS` and `.auth-state.json`, or add its own seed?
What would close it: "reuse `TEST_USERS.vaultReady` and `injectSession`; add no new seed", which
leaves the cleanup member set unchanged so the next setup's leading `cleanup()` reclaims
everything even when teardown swallows a failure. If a new seed is added, match the
`e2e-%@test.local` prefix and record the reason against `helpers/db.ts`'s cleanup scope.

### F16 — Minor: "zero violations" has no triage path and the CSP differs between subjects (R53)

FR1 is an absolute zero with no defined handling for violations that are not the app's. And the
policy itself differs across environments: the measured production server emits
`connect-src 'self' https://o4511064424185856.ingest.us.sentry.io`, while the CI E2E job's env
carries no `NEXT_PUBLIC_SENTRY_DSN`, so `csp-builder.ts`'s `sentryConnectSrc()` yields
`connect-src 'self'`. The local red proof and the CI gate are not looking at the same policy.

Fix — include each violation's `sourceFile` / `blockedURI` in the output; count violations from
outside the app origin separately as `CSP_GATE_FOREIGN_VIOLATION` but fail on them by default,
with exceptions only via an explicit commented allowlist. Allow side: a known allowlisted
third-party violation still passes when app-origin violations are zero. Red-prove: ① inject one
simulated third-party violation → red without the allowlist, green with it, ② empty the
allowlist → everything reds. Undecidable: a violation with an empty `sourceFile` counts as
app-origin (fail side). Preserve FR1's absolute-zero posture — the allowlist is a register of
exceptions, not a relaxation. Boundary: the violation's `sourceFile` origin; unknown resolves to
app. Also either assert in I6.1 that the CSP string matches between CI and local, or record in
the plan why it does not.

### F17 — Minor: C7's acceptance yields no failable assertion

`src/__tests__/csp-header.test.ts:27-29` asserts the literal `http://[::1]:*` is present in the
header string. Since the plan keeps the literal in the header, that assertion stays green after
the change — only the test name and a comment move. Nothing that can fail on the new fact
("Chromium discards it") is added, so I7.1 would be satisfied by a rename.

Fix — add a case to C6 that navigates a real `form-action` submission to
`http://[::1]:<port>` and asserts Chromium **blocks** it, with the allow side that
`http://127.0.0.1:<port>` succeeds on the same path. Red-prove: ① drop `http://127.0.0.1:*`
from the directive → the allow side reds, ② should a future Chromium start honouring the IPv6
literal → the deny side reds, which is the point. Undecidable: the loopback server does not
start → `FORM_ACTION_PROBE_UNAVAILABLE`, never a skip. Preserve the literal in the header (the
plan's decision). Boundary: how Chromium interprets `form-action`; string matching is outside it.

## Adjacent Findings

- F3 `[Adjacent] Critical` — shipping an unpatched sonner in the production image (routed to
  Functionality, which did not run this round; carried to Round 2).
- F12 `[Adjacent] Major` — whether CSSOM-applied styles are genuinely outside `style-src-attr`
  (routed to Security, which did not run this round; carried to Round 2).

## Ollama pre-screening findings

### P1 — Major: C1's scope omits `src/app/s/layout.tsx`

C1 names two files as nonce sources but I2.1's own derivation identifies a third layout. The
plan never confirms whether `s/layout.tsx` contains a `NextThemesProvider`; scenario 5
exercises the share layout for toasts but is silent on theme.

Orchestrator note: read directly — `src/app/s/layout.tsx` renders `NextIntlClientProvider`,
`children` and `Toaster`, and has **no** `ThemeProvider`. C1 correctly excludes it; the plan
must record that negative finding rather than leave it inferable.

### P2 — Major: C4's covered-module set is explicitly deferred to implementation

I4.3's member set is left unenumerated with the note "must be run during implementation". For a
plan whose objective is zero violations, the primary mechanism for V2 has unknown blast radius
at planning time. Converges with Testing F10, which additionally shows the specified derivation
is undecidable.

### P3 — Minor: C5's `global-error.tsx` has no defined fallback if R3's verification fails

R3 says to verify that moving `global-error.tsx`'s inline styles to a stylesheet works when the
root layout has thrown. If it does not, the forbidden pattern still applies to that file and the
escalation clause covers only third-party code. Converges with Testing F12, which proposes the
same allowlist remedy.

## Quality Warnings

- The Testing expert's `## Recurring Issue Check` does not use the R1-R57 catalogue's rule
  names and does not discharge the per-rule obligation. See the execution record above.
- The Testing expert's F2 claim about `check-gate-selftest-coverage.sh`'s member set was not
  re-derived by the orchestrator and is carried as unverified.

## Orchestrator findings (not from an expert)

### O1 — Major: `instrumentation-client.ts` is in no CI paths filter

`ci.yml`'s `app` filter lists `instrumentation.ts` but not `instrumentation-client.ts`, which
exists at the repository root. The revised plan moves C2's `setNonce` and C4's `z.config` into
that file, so after the revision a change to the single module both contracts depend on would
trigger no app job. Same class as Testing F11; same remedy (extend the `app` filter).

Derivation: `sed -n '30,95p' .github/workflows/ci.yml`; `ls instrumentation-client.ts`.

### O2 — the originating handoff's mechanism is refuted, and the plan must keep saying so

Recorded so a later round does not re-adopt it: Next.js copies every middleware response header
onto the request headers (`node_modules/next/dist/server/lib/router-utils/resolve-routes.js`,
the `resHeaders[key] = value; req.headers[key] = value;` pair), and `app-render.js:209` extracts
the nonce from the request `content-security-policy` through `getScriptNonceFromHeader`. The
proposed `page-route.ts` change and the `csp-nonce` cookie removal are both unnecessary and are
recorded as SC2 / SC3.

## Recurring Issue Check

### Functionality expert

Not delivered — the sub-agent was cancelled before producing output. No R1-R57 evidence exists
for this perspective in Round 1.

### Security expert

Not delivered — same. No R1-R57 or RS1-RS6 evidence exists for this perspective in Round 1.

### Testing expert

Recorded verbatim as produced. **See the Quality Warning above: the rule names below do not
match the R1-R57 catalogue and this block does not discharge the per-rule obligation.**

- R1 (単一責務 / 過剰抽象): N/A — 実装構造は scope 外
- R2 (命名): Checked — no issue
- R3 (エラーハンドリング): Finding F1, F14（判定不能経路の refusal 未定義）
- R4 (不変性): N/A — scope 外
- R5 (境界での入力検証): N/A — scope 外
- R6 (認可位置): N/A — Security expert の scope
- R7 (injection): N/A
- R8 (秘密情報のコミット): Checked — no issue（plan は hex64 を placeholder 表記）
- R9 (ログ衛生): Checked — no issue
- R10 (依存の所有): Finding F3, F4（patch-package という新規依存の実効性）
- R11 (テストの失敗可能性): Finding F2, F13, F17
- R12 (1 テスト 1 概念): Checked — no issue
- R13 (モック境界): Finding F10（ソース grep をクライアント判定の代理にしている）
- R14 (観測可能な振る舞いの assert): Finding F14
- R15 (クリーンな初期状態): Finding F15
- R16 (dev/CI parity): Finding F5, F6, F16
- R17 (sleep / race): Finding F7
- R18 (SemVer / bump): N/A
- R19 (commit prefix): N/A
- R20 (release フロー): Checked — no issue
- R21 (sub-agent 残渣 grep): N/A — 本レビューは読み取りのみ
- R22 (plan の置き場所): Checked — `docs/archive/review/` に配置済み
- R23 (虚偽の技術的理由付け): Finding F12（"CSP applies the same" の根拠が検証形になっていない）
- R24 (未依頼の仕様変更): Checked — no issue（SC1-SC3 で明示的に scope out）
- R25 (pre-pr の実行): Checked — `scripts/pre-pr.sh` は Playwright を走らせない（`check-e2e-selectors.sh` のみ）。C6 が CI 専用である点は F6/F11 に計上
- R26 (silent-when-healthy gate): Finding F2
- R27 (event dispatch tx 境界): N/A
- R28 (Tailwind 標準パレット): N/A — C5 の class 変換は padding/size のみ
- R29 (prisma generate): N/A
- R30 (破壊的 docker 操作): Checked — no issue
- R31 (個人メール): Checked — no issue
- R32 (トークン列挙): N/A
- R33 (複数 CI 設定): Finding F3, F11 — `--ignore-scripts` は 5 ファイルに分散、`patches/**` はどの filter にも無い
- R34 (const-object): N/A
- R35 (aria-label 誤一致): Checked — no issue（ただし F14 が近接）
- R36 (内部用語の露出): N/A
- R37 (breaking change の早計な採用): Checked — no issue
- R38 (sub-agent 所見のフィルタ): N/A
- R39 (partial vi.mock): Checked — no issue（C6 は E2E、unit 側は F13 に計上）
- R40 (git stash): N/A
- R41 (Phase 3 review 必須): N/A — 本稿は Phase 1
- R42 (member set 完全性): Finding F8, F9, F10 — I2.1 / I1.2 / I4.3 の 3 つを実行し、いずれも記載と不一致。I5.1 のみ実行結果が記載と一致（17 hit / 9 サイト）
- R43 (class 形状の所見の再導出): Checked — F12 で C5 の class を SSR 出力ベースに再導出するよう提案済み
- R44 (終了ステータスの lossy 伝達): Finding F7 — retry による flaky-green
- R45 (server null⇒default の分散契約): N/A
- R46 (env/config を読んでから infra を疑う): Checked — 本レビューで `NEXT_PUBLIC_BASE_PATH` / `CSP_MODE` / Sentry DSN を実読（F5, F16）
- R47 (CI 失敗のクラス診断): N/A
- R48 (兄弟 gate を先に読む): Checked — `check-gate-selftest-coverage.sh` と `check-e2e-selectors.sh` を実読（F2）
- R49 (JSON round-trip の tautology): N/A
- R50 (検証の前提条件): Finding F1, F5, F6
- R51 (gate を名前で引用しない): Checked — 本稿では member set を実行して引用
- R52 (禁止パターンが自分の修正にマッチしないこと): Finding F9, F12
- R53 (数値閾値の headroom): Finding F16
- R54 (class は membership を与えるが failure mode は与えない): Finding F10
- R55 (AST gate の scope 認識): Checked — F9 の remedy で ts-morph AST 化を提案
- R56 (自らの defect を生む round): N/A
- R57 (収束したレビュアの共通盲点): Checked — F12 を Security 側と交差確認するよう adjacent フラグ済み
- RT1 (mock-reality 乖離): Finding F10, F13
- RT2 (テスト名): Checked — no issue
- RT3 (assertion 順序): Finding F1, F14
- RT4 (テスト冗長性): Checked — no issue
- RT5 (本番プリミティブを call path に含む): Checked — ただし F3 と F5 で被験体が本番と異なる
- RT6 (fixture の現実性): Finding F15
- RT7 (新規 guard は失敗できることを証明): Finding F2, F6, F12, F13, F17
- RT8 (denial-path が mutation を assert しない): Finding F1, F14
- RT9 (parallel-implementation twin drift): Checked — gate が authority。ただし F10 により C4 の unit 側が測定不能な対象を測っている
- RT10 (deny 側のみの guard): Finding F2
- RT11 (fixture の後始末 / 次回への漏出): Finding F15

---

# Plan Review: prod-csp-violation-zero — Round 2
Date: 2026-09-26
Review round: 2
Subject: plan revision 2

## Changes from Previous Round

Revision 2 rewrote the plan against Round 1: C2 and C4 moved to `instrumentation-client.ts`,
C3 gained the `Dockerfile` step and the I3.3 install-path table, C4's source-grep derivation was
withdrawn for a build-artifact scan, C5's subject moved from JSX source to served HTML, C6 gained
I6.2-I6.6, and C8 was added. All three experts ran this round; Functionality and Security saw the
plan for the first time.

## Round-2 result in one line

**40 findings (7 Critical / 21 Major / 12 Minor), and not one of them is against the design.**
Every Critical targets the plan's own specification of a verification mechanism — a scan whose
subject does not exist, a pattern that matches nothing, a placement with no input, a clause with
no red proof. Six of the seven target text introduced by revision 2 itself.

## Functionality Findings (revision 2, first pass)

Verified correct by re-derivation, and therefore not findings: the Next.js middleware-header copy
(`resolve-routes.js:458-464` + `app-render.js:209-210`, measured 18/18 external and 15/16 inline
nonced scripts); the synchronous instrumentation `require` ahead of `appBootstrap`;
`VisuallyHidden.Root` inside a closed `Sheet` at both call sites and 0 `style="` in served signin
HTML; the 17-hit/9-site `style={` member set reproducing the plan's table exactly; sonner's
`__insertCSS` byte-identical in `.mjs` and `.js` with the rewrite expressible as two hunks;
`MAX_FOLDER_DEPTH = 5` (`src/lib/validations/common.server.ts:222`) and icon sizes {12,16,20,28}
bounding C5's conversions; `check-gate-selftest-coverage.sh`'s member set.

- **F-F1 — Critical: C4's I4.3 scan measures bytes the fix cannot change.**
  `z.config({ jitless: true })` is a *runtime* flag — `zod/v4/core/util.js:219-221` reads
  `if (globalConfig.jitless) return false;` *before* the probe, and `globalConfig` is
  `globalThis.__zod_globalConfig` (`core.js:135-140`). Setting it changes which branch executes;
  it cannot remove `Function("")` from the emitted chunk. Both stated red-proofs produce
  byte-identical output before and after their mutation, so the measurement cannot differentiate
  and is not evidence. This is the control on which revision 2 upgraded C4 to
  `fail-closed verification gate` (R49), and it *replaced* Round-1 F10's remedy — which had two
  clauses, of which revision 2 adopted the unsatisfiable one ("zero `Function(`") and dropped the
  workable one ("a marker showing the jitless configuration is reachable"). Fix: scan for the
  marker the fix actually emits (the jitless-setting site, asserted present in an entry chunk the
  served HTML loads), keep C6's Chromium eval assertion as the authority, and name
  `ZOD_JIT_MARKER_UNRESOLVABLE` distinctly from the 0-hit failure.
- **F-F2 — Major: the Docker `deps` stage has no `patches/`.** `Dockerfile:13-14` copies only
  `package.json package-lock.json .npmrc`; the first `COPY . .` is in `builder` (`:76`). The step
  as placed applies zero patches and does not fail. Also: the runner copies only `public`,
  `.next/standalone`, `.next/static`, `prisma` and the prisma-cli closure (`:103-110`) — it never
  copies `node_modules/sonner`, so the marker's subject cannot be that file if the stated boundary
  ("the shipped artifact is authoritative") is to hold.
- **F-F3 — Major: `get-nonce` is not a declared dependency.** It appears only as a transitive of
  `react-remove-scroll` / `react-style-singleton` (`package-lock.json:15619`). C2's whole
  mechanism is "write a module global another package reads"; a second hoisted copy makes it
  silently no-op and nothing in the build or the type-checker fails. The repo has no
  undeclared-dependency gate.
- **F-F4 — Major: replacing `CI` on `webServer.command` regresses the CI E2E job to a dev server.**
  Converges with Testing F23.
- **F-F5 — Major: I1.2 conflates two predicates.** `layout.tsx:16`'s JSX attribute is a
  `StringLiteral` and matches the prescribed AST derivation, but is absent from the target set;
  `dynamic-styles.ts:14`'s literal is `'meta[name="csp-nonce"]'`, whose *value* is not
  `csp-nonce`, so under a value predicate the stated "current set" is 2 files, not 3. Split into
  two invariants with one allowlist each. Converges with Security F-S6.
- **F-F6 — Major: C3's NFR4 forbidden pattern matches nothing.** Red-proved against a scratch
  copy with `RUN npm ci --ignore-scripts` rewritten to `RUN npm ci`: 0 matches. Converges with
  Testing F34, independently red-proved by both.
- **F-F7 — Major: the three new scans have no file, no invocation point, and any landing under
  `scripts/checks/` fails `check-gate-selftest-coverage.sh`.** Converges with Testing F18. Adds:
  C4's scan needs `.next/static/**`, which only exists after `pre-pr.sh:926`'s `Build` step, so
  its queue position is load-bearing.
- **F-F8 — Major [Adjacent]: C4's node-environment test contradicts C4's own no-guard signature.**
  Without a guard, importing the module under `environment: "node"` sets
  `globalThis.__zod_globalConfig.jitless = true` — a process-wide global, so the flag also leaks
  across vitest files sharing a worker. And a root-level test file matches none of
  `vitest.config.ts:8-13`'s includes.
- **F-F9 — Major [Adjacent]: C7's deny and allow cases are on different address families.** A
  server bound to `127.0.0.1` satisfies "the loopback server started" while `[::1]` refuses the
  connection, and a refused navigation is indistinguishable from a CSP block unless the assertion
  is on the `securitypolicyviolation` record itself.
- **F-F10 — Major: C2's ordering is labelled `fail-closed verification gate` but nothing verifies
  it (R49).** The parenthetical describes loud failure when the module throws, which is a
  different property from verifying the ordering. Either relabel to `detection or audit only` with
  C6 as sole adjudicator, or add a build-manifest entry-membership assertion.
- **F-F11 — Minor: I3.3's table is not the set its stated derivation returns** (17 rows, 7
  listed). The conclusion is right; the table is not re-runnable. It also hides that C3 attaches
  a `--error-on-fail` lifecycle hook to nine more CI jobs, including `ci-integration.yml` and
  `refactor-phase-verify.yml`, which have no relationship to sonner.
- **F-F12 — Minor: `ci.yml:39`'s `instrumentation.ts` filter entry matches no file** (the tree has
  `src/instrumentation.ts`, covered by `src/**`, and root `instrumentation-client.ts`). C8's cell
  implies a deliberate asymmetry the filter does not express.

## Security Findings (revision 2, first pass)

**No Critical findings; no escalation.** Every CSP-semantics claim was executed against the
running production server and against purpose-built policy pages, not reasoned.

Settled by measurement, and therefore *not* findings — recorded because the answers are the
review:

- **The `<meta name="csp-nonce">` carrier does not defeat nonce-based CSP.** An
  `innerHTML`-injected `<script>` does not execute, so an HTML-injection-only attacker cannot read
  the meta at all. A script-executing attacker already reads the nonce from
  `document.querySelector('script').nonce` and, under `'strict-dynamic'`, can append a nonce-less
  inline script that runs (measured: `inlineNoNonceRan: true`, zero violations). The one channel
  unique to the meta — CSS attribute-selector exfiltration — was built and did not fire:
  `meta[content^="X"]` matches and `script[nonce^="X"]` does not (nonce-hiding), but `<head>`
  children are outside the render tree so `background-image` is never fetched.
- **No client-supplied-header attack path.** `curl -H "Content-Security-Policy: script-src
  'nonce-AAAAATTACKER'"` -> the response CSP and all 35 in-page nonces carry the server's fresh
  nonce; `AAAAATTACKER` appears nowhere. `next.config.ts`'s static `headers()` deliberately carries
  no CSP, so a matcher-bypassing path gets no response CSP at all. Cookie-forcing
  (`Cookie: csp-nonce=ATTACKERFORCEDVALUE`) also fails: the middleware's own `Set-Cookie` wins the
  same-request Server Component read. **RS5 closed by measurement.**
- **NFR1 holds structurally.** `printf '' | openssl dgst -sha256 -binary | base64` ->
  `47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=`, so the plan's identification is correct. One CSP
  emitter only (`security-headers.ts:42`); no `'unsafe-hashes'`, no `style-src-attr`, no
  report-only; `CSP_MODE` is un-broadenable (`env-schema.ts:295` is `z.enum(["strict","dev"])` and
  `csp-builder.ts:38` forces `strict` in production).
- **A root `postinstall` does not undermine `--ignore-scripts`.** That flag suppresses the root
  project's own lifecycle scripts too, which is exactly why C3 needs the explicit Docker step; in
  the 9 plain-`npm ci` jobs dependency install scripts already run, so the root hook adds no new
  trust.
- **C2's `fail-closed` ordering upgrade is honest** — both bootstraps (`app-next.js`, webpack, the
  production one, and `app-next-turbopack.js`) `require` the instrumentation module at module
  scope, synchronously, unconditionally, before `appBootstrap`, with no `try`/`catch`.
- **R29 spot-checks confirmed**: nonces do not apply to style attributes;
  `el.style.setProperty` applies with zero violations while `el.setAttribute('style', ...)` is
  blocked; a `<style>` nonced with the initial meta value and inserted long after `networkidle`
  applies. The cross-navigation half of the "CSP is fixed at initial load" claim could not be
  exercised (the signin page has no in-app anchors) and is recorded as unmeasured.
- **C7 confirmed and then some**: Chromium logs *"contains an invalid source: 'http://[::1]:*'. It
  will be ignored"* **on every production page load**, not only on a synthetic page.

Findings:

- **F-S1 — Major: I4.3's scan is unsatisfiable, and the client tree holds a second codegen site
  the baseline missed.** `.next/static/chunks/0cz1d0mv5g_q7.js` carries a core-js `globalThis`
  probe (`||function(){return this}()||Function("return this")()`), which V2's baseline attributes
  to Zod alone. Remedy proposed: an allowlist keyed by justification. **Orchestrator note: this
  finding shares F-F1's refuted premise** — it states `z.config` "removes" the zod site, which
  F-F1 proves it does not. The finding's *first* half (a second, non-zod codegen site exists, and
  the baseline's V2 attribution is incomplete) stands and is new; its remedy does not.
- **F-S2 — Major: C3's Docker step is in a stage with no `patches/`, exits 0, and is not
  hermetic.** Converges with F-F2 and Testing F19/F20, and adds: `npx patch-package` falls back to
  a registry fetch when the binary is absent from `node_modules/.bin`, while every other tool in
  this Dockerfile is exact-pinned with a fail-closed directory probe (`TAR_DIR`, `PICOMATCH_DIR`,
  `SIGSTORE_DIR`, `BE_DIR`, `PACOTE_DIR` all `exit 1` on a missing path). Three distinct refusals
  wanted: `SONNER_PATCHES_DIR_EMPTY`, `SONNER_PATCH_TOOL_MISSING`, `SONNER_PATCH_UNVERIFIABLE`.
  Also: `patch-package`'s transitive closure will now execute inside the image build, in the one
  place `--ignore-scripts` guaranteed no dependency code ran — an accepted cost that must be
  written down as one, with a defined review procedure for the patch file itself.
- **F-S3 — Major: the meta carrier voids HTML's nonce-hiding, and revision 2 entrenches it for
  three consumers on a rationale that argues for the *value*, not the *carrier*.** Measured: all
  33 `<script nonce>` serialise as `nonce=""` and are not matched by `script[nonce^=...]`, while
  `<meta name="csp-nonce" content>` serialises in clear and *is* matched by `meta[content^=...]`.
  `document.querySelector('script[nonce]')?.nonce` returns the real nonce with no server change,
  is available to all three consumers including a dependency patch, and — decisively — **also
  works on `src/app/global-error.tsx`**, which renders its own `<html><body>` with no `<head>` and
  therefore no meta. Not exploitable today; the defect is an unargued, unrecorded design choice on
  the plan's most load-bearing decision. Fix: read the IDL property first, fall back to the meta,
  add "no new disclosure of the nonce outside a nonce attribute" to NFR1, and record the residual
  risk in `docs/security/threat-model.md` §5 item 7.
- **F-S4 — Minor: I3.1's stated reason is refuted by execution, and the clause that actually
  carries the CSP weight is a different one.** Under `style-src 'sha256-47DEQ...'` alone, Chromium
  **re-checks on content mutation** and blocks the filled element naming the hash of the final
  text — so the empty-string hash does *not* admit any inject-then-fill element. What does matter:
  setting the nonce **before** `appendChild` yields zero violations, while appending empty and
  noncing after yields one `style-src-elem` violation at insertion. So the patch's clause (b) is
  load-bearing and (c) is diagnostic. The prohibition itself stays (NFR1, and Chromium's re-check
  is an implementation behaviour not to be relied on across engines) — only its recorded reason
  changes.
- **F-S5 — Major: DCR still registers `[::1]` redirect URIs the CSP discards (R48).**
  `src/lib/constants/auth/mcp.ts:117`'s `LOOPBACK_REDIRECT_RE` accepts `[::1]`, and
  `csp-builder.ts`'s own comment states every host it accepts MUST be in `form-action` "otherwise
  the consent flow appears to succeed but the browser blocks the final redirect after the audit
  log has already been written". Two adjudicators decide one predicate by different semantics, and
  the audit trail believes the permissive one. C7 as written only asserts the block; it leaves the
  registry wider than the enforcement.
- **F-S6 — Minor: I1.2's target set drops `layout.tsx`.** Converges with F-F5, and adds the node
  kinds the scan must match (`StringLiteral` / `NoSubstitutionTemplateLiteral` / JSX string
  attribute) and that the match must be on `csp-nonce` as a *substring*.
- **F-S7 — Minor: I2.2's "exactly one meta reader" becomes false the moment C3 lands**, and the
  scan root silently decides which way it fails. Restate as "exactly two, both named", set the
  root to the repository, make the patch file an allowlisted member.
- **F-S8 — Minor [Adjacent]: the consolidated memoized read caches `null` permanently.**
  `dynamic-styles.ts:6` memoizes the `null` result; C2 moves that memo earlier and shares it across
  three consumers and two more page classes, including `global-error.tsx` where no meta exists.
  Memoize only a non-null result; assert the query count with a spy so "drop the memo" is not the
  fix.
- **F-S9 — Minor [Adjacent]: I6.5 omits `global-error.tsx`**, the one reachable page that both
  violates by design (four allowlisted `style=` attributes) and has no nonce carrier. Either add
  it with its violation count pinned as an exact non-zero baseline, or record it as a named
  exception with the count and a `threat-model.md` entry.
- **F-S10 — Minor (question): I5.2's "30 distinct literal style objects" is not reproducible as
  written** — an equivalent scan returns 43 over 533 files. Different patterns, so not a
  refutation. What closes it: the exact command inline in I5.2 plus the member list.
- **F-S11 — Minor: C2/C4 cite the Turbopack bootstrap; production uses `app-next.js`.** The
  conclusion holds on both — cite both so a future Next.js upgrade is checked against the right
  file.

## Testing Findings (revision 2, incremental)

Round-1 disposition: F1, F4, F7, F8, F9, F11, F13, F14, F15, F17 **resolved**; F2, F5, F6, F12,
F16 **partially resolved**; F3, F10 **resolved by a change that introduced new problems**. F2's
unverified half is now settled: `check-gate-selftest-coverage.sh`'s member set is
`ls scripts/checks/*.sh *.mjs` plus inline `run_step "Static: ..."` in `pre-pr.sh`, and
`e2e/tests/*.spec.ts` is outside it — the Round-1 Quality Warning can be closed. F3's
orchestrator correction (one remediation site, not five) was independently re-derived and
**confirmed**.

New findings F18-F34. Criticals: **F20** (C3's marker assertion names no subject, and
`.next/standalone/node_modules` contains no `sonner` — the traced closure has `@sentry`, `pg`,
`ioredis`; sonner is bundled, not traced — so the gate resolves only to its own refusal branch);
**F22** (a Playwright *project* cannot supply a basePath: `NEXT_PUBLIC_*` is inlined at build
time, a run has one `webServer` and one process env, and `e2e/helpers/auth.ts:13-18` resolves the
cookie *name* from the same variable — so red-prove (7) needs two servers live in one run and
cannot execute); **F23** (the `CI`->flag swap regresses all 36 existing specs onto `next dev` in
CI); **F26** (I6.4 and I6.6 have no red proof, and F16's CSP-parity clause was dropped without a
decision — I6.6 is the more dangerous because it is a *classifier*); **F28** (the `Function(`
pattern: 6 hits, 4 of them `mappingFunction(` substring false positives, and the server-side allow
clause is satisfied by 47 unrelated files); **F29** (C5's "In SSR HTML by default?" column is
unmeasured and wrong for all six "yes" rows — `sidebar-shared` folder rows come from a client hook
that fetches in an effect, `favicon`/`entry-icon` render inside a client-decrypted vault list, and
`src/components/folders/folder-tree.tsx` **has no importer at all**: all six references are
`import type { FolderItem }`. It is C5's only deny red-prove subject. Measured: `style="` count is
**0** on the production server today with none of C5 implemented).

Majors: F18 (the plan's four new scans land *inside* `check-gate-selftest-coverage.sh`'s member
set — the open item defers the smaller half of the question), F19 (Docker stage placement), F21
(`--error-on-fail` covers a patch that fails to *apply*; `package.json:97` declares `^2.0.8`, so a
2.0.9 leaving `__insertCSS`'s context untouched applies cleanly and exits 0 — pin the version
exactly, as `Dockerfile:59-62` already does for prisma), F24 (no workflow invokes the gate), F25
(the 1243 red proof is network-gated and the plan records no consequence), F27
(`instrumentation-client.ts` is referenced by two scripts and no test or gate; `vitest.config.ts`
cannot even collect a file beside it), F30 (C4's unit pair has no admissible location), F31
(**C8's undecidable clause is answered by `ci.yml:497-503` and the answer is the opposite of the
assumption — an empty `needs.changes` output *skips* the e2e job; `always()` defeats the
skip-on-failed-dependency default but supplies no outputs**).

Minors: F32 (the class conversions name no bound and add no test at bound+1 while rewriting the
tests that pinned the geometry — `sidebar-shared.test.tsx:152` asserts `paddingLeft: "24px"`,
`favicon.test.tsx:59,72,80` assert sizes 16/28/12), F33 (question: does `patch-package` clear
`npm audit signatures`? The licence and vulnerability gates verified not to apply —
`check-licenses.mjs:29` defaults `includeDev: false`, `npm audit --omit=dev`).

**F34 — Critical**, red-proved by mutation on a scratchpad copy: C3's `--ignore-scripts` forbidden
pattern produces **no match** on a `Dockerfile` with `RUN npm ci --ignore-scripts` rewritten to
`RUN npm ci`. Independently red-proved by Functionality as F-F6.

Mutation hygiene: the Testing expert performed its only mutation on `<scratchpad>/Dockerfile.mut`,
a copy; `git status` on the repository was unchanged.

## Adjacent Findings

- F-F8, F-F9 -> Testing (unit-test placement; the form-action deny/allow pairing).
- F-S8, F-S9 -> Functionality / Testing (the memo's runtime consequence; route-table composition).
- Testing F19 -> Functionality (the correct Dockerfile stage).
- Testing F34 -> Security (whether `--ignore-scripts` remains a supply-chain control once an
  explicit `npx patch-package` step sits beside it). Security answered it in the affirmative.

## Quality Warnings

- **Two of three experts converged on a refuted premise.** Testing F28 and Security F-S1 both
  propose remedies that assume `z.config({ jitless: true })` changes the emitted bytes. It does
  not (`zod/v4/core/util.js:219-221`). Functionality F-F1 is the only correct reading, and it is
  the one adopted. Recorded because the majority was wrong: a 2-of-3 convergence is not evidence.
- Both Testing and Functionality red-proved the dead `--ignore-scripts` pattern independently and
  by execution on scratchpad copies. That convergence *is* evidence.

## Saturation assessment (Round 2)

Against the four criteria:

1. **At least two rounds completed** — yes.
2. **No Critical or Major open** — **fails.** 7 Critical, 21 Major.
3. **No finding against the design itself** — **holds.** Zero findings this round challenge the
   contracts, the control classes, or the adequacy of the acceptance criteria as *goals*. The
   design (hand the existing nonce to four injectors, patch sonner, let Chromium adjudicate) is
   unchallenged by all three experts, and Security's measurements positively confirmed its
   load-bearing premises.
4. **Remaining Minors are prose-only or execution-reachable** — mixed.

Saturation therefore does **not** fire. But the shape of the failure is diagnostic rather than
ordinary: the plan is at ~470 lines specifying exact grep patterns, exact Dockerfile line numbers,
exact allowlist sets and exact red-prove mutation lists, and Round 2's Criticals are almost
entirely findings that *those exact specifications are wrong* — F20's subject does not exist,
F22's mechanism cannot express a basePath, F23's condition swap regresses 36 specs, F26's clauses
lack proofs, F28/F-F1's pattern cannot differentiate, F29's column was asserted not measured,
F34/F-F6's regex matches nothing. Six of the seven target text introduced by revision 2 itself.

That is the plan-granularity failure mode: past the point where the design is settled, each round
of added specification becomes the next round's defect surface. The remedy is not a Round 3 at the
same granularity — it is a shorter revision that states obligations and acceptance criteria and
lets execution settle the mechanisms, which is Phase 2's job.

## Recurring Issue Check

All three experts supplied a Round-2 `## Recurring Issue Check` over the real R1-R57 catalogue
(plus RS1-RS6 / RT1-RT11). The Round-1 Quality Warning about invented rule names does not recur.
Rules that fired this round, by expert:

- **Functionality**: R3 (F-F5, F-F7), R16 (F-F4), R18 (F-F5, F-F12), R29 (F-F1, F-F5, F-F11,
  F-F12), R33 (F-F11, F-F12), R34 (F-F12), R41 (F-F1, F-F2, F-F3, F-F7), R42 (F-F5, F-F11), R47
  (F-F6, F-F1), R49 (F-F1, F-F10), R50 (F-F2, F-F7, F-F9). All others Checked or N/A.
- **Security**: R1 (F-S7), R3 (F-S3, F-S9), R9 (F-S5), R17 (F-S3), R18 (F-S5), R25 (F-S8), R29
  (F-S4, F-S10, F-S11), R34 (F-S5), R36 (F-S1), R38 (F-S8), R41 (F-S2), R42 (F-S1, F-S6, F-S7,
  F-S9), R44 (F-S2), R47 (F-S1), R48 (F-S5), R49 (F-S1), R52 (F-S8), R53 (F-S9), R55 (F-S8).
  RS5 closed by measurement; RS1/RS2/RS6 N/A; RS3/RS4 Checked, no issue. All others Checked or N/A.
- **Testing**: R3 (F29), R16 (F23, F26), R18 (F18), R29 (F28, F29, F31), R33 (F22, F24), R34
  (F29), R41 (F20, F22, F24, F30), R42 (F29, F28, and the I3.3 table's 17-vs-7 row gap), R44
  (F26, F31), R47 (F28, F34), R49 (F20, F29, F28), R50 (F19, F20, F25), R52 (F18), R53 (F28,
  F29), RT1 (F30), RT2 (F22, F29), RT4 (F26), RT5 (F20, F23), RT6 (F27, F30), RT7 (F18, F20, F26,
  F28, F29, F34), RT8 (F29), RT10 (F26). All others Checked or N/A.

---

# Phase 2: RT7 red proof (C6 Go/No-Go precondition)
Date: 2026-09-27

Subject: the unfixed tree at commit `bbe8d4a57` plus `e2e/tests/csp-strict.spec.ts` and the
additive `webServer` condition (the gate itself; no C1-C5 fix applied).

Environment, recorded because the plan's Go/No-Go precondition is about exactly this:
- **Chromium revision 1243** — the pinned revision, installed for this run. Playwright resolves
  it with no `executablePath`; `chromium.launch()` reports `153.0.8010.12`. The Round-1/2 baseline
  was taken on 1234; this retake satisfies F25/F6.
- Production build (`npm run build`, `NODE_ENV=production` via `next start`), `NEXT_PUBLIC_BASE_PATH=""`,
  served on `http://localhost:3010`. Ports 3000/3001 are held by the developer's own dev servers
  and were left alone.
- Throwaway database `passwd_sso_e2e`, migrated, seeded by the existing `e2e/global-setup.ts`
  (13 users, no new seed — VEC2/F15). Teardown reported clean.

Result: **1 passed, 7 failed.**

The one that passed is the collector self-test (I6.3) — deny arm caught exactly one violation for
a deliberately nonce-less `<style>`, allow arm caught zero for a nonce'd one. The collector is
therefore proven working, which is what makes the seven failures evidence rather than noise.

| Route | Violations | Classes |
|-------|-----------|---------|
| signin (ja), signin (en), privacy-policy, recovery, vault-reset | 6 each | V1 + V2 + V3×2 + V4×2 |
| authenticated dashboard, vault unlocked | 6 | same |
| Radix overlay mounted | 7 | same + V5 |

Per-violation, as Chromium reported them on `signin (ja)`:

```
script-src-elem blocked=inline @ /ja/auth/signin:1                        V1 next-themes ThemeScript
script-src      blocked=eval   @ /_next/static/chunks/10cj059i6ixww.js:2  V2 zod allowsEval probe
style-src-elem  blocked=inline @ /_next/static/chunks/3zxjnyd3ib8fc.js:2  V3 sonner __insertCSS
style-src-elem  blocked=inline @ /_next/static/chunks/3zxjnyd3ib8fc.js:2  V3 (second call)
style-src-elem  blocked=inline @ /_next/static/chunks/10kv_yuy5ij-o.js:2  V4 next-themes transition
style-src-elem  blocked=inline @ /_next/static/chunks/10kv_yuy5ij-o.js:2  V4 (second)
```

and the overlay route adds:

```
style-src-elem  blocked=inline @ /_next/static/chunks/20rkjkzx4rp17.js:2  V5 react-style-singleton
```

## C5 is settled by this run: V6 does not exist

**Not one `style-src-attr` violation was reported on any route**, including the authenticated
dashboard with the vault unlocked, the sidebar rendered and the password list populated — the
exact page whose `sidebar-shared.tsx`, `folder-tree.tsx`, `favicon.tsx` and `entry-icon.tsx`
sites revision 2 listed as "yes, in SSR HTML by default".

This is stronger evidence than counting `style="` in the served HTML, because a style attribute
that reached the parser *would* have produced a `style-src-attr` violation and none did. Round-2
F29 was right and revision 2's table was wrong on all six rows.

**Disposition of C5**: no conversions. `sidebar-shared.tsx`, `folder-tree.tsx`, `favicon.tsx`,
`entry-icon.tsx`, `tag-dialog.tsx` and `password-generator.tsx` are left untouched — converting
them would change working markup for a violation class that does not occur, and F29's own remedy
says not to manufacture a deny clause by converting a site that cannot violate. The gate's route
table keeps the count at zero. `src/components/folders/folder-tree.tsx` remains dead code and
remains SC4.

## Fixes this red proof licenses

Each of V1-V5 now has an observed failing state, so each fix has something to turn green:

| Class | Contract | Turns green when |
|-------|----------|------------------|
| V1, V4 | C1 | `ThemeProvider` receives the request nonce |
| V2 | C4 | `z.config({ jitless: true })` runs before the first client-side parse |
| V3 | C3 | the sonner patch sets the nonce before insertion |
| V5 | C2 | `setNonce` is primed from the document nonce in `instrumentation-client.ts` |
| V6 | C5 | already zero — nothing to do |
