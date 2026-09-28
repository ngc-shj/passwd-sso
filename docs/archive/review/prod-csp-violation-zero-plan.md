# Plan: prod-csp-violation-zero

Eliminate every Content-Security-Policy violation the application produces against its own
strict production CSP, without weakening the policy.

**Revision 3 (2026-09-26).** Deliberately shorter than revision 2. Two review rounds produced 57
findings and **not one against the design** — every Critical was a defect in the plan's own
specification of a verification mechanism, and six of Round 2's seven targeted text revision 2
had just added. Past the point where the design is settled, added specification is the next
round's defect surface. This revision states what must be true and what must be proven; it does
not state which regex, which Dockerfile line, or which allowlist entry. Those are settled by
execution in Phase 2, against the acceptance criteria below.

The findings and their litigation live in `prod-csp-violation-zero-review.md`. Every one is
carried forward by ID at the end of this file.

## Project context

- **Type**: web app (Next.js 16.3.4 App Router, React 19, TypeScript 5.9, Tailwind 4, shadcn/ui
  on radix-ui). Zero-knowledge password manager — an XSS is a vault-key compromise, so CSP
  strength is load-bearing.
- **Test infrastructure**: unit + integration (vitest) + E2E (Playwright, chromium) + CI/CD.
- **Verification environment constraints**
  - `VEC1` — **strict CSP requires a production build.** `csp-builder.ts` reads `NODE_ENV` and
    `CSP_MODE` at module-init time; dev emits `'unsafe-inline'` for both `script-src` and
    `style-src`, so every violation here is invisible under `next dev`.
    Classification: `verifiable-CI` unconditionally; `verifiable-local-after-network-install`,
    because Playwright pins chromium **1243** and only 1208/1234 are installed (F25, F6).
  - `VEC2` — **authenticated pages need a seeded session.** Reuse `e2e/global-setup.ts`'s
    existing `TEST_USERS` and `injectSession`; add no new seed, so `cleanup()`'s member set is
    unchanged (F15). Classification: `verifiable-local` / `verifiable-CI`.
  - `VEC3` — **AWS is unavailable** (dev environment destroyed). Nothing here needs it.

## Objective

Bring the count of `securitypolicyviolation` events produced by the application and its
dependencies, on every reachable page under the production CSP, to **zero** — and hold it there
with an execution-based gate that cannot pass vacuously.

## Baseline measurement (2026-09-26)

`npx next build && next start`, `NODE_ENV=production`, strict CSP, Chromium **1234**,
`http://localhost:3099/passwd-sso/ja/auth/signin`. The gate's own red proof must be taken on
**1243**, the revision it will run (F25, and the Go/No-Go precondition below).

| # | Directive | Source | Root cause |
|---|-----------|--------|------------|
| V1 | `script-src-elem` (inline) | document | `next-themes` `ThemeScript` — mounted without a `nonce` prop |
| V2 | `script-src` (eval) | client chunk | Zod 4.6.2's `allowsEval` probe runs `Function("")`; `jitless` unset |
| V3 | `style-src-elem` ×2 | client chunk | `sonner` `__insertCSS` — inserts an empty `<style>`, no nonce API |
| V4 | `style-src-elem` ×2 | client chunk | `next-themes` `disableTransitionOnChange` `<style>` — same missing prop as V1 |
| V5 | `style-src-elem` | `react-style-singleton` via `react-remove-scroll` (Radix overlays) | `getNonce()` never primed |
| V6 | `style-src-attr` | *claimed*: SSR `style=` attributes | **Unconfirmed — see C5.** Measured on every reachable public route: **zero** `style="` in served HTML |

A second, non-zod codegen site exists in the client tree — a core-js `globalThis` probe
(`||function(){return this}()||Function("return this")()`). It short-circuits on `globalThis` and
produces no runtime violation, so it is not a V-class entry, but V2's attribution of client eval
to Zod alone is incomplete (F-S1).

### Claims the measurement refuted, recorded so no later round re-adopts them

1. *"Next.js has no path to receive the nonce."* False — Next.js copies every middleware response
   header onto the request headers, and the App Router extracts the nonce from it. Measured: 18/18
   external and 15/16 inline scripts already carry it. `page-route.ts` needs no change (SC3).
2. *"The layout reads a one-request-stale nonce from the cookie."* False — middleware-set cookies
   are visible to the same request's Server Components. The cookie stays (SC2).
3. *"The UI does not hydrate."* False — Chromium reports React fibers attached. The AWS sign-in
   bounce has another cause (SC1).
4. *"`z.config({ jitless: true })` removes `Function("")` from the client bundle."* False — it is
   a runtime flag read before the probe; the bytes are unchanged (F-F1). Two of three Round-2
   reviewers asserted this; only one got it right. Any C4 mechanism built on it is dead on
   arrival.
5. *"The empty-string hash would admit any inject-then-fill style element."* False — Chromium
   re-checks on content mutation (F-S4). The prohibition stands on NFR1, not on that reason.

## Requirements

### Functional

- FR1 — Zero `securitypolicyviolation` events on every route the gate covers. Violations from
  outside the app origin are triaged and still fail by default; exceptions only via an explicit,
  commented allowlist (F16).
- FR2 — Toasts render with their intended styling in production.
- FR3 — Radix overlays apply their scroll-lock and scrollbar-compensation styles.
- FR4 — The theme is applied before first paint.
- FR5 — A native OAuth client cannot complete consent, and have an authorization audit row
  written, for a redirect URI the CSP will discard (F-S5).

### Non-functional

- NFR1 — **The CSP is not weakened.** No `'unsafe-inline'`, `'unsafe-eval'`, `'unsafe-hashes'`,
  no hash source whose preimage is the empty string, no `style-src-attr` split, no report-only
  downgrade, no `CSP_MODE` broadening.
- NFR2 — **No new disclosure of the nonce outside a nonce attribute** (F-S3). The platform scrubs
  the nonce from every DOM-serialising path; the app must not re-publish it more widely than it
  already does.
- NFR3 — `NODE_ENV` stays `production` in every verification path.
- NFR4 — The gate cannot pass vacuously: not against a dev-mode server, not when the page failed
  to render, not when authentication fell back to a public page, not when an interaction silently
  no-opped, and not when the violation collector itself is broken.
- NFR5 — **`npm ci --ignore-scripts` stays.** It is a deliberate supply-chain control with its
  reason recorded in `Dockerfile` and `release.yml`. C3 works with it, not around it. Security
  confirmed a root `postinstall` does not undermine it: that flag suppresses the root project's
  own lifecycle scripts too, which is precisely why C3 also needs an explicit build step.
- NFR6 — **Every new check ships with its own proof that it can fail**, and every check's
  "cannot run" outcome is spelled differently from its "found nothing" outcome.

## Technical approach

The nonce already reaches the browser correctly. The work is handing it to the injectors that
never received it, and removing whatever class a nonce cannot cover.

**Client-side carrier.** A document's CSP is fixed at initial load, so every later-inserted style
is checked against the *initial* policy — the initial nonce is the only one that can ever match.
Read it from `document.querySelector('script[nonce]')?.nonce` (the IDL property, which the
browser populates and does not serialise) with the `<meta name="csp-nonce">` as fallback. The IDL
read is strictly stronger under NFR2, is available to a dependency patch that cannot import app
code, and works on `src/app/global-error.tsx`, which renders its own `<html><body>` with no
`<head>` and therefore no meta (F-S3). The meta stays as the fallback — it is what survives when
no nonced script has been parsed yet, and `dynamic-styles.test.ts` depends on it.

**Client-side ordering.** `instrumentation-client.ts` is `require`d synchronously, unconditionally
and without a `try`/`catch` before `appBootstrap` in **both** bootstraps — `app-next.js` (webpack,
the production one) and `app-next-turbopack.js` (F-S11). That makes it the one placement ordered
ahead of every app chunk. It cannot help `sonner`, whose `__insertCSS` runs at its own module
evaluation; that consumer reads the DOM directly.

## Contracts

Each contract states the obligation and what must be proven. Mechanisms — file names, patterns,
allowlists, exact placements — are Phase 2's to choose and to prove, subject to NFR6.

### C1 — `next-themes` receives the request nonce

- **Obligation.** A server-side helper is the single place the `csp-nonce` cookie is read.
  `ThemeProvider` forwards a `nonce` to `NextThemesProvider`, which applies it to both the SSR
  `ThemeScript` and the `disableTransitionOnChange` `<style>`. `src/app/s/layout.tsx` is
  deliberately out of scope: it renders `NextIntlClientProvider`, `children` and `Toaster`, and no
  `ThemeProvider` (P1).
- **Control class.** `detection or audit only` — it supplies a value and denies nothing.
  Adjudication authority: Chromium, via C6.
- **Acceptance.**
  - Served HTML of every C6 route: zero inline `<script>` without a `nonce`, and every `nonce`
    equals the response CSP's.
  - If a literal-scan gate is written for the cookie-name constant, it must (a) be an AST scan,
    not text — `csp-builder.ts:52` carries the token in a comment that must survive (F9); (b) name
    `src/app/layout.tsx` as a member, since the `<meta>` render stays there (F-F5, F-S6); (c) be
    proven to red on a scratch violation, to stay green on the comment, and to red with an emptied
    allowlist. Two different predicates are involved (the bare constant, and the
    `meta[name="csp-nonce"]` selector); they get one scan and one allowlist each, or one scan whose
    match is a substring over string-literal nodes — stated either way, but stated.

### C2 — the nonce reaches every client-side style injector

- **Obligation.** One shared client helper reads the nonce (IDL first, meta fallback, per NFR2)
  and memoizes only a **non-null** result, so an early read on a page without a carrier does not
  poison later consumers (F-S8). `instrumentation-client.ts` primes `get-nonce`'s `setNonce` from
  it at module scope. `dynamic-styles.ts` drops its private reader for the shared one.
  `get-nonce` is **declared in `dependencies`** — today it is only a transitive of
  `react-remove-scroll`, and the whole mechanism is "write a module global another package reads",
  which silently no-ops if a second copy is ever hoisted (F-F3).
- **Control class.** `detection or audit only`. The ordering is structurally sound and Security
  verified it in both bootstraps, but nothing in this repository asserts it, so the label stays
  honest and C6 is the adjudicator (F-F10).
- **Acceptance.**
  - Opening a Radix overlay under the production CSP: zero `style-src-elem` violations, and
    `document.body` carries the scroll-lock style — the positive signal asserted *before* the
    violation count.
  - A page with no carrier produces one named refusal per document, not silent degradation, and
    repeated reads still perform exactly one DOM query (assert the query count, so "drop the memo"
    is not the fix) (F-S8).
  - Exactly one resolved copy of `get-nonce` in the installed tree, proven to red on a second copy.

### C3 — `sonner`'s injected stylesheet carries the nonce, in the shipped image

- **Obligation.** A checked-in patch makes `__insertCSS` (a) read the nonce from the DOM and
  **(b) set it on the element before inserting it into `head`** — clause (b) is the load-bearing
  one, measured: nonce-before-insert yields zero violations, insert-then-nonce yields one
  violation at insertion (F-S4). Filling the element before insertion is kept as a secondary,
  diagnostic invariant: an element empty at insertion reports the empty-string hash and hides the
  real content from the violation report. `sonner` is **pinned exactly**, because
  `--error-on-fail` only fires when a hunk fails to apply and `^2.0.8` admits a 2.0.9 that applies
  cleanly (F21).
- **Placement and subject — the two things revision 2 got wrong.** The patch must be applied where
  `node_modules` and `patches/` coexist and before the bundle is built; the `deps` stage has
  neither (F-F2, F19, F-S2). The verification subject must be something the shipped layer
  contains: the runner copies `.next/standalone` and `.next/static`, and `sonner` is bundled into
  the client chunks rather than traced into `node_modules` (F20). The tool must be invoked
  hermetically from `node_modules/.bin`, not through an `npx` that can reach the registry (F-S2).
- **Control class.** `fail-closed verification gate`, and it must earn it: an absent `patches/`,
  an absent tool, and an absent grep subject are three distinct named refusals, none collapsible
  into the 0-hit failure.
- **Acceptance.**
  - Deny: an emptied `patches/` fails the image build; a version bump fails install on both the
    local and the CI path; a removed patch fails the marker check.
  - Allow: at the pinned version the build completes with `--ignore-scripts` intact, install
    completes under `legacy-peer-deps=true`, and a rendered toast has its `[data-sonner-toaster]`
    custom properties resolved.
  - NFR5 has an enforcer that is proven to red on a `Dockerfile` with `--ignore-scripts` stripped.
    Revision 2's pattern did not — red-proved by two reviewers independently, by mutation on
    scratchpad copies (F34, F-F6). Whatever replaces it is red-proved the same way before it lands.
  - The `postinstall` hook's blast radius is recorded: nine plain-`npm ci` CI jobs will newly run
    it (F-F11), and `patch-package`'s transitive closure will execute inside the image build, in
    the one place `--ignore-scripts` guaranteed no dependency code ran. State the patch file's
    review procedure so "the patch was reviewed" is a defined act (F-S2).
  - Open question to settle before merge: does `patch-package` pass `npm audit signatures`? The
    licence and vulnerability gates were verified not to apply (F33).

### C4 — Zod's JIT probe never runs in a browser

- **Obligation.** `z.config({ jitless: true })` runs in `instrumentation-client.ts`, client-only by
  construction, so the server keeps its JIT path.
- **What must NOT be the mechanism.** A scan for `Function(` in client chunks. The flag is a
  runtime branch read before the probe; the literal stays in the bytes whatever the flag does, so
  such a scan can never go green and neither of its red-proofs can differentiate (F-F1). A
  narrowed `Function("")` variant fails for the same reason (F28). If an artifact-level tripwire
  is wanted, its subject is the *marker the fix emits* — the jitless-setting site, asserted present
  in an entry chunk the served HTML loads — with `ZOD_JIT_MARKER_UNRESOLVABLE` distinct from the
  0-hit failure.
- **Control class.** `best-effort tripwire` for any artifact scan; `fail-closed verification gate`
  only for C6's Chromium eval assertion, which is the sole thing that observes the probe not
  firing. Revision 2's upgrade of C4 to fail-closed was not honest and is withdrawn.
- **Acceptance.**
  - No `script-src` / eval violation on any gated route.
  - Unit coverage, if written, lives where `vitest.config.ts` actually collects it — a root-level
    file beside `instrumentation-client.ts` is collected by nothing (F30, F-F8). Note that the flag
    is a `globalThis` property, so a jsdom test setting it leaks to every other test sharing the
    worker unless reset.

### C5 — measure V6 before converting anything

- **Obligation.** Revision 2 asserted a nine-row "In SSR HTML by default?" column without
  measuring it. Round 2 refuted all six "yes" rows: the sidebar's folder rows come from a client
  hook that fetches in an effect, `favicon`/`entry-icon` render inside a client-decrypted vault
  list, and `src/components/folders/folder-tree.tsx` **has no importer at all** — every reference
  to it is `import type { FolderItem }` — which made it the only deny red-prove subject for a
  contract that cannot red on it (F29). Measured today, with none of C5 implemented, the served
  HTML of every reachable public route contains **zero** `style="`.
- **Therefore C5's first act is a measurement, not a conversion.** With the seeded session C6
  already needs, fetch the served HTML of every route in C6's table and record the measured
  presence or absence of `style="` per site. Convert only sites the measurement shows present.
  Allowlist the rest with the measurement recorded beside each, exactly as
  `tag-dialog.tsx:159` already is.
- **If the measurement finds zero qualifying sites, that is the result**: V6 does not exist, C5
  converts nothing, and the gate's job is to keep the count at zero. Do not manufacture a deny
  clause by converting a site that cannot violate, and do not delete `folder-tree.tsx` as part of
  this plan — whether that dead component should go is a separate decision, and removing it here
  erases the evidence that the table was unmeasured (F29, R34).
- **`src/app/global-error.tsx` is allowlisted regardless.** It renders when the root layout has
  thrown, i.e. exactly when its stylesheet is least likely to have loaded, so moving its four
  inline styles to a stylesheet trades a blocked-but-present style for a possibly-absent one
  (R3, P3). Its violation count is pinned as an **exact non-zero baseline** — a fifth violation
  reds, and so does removing one (F-S9). Reproducing a root-layout throw against the production
  server is an acceptance criterion, not an assumption.
- **Control class.** `fail-closed verification gate` over the measured HTML. A source-level grep
  over `style={` is an indicator only: `style-src-attr` polices attribute *parsing*, and React
  applies client-mounted styles through `node.style.setProperty`, which CSP does not check —
  verified, along with the boundary that `setAttribute("style", …)` **is** blocked, so the
  allowlist covers React's object-form `style` prop and not a string arriving through
  `dangerouslySetInnerHTML` (F-S3's measurement of F12).
- **Acceptance.** Conversions, if any, preserve the geometry the existing component tests pin
  (`sidebar-shared.test.tsx` asserts `paddingLeft: "24px"`; `favicon.test.tsx` asserts sizes
  16/28/12), name their bound — folder depth is capped at `MAX_FOLDER_DEPTH = 5`, icon sizes are
  {12, 16, 20, 28} — and add one test at bound+1, because converting an open numeric domain to a
  finite class map introduces exactly that failure mode (F32).
- **Escalation, recorded in advance.** If the measurement finds an SSR style attribute originating
  in a dependency that cannot be removed without forking it, the choice between
  `style-src-attr 'unsafe-inline'` and leaving that violation open goes back to the user. NFR1
  forbids the first and FR1 the second.

### C6 — an execution-based CSP gate that cannot pass vacuously

- **Obligation.** A Playwright spec that, for each route in a table, asserts zero
  `securitypolicyviolation` events — and that is structurally incapable of reporting zero for the
  wrong reason. Concretely it must satisfy all of:
  1. The response CSP is strict (contains a nonce, no `'unsafe-inline'`) before anything else is
     asserted. A dev-mode server fails here; the spec never skips.
  2. Per-route preconditions asserted **before** the violation count: for an authenticated route,
     that the URL is not the post-redirect signin, a route landmark is visible, and the vault is
     unlocked with at least one row rendered; for an interaction route, that the overlay actually
     mounted or the toast actually appeared. Public routes carry no authentication precondition —
     that is the paired allow case (F1, F14).
  3. A **standing** positive control for the collector: a case that injects a nonce-less `<style>`
     on the target origin and asserts exactly one violation is caught, paired with a nonce'd
     `<style>` asserting zero. A one-off red proof does not survive the collector breaking later
     (F2).
  4. `retries: 0` for this spec only; the config-level retry stays for the others. Playwright
     exits 0 on a retry-passed test, which would launder exactly the order-dependent violations
     this plan is most exposed to (F7). Both this and the foreign-violation classifier need their
     own red proofs (F26).
  5. Route coverage: one page per root segment (`[locale]`, `s`), one authenticated dashboard page
     rendering the sidebar and the password list, one Radix overlay interaction, one toast, one
     basePath-configured route, and `global-error.tsx` with its exact baseline (F-S9).
  6. Every violation records `sourceFile` and `blockedURI`; non-app-origin violations are counted
     separately and still fail by default; an empty `sourceFile` counts as app-origin (F16).
- **Wiring — the part revision 2 left out entirely.**
  - The production-build condition on `webServer.command` is **additive**
    (`CI || E2E_CSP_SERVER=prod`), never a replacement. Replacing it regresses all 36 existing
    specs onto `next dev` in CI (F23, F-F4).
  - A basePath run is a **second CI job**, not a Playwright project: `NEXT_PUBLIC_*` is inlined at
    build time, a run has one `webServer` and one process env, and `e2e/helpers/auth.ts` resolves
    the session cookie *name* from the same variable (F22).
  - Some workflow step must actually invoke the gate. C8 fixes which jobs *run*; nothing in
    revision 2 said what they *run* (F24).
  - Whatever CSP-string divergence remains between the local proof and CI — the Sentry DSN is set
    in production and not in the E2E job, so `connect-src` differs — is either removed or recorded
    as a decision (F16, F26).
- **Control class.** `fail-closed verification gate`. Adjudication authority: Chromium's CSP
  implementation, not a header-string match.
- **Acceptance.** The red proof is taken **first**, on chromium 1243, and the observed violation
  list is pasted into the review artifact with the revision recorded beside it. Each of the six
  obligations above gets its own mutation, run and observed. Undecidable outcomes each get a named
  refusal. `E2E_BASE_URL`, `fullyParallel: false` and `workers: 1` are preserved.

### C7 — the `form-action` IPv6 loopback claim is truthed up

- **Obligation.** Chromium discards `http://[::1]:*` as an invalid source — it logs this on every
  production page load — and CSP3's `host-source` grammar has no IPv6-literal production. The
  literal stays in the header (removing it is a behaviour change nobody asked for) and the
  `csp-builder.ts` comment stops implying the directive grants what RFC 8252 requires. The
  existing test is re-titled to pin the literal as present **and inert**.
- **Acceptance.** A rename is not sufficient (F17). C6 gains a case that submits a real
  `form-action` navigation to `http://[::1]:<port>` and asserts a `securitypolicyviolation` with
  `violatedDirective === "form-action"` naming `[::1]` — asserting "the navigation did not
  complete" is not enough, because a refused connection is indistinguishable from a block. The
  probe server binds dual-stack and a **non-browser** precondition proves `[::1]` is reachable
  before the browser assertion runs; otherwise `FORM_ACTION_PROBE_UNAVAILABLE`, never a skip
  (F-F9). Paired allow case: the same submission to `http://127.0.0.1:<port>` completes.

### C8 — the CI trigger set covers the files these contracts depend on, and fails closed

- **Obligation.** `patches/**`, `.npmrc` and `instrumentation-client.ts` join the `app` filter —
  none is in any filter today, and `instrumentation-client.ts` is the module C2 and C4 both depend
  on (F11, O1). While editing that block, the `instrumentation.ts` entry that matches no file is
  corrected or removed (F-F12).
- **The fail-open revision 2 carried as an open question is answered and must be fixed.** When the
  `changes` job fails or is skipped its outputs are empty strings, every `== 'true'` comparison is
  false, and the e2e job — the whole CSP gate — is **skipped**, reported as non-blocking.
  `always()` defeats the skip-on-failed-dependency default; it supplies no outputs (F31).
- **Control class.** `fail-closed verification gate` for the trigger set: it decides whether the
  other gates run at all.
- **Acceptance.** Deny: a `patches/`-only branch runs the e2e job; a forced `changes` failure runs
  it too. Allow: a docs-only PR with a successful filter still skips the app jobs, which the
  filter's comments record as deliberate. Both proven by execution on a scratch branch.

### C9 — DCR stops registering redirect URIs the CSP discards

- **Obligation.** `LOOPBACK_REDIRECT_RE` accepts `[::1]` while `form-action` discards it, so a
  native client can complete consent, have an authorization audit row written, and never receive
  the redirect — two adjudicators deciding one predicate by different semantics, with the audit
  trail believing the permissive one (F-S5, R48). Reject `[::1]` at DCR registration with an error
  naming the CSP limitation, so the client fails at registration — recoverable, and no audit row
  for a grant that cannot land. `127.0.0.1:*` and `localhost:*` stay registrable.
- **Control class.** `fail-closed verification gate` at the registration handler, because the
  browser's `form-action` evaluation is not reachable from the server. A URI that parses but whose
  host form is not in the decided set is refused, never allowed through.
- **Acceptance.** Deny: registering `http://[::1]:8080/cb` fails with a message naming the reason.
  Allow: `http://127.0.0.1:8080/cb` and `http://localhost:8080/cb` register, and C6's `form-action`
  case confirms the `127.0.0.1` redirect lands. This narrows an accept-set, so the user's decision
  to take it in this PR is recorded here.

## Testing strategy

| Level | What it pins | Why not lower |
|-------|--------------|---------------|
| C6's Playwright spec | every violation class, against Chromium's own CSP engine | jsdom implements no CSP |
| Docker build verification (C3) | the shipped image carries the patch | the CI tree is a different tree |
| Artifact tripwires (C4, C5) | cheap regression nets over what shipped | not authoritative — see RT9 |
| vitest | the wiring, and C5's geometry | the gate sees CSP, not layout |

Every new check obeys NFR6: proven able to fail, by execution, one mutation per clause, before it
lands. Where a unit test and the gate disagree, the gate is authoritative.

Any new executable check placed under `scripts/checks/` falls inside
`check-gate-selftest-coverage.sh`'s member set and needs a sibling self-test or a reasoned debt
entry; a check embedded in the E2E spec is outside that member set, and which applies must be
stated rather than discovered (F18, F-F7). A check that reads `.next/**` must be queued after the
build step.

## Considerations & constraints

- `patch-package` is new tooling in this repo. Footprint: one devDependency, a `postinstall` hook
  that nine existing CI jobs will newly run, an explicit build step, and a verification step.
  Accepted by the user in preference to leaving V3 open.
- The patch pins sonner exactly; a Dependabot bump fails by design, and the patch file's header
  records why.
- Round 1 delivered only the Testing perspective; Round 2 delivered all three. Security found no
  Critical and positively confirmed the design's load-bearing premises by measurement.

### Scope contract

- `SC1` — **the AWS sign-in bounce.** The page hydrates under strict CSP, so CSP is not its cause.
  Not investigated here, by the user's decision. Anti-Deferral: it needs a rebuilt AWS environment
  or a full local production sign-in with DB and Redis, both larger than this plan and sharing no
  code with it; no contract here touches authentication.
- `SC2` — **`csp-nonce` cookie removal.** Proposed by the handoff; the measurement shows it works
  and the meta is the fallback carrier. Not removed. A decision, not a deferral.
- `SC3` — **`page-route.ts` request-header injection.** Proposed by the handoff, refuted. Not
  implemented. A decision, not a deferral.
- `SC4` — **removing `src/components/folders/folder-tree.tsx`.** Discovered to have no importer
  while deriving C5's member set. Anti-Deferral: deleting it inside this plan would erase the
  evidence that revision 2's table was unmeasured, and whether a dead component should go is a
  decision about code ownership, not about CSP. Owner: a follow-up issue.

## User operation scenarios

1. A signed-out user loads the sign-in page in a dark-mode browser: theme applied before first
   paint, no console violation (C1, C4).
2. A signed-in user expands a three-level folder: indentation correct, and whatever C5's
   measurement decided about `style` attributes holds (C5).
3. The same user triggers a failing action and sees a styled error toast (C3).
4. The same user opens the new-entry dialog: no background scroll, no scrollbar shift (C2).
5. A recipient opens a `/s/<token>` share page and copies the secret; the confirmation toast is
   styled — the share layout has no `ThemeProvider` but does have `Toaster`, so C2 and C3 apply
   there and C1 does not (P1).
6. A native OAuth client registers an `http://[::1]:PORT/` callback and is rejected at
   registration with a reason, instead of completing consent and never receiving the redirect
   (C9).

## Go/No-Go Gate

| ID  | Subject                                                        | Status  |
|-----|----------------------------------------------------------------|---------|
| C1  | next-themes receives the request nonce                          | locked  |
| C2  | the nonce reaches every client-side style injector              | locked  |
| C3  | sonner's stylesheet carries the nonce, in the shipped image     | locked  |
| C4  | Zod's JIT probe never runs in a browser                         | locked  |
| C5  | measure V6 before converting anything                           | locked  |
| C6  | execution-based CSP gate that cannot pass vacuously             | locked  |
| C7  | `form-action` IPv6 loopback claim truthed up                    | locked  |
| C8  | CI trigger set covers these files, and fails closed             | locked  |
| C9  | DCR stops registering redirect URIs the CSP discards            | locked  |

**Go/No-Go precondition on C6**, and therefore on the plan: C6 does not close until the observed
pre-fix violation list, taken on chromium **1243**, is recorded in the review artifact with the
revision beside it. If the local install is declined, a CI run supplies the evidence — `ci.yml`
already installs the pinned revision. If neither is available, C6 stays open; that is a refusal,
not an assumption (F25).

## Carried-Forward Plan Findings

All 57 findings from Rounds 1 and 2 are carried into Phase 2 rather than re-specified here. This
is the deliberate exit recorded in the review artifact's saturation assessment: the design is
settled, the open findings are all about mechanism, and mechanism is what Phase 2 decides by
execution. **Anti-Deferral for the whole set:** re-specifying them in plan prose is what produced
them — Round 2's Criticals were overwhelmingly defects in Round 1's remedies as written into
revision 2. Their cost if dropped is that a mechanism ships unproven; NFR6 is the standing control
against that, and each finding below names the acceptance criterion that will settle it.

**Resolved by revision 3, no Phase-2 action beyond the named acceptance criterion:** F1, F4, F7,
F8, F9, F11, F13, F14, F15, F17 (Round 1); P1, P2, P3; O1, O2.

**Open, settled by C-acceptance during implementation:**

| Findings | Settled by |
|----------|------------|
| F-F1, F28, F-S1, F10 | C4's acceptance — the marker-vs-`Function(` decision, and the withdrawal of the fail-closed label |
| F3, F19, F20, F21, F-F2, F-S2, F33 | C3's acceptance — placement, subject, hermeticity, version pin, audit-signatures question |
| F34, F-F6 | C3's acceptance — NFR5's enforcer must be red-proved by mutation before it lands |
| F12, F29, F32, F-S9 | C5's acceptance — measure first, then convert; the error page's exact baseline |
| F2, F5, F6, F16, F18, F22, F23, F24, F25, F26, F-F4, F-F7, F-F9 | C6's acceptance — the six obligations, the wiring, and the 1243 red proof |
| F31, F-F12 | C8's acceptance — the empty-outputs fail-open and the dead filter entry |
| F-S5 | C9 — now in scope by the user's decision |
| F-F3, F-S8 | C2's acceptance — declare `get-nonce`, prove single-copy, memoize non-null only |
| F-F5, F-S6, F-S7 | C1's acceptance — the two predicates, their allowlists, and the scan root |
| F-S3 | NFR2 and the Technical approach — adopted, with the residual risk to be recorded in `docs/security/threat-model.md` §5 |
| F-S4 | C3's obligation — clause (b) is load-bearing, clause (c) diagnostic; the forbidden pattern's recorded reason is corrected |
| F27, F30, F-F8 | C2/C4 acceptance — `instrumentation-client.ts` needs a content gate and an admissible test location |
| F-F10, F-F11, F-S10, F-S11 | recorded corrections: C2's class relabelled, I3.3's table dropped for the obligation, I5.2's unreproducible figure dropped with C5's measurement replacing it, both bootstraps cited |
