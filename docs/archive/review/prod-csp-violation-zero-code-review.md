# prod-csp-violation-zero — Phase 3 code review

Subject: the implemented tree of `fix/prod-csp-violation-zero`, reviewed against
`prod-csp-violation-zero-plan.md` revision 3 (C1-C9, NFR1-NFR6, SC1-SC4) and the
red proof in `prod-csp-violation-zero-review.md`.

Three independent experts, one round. 23 findings. Every Critical and Major is
fixed in the tree this document accompanies; the residuals are named in the last
section with what each would take to close.

## Why a code review was still owed after a green gate

The E2E gate (`e2e/tests/csp-strict.spec.ts`) reported zero violations on 11/11
tests before this round began. That is the *product* claim. It says nothing about
whether the gate can fail, whether the enforcement scripts enforce, or whether
the code paths added to reach zero opened something else — and this round found
that three of those were wrong at once:

- the Docker patch-verification grep was green whether or not the patch applied,
- the NFR5 shell gate saw one of three npm install invocations in the very file
  it guards,
- the public-route precondition checked a property Next assigns before hydration,
  so "the page hydrated" was never actually asserted.

A silent-when-healthy gate proves nothing on a healthy tree. Each of these was
red-proved after the fix.

## Findings and dispositions

Severity is the plan's: **Critical** = a security property of the product is
wrong; **Major** = a gate or contract does not hold; **Minor** = record or
comment defect.

### Critical

**1. The MCP consent page is a third redirect adjudicator, and its `invalid_scope`
arm is an open redirect.**

`src/app/[locale]/mcp/authorize/page.tsx` decided the redirect target by
membership in `client.redirectUris` alone — no shape check — and on an
unsatisfiable scope it *redirected* to that URI with no user interaction. The
reachable path is the product's own DCR: register a client pre-auth with an
arbitrary `redirect_uri`, leave it unclaimed (`tenantId === null`), and the
tenant gate short-circuits because `null === undefined` was never the comparison
being made. CWE-601 against a page the user arrives at from a link.

*Fixed.* The page now applies `isAcceptableRedirectUri` to the stored value, and
the `invalid_scope` redirect arm runs only when `client.tenantId === userTenantId`
— an unclaimed or foreign client renders `errors.invalidScope` instead. Four
tests (deny and allow arms), plus the string in both locales.

This is the third adjudicator of the same decision. See finding 2.

**2. `isAcceptableRedirectUri` was declared the single predicate while four
validators kept inlined copies.**

`src/lib/constants/auth/mcp.ts` gained the predicate in this branch, but
`api/mcp/register/route.ts`, `api/tenant/mcp-clients/route.ts`,
`api/tenant/mcp-clients/[id]/route.ts` and the client-side
`mcp-client-card.tsx` each still tested the URI with their own expression. A
predicate that four call sites re-implement is not a single source of truth; the
`[::1]` narrowing this branch performed would have landed in one of five places.

*Fixed* in all four, including the client-side one, so the browser refuses what
the server refuses and the message comes from
`REDIRECT_URI_ACCEPT_SET_MESSAGE`.

**3. The `form-action` mirror class had a second, larger member.**

Closing `[::1]` on the acceptance side left `https:` open on the enforcement
side: the base policy lists `'self'` and loopback only, so a hosted client's
consent completes, writes its audit row, and then has its 302 discarded. See
[D18](./prod-csp-violation-zero-deviation.md) for the measurement, the design,
and why the two obvious alternatives were rejected.

*Fixed* by `src/lib/security/consent-form-action.ts`: a per-request widening
scoped to the consent path, sourced from the stored registration, re-checked with
the same predicate, empty on every failure path. Nine tests.

### Major

**4. The Dockerfile patch marker is not unique to the patch.**

The build verified the sonner patch by grepping chunks for
`meta[name="csp-nonce"]` — a selector the app's own `src/lib/ui/csp-nonce.ts`
compiles into the bundle. Three chunks carried the marker; two carried sonner.
Per-chunk scoping made the grep *look* precise while resting on which chunk the
bundler happened to emit.

*Fixed.* The patch emits the literal `sonner-csp-nonce-patch`, which nothing else
in the tree produces, and the guard greps each sonner chunk for it.

**5. The NFR5 gate saw one spelling of the thing it forbids.**

The first enforcer matched `npm ci` on a line-anchored `^RUN`. The Dockerfile
already contained `npm install "prisma@…"` and `npm install -g "npm@…"` on
`\`-continued lines inside a compound RUN — both invisible to it. After the verb
and continuation fix, `RUN npm ci --ignore-scripts; npm install evil` still
passed.

*Fixed twice.* The subject is now every command segment of every RUN, split on
POSIX sh's complete separator set `; & |`, matched against the install verbs
`ci|install|i|add` with `npm init` excluded. Detection on the real Dockerfile went
1 → 3 invocations. 13 self-test cases; the two refusal codes
(`DOCKERFILE_SUBJECT_MISSING`, `DOCKERFILE_NO_NPM_INSTALL`) exit 2, distinct from
the exit-1 verdict, so a gate that cannot see its subject cannot report zero.

The pattern this replaced was red-proved **dead**: it embedded the filename in
the regex body, so it matched nothing — not even the mutated Dockerfile it
existed to reject.

**6. The gate's hydration precondition did not check hydration.**

`window.next` is assigned at module scope, before React renders anything. The
precondition therefore proved the entry chunk parsed. The one recorded incident
in this branch — a stale server serving an older build — is exactly the state it
would have passed.

*Fixed.* Two signals, named separately: runtime-booted, and a React fiber on a
rendered element. The first fiber probe was itself too narrow (the share page
hydrates 11 elements and has no interactive one) — caught before commit by
running it, not by reading it.

**7. `partitionByOrigin`'s `excluded` arm was unreachable and unproven.**

The function had already shipped inverted once in this branch (allowlisting moved
a violation into a still-failing bucket rather than out of the count).

*Fixed.* Exported, allowlist parameterised for fixtures, five-case self-test
including the different-port case and the unattributable tie.

**8. FR2 and FR3 probes had never been observed to fail.**

Both were added after the only run in which the gate failed, so neither had a red.

*Fixed by execution.* Starving the nonce read — the product state both detect —
flips both to false; on the shipped build both are true. Removing the `nonce`
attribute was *not* enough to starve it: the value survives in
`[[CryptographicNonce]]`, which is precisely the reason `readCspNonce` prefers
the IDL property over the attribute.

**9. `countStyleAttributes` missed three of the four forms it counts.**

`/\sstyle="/g` misses single-quoted, uppercase and spaced spellings. All four
fixtures used the one form React emits, so the regex and the fixtures agreed with
each other and with nothing else. This is the class C5's allowlist explicitly
does not cover (`dangerouslySetInnerHTML`).

*Fixed* to `/\sstyle\s*=\s*["']/gi`, with the three missed forms and `style=""`
added as fixtures.

**10. The devDependency tree the new `postinstall` executes was outside every CVE
gate.**

Introducing `patch-package` as a `postinstall` means a dev-tree dependency now
runs code on every developer's `npm install`. The existing audit step is
production-scope.

*Fixed.* A dev-scope `npm audit --audit-level=high` step beside the
production-scope one, kept as a separate step so the two signals stay
distinguishable. Measured clean at 0. `npm audit signatures` — C3's open question
— was answered by running it: exit 0, 1378 verified signatures.

**11. `patch-package` was the only new dependency on a caret.**

*Fixed*, pinned exactly like the two packages it protects (`sonner`, `get-nonce`).

### Minor

**12-17.** Record defects, all fixed: manual-test A2 denied the enforcer that
shipped; A5 overclaimed and now names the `<head>` ordering the argument actually
rests on; T6's count was stale (10); D6's premise and D14's "17 jobs" corrected by
re-deriving with a YAML parser (17 total, 12 gated, 12 hardened); `csp-nonce.ts`'s
comment claimed attribute selectors are hidden while a presence selector sat on
the next line; red-proof residue removed.

## Measurements taken in this round

Against a production build (`next build` + `next start`, port 3010, chromium 1243):

| Subject | Result |
|---|---|
| Gate, all routes | 11/11 pass, **zero violations** |
| Positive controls in the same run | 3/3 green |
| `form-action`, ordinary page | `'self'` + loopback |
| `form-action`, consent page, unknown client | `'self'` + loopback |
| `form-action`, consent page, `?redirect_uri=https://evil.example` | `'self'` + loopback — the query is never read |
| `form-action`, consent page, registered https client | `'self'` + loopback + `https://client.example` |
| `npm audit signatures` | exit 0, 1378 verified |
| `npm audit --audit-level=high`, dev scope | 0 |
| NFR5 gate on the real Dockerfile | 3 invocations, all flagged |
| Unit suite | 1040 files, 16046 passed |
| `next build` | success |

The probe client seeded for the live `form-action` measurement was deleted
(`DELETE 1`, remaining count 0).

## Residuals

Named rather than closed, each with what closing it takes.

- **`E2E_CSP_SERVER=prod` has never booted here.** Port 3000 is held by the
  developer's own dev server, so the `webServer` branch cannot run on this
  machine. The selection logic was extracted to
  `e2e/helpers/web-server-command.ts` and pinned in five states, which is what
  the red proof asked for; the boot itself is owed to the first CI run that
  takes the branch.
- **`SETTLE_MS` in the gate is chosen, not measured.** A page slower than the
  settle window would report zero for the wrong reason. The precondition probes
  make that a refusal rather than a false green, but the number itself has no
  derivation.
- **`instrumentation-client.ts` has no unit test and no gate.** Its two
  responsibilities (priming `setNonce`, `z.config({ jitless: true })`) are
  asserted only end-to-end. A deletion of either line is caught by the E2E gate
  and by nothing faster.
- **No count of stored `[::1]` rows.** The accept-set narrowing is enforced on
  read in every adjudicator, so an existing row cannot widen anything — but the
  number of registrations this silently invalidates was not measured.
- **`npm ci --omit=dev` and the postinstall.** Adjacent to this branch: a
  production install that omits dev dependencies has no `patch-package`, so the
  patch must come from the image build step, which is why the Dockerfile applies
  it explicitly. Out of scope here, recorded so the coupling is not rediscovered.

## Termination check

Round 1 fixed every Critical and Major it raised. The fixes introduced no new
Critical or Major: the three that touched product behaviour (findings 1, 2, 3)
are each covered by tests that were red before the fix, and the rest are gate and
record changes whose own self-tests are new in this round. No reviewer's remedy
was adopted without measuring its premise first — two premises (the `https:`
mirror member, the `[[CryptographicNonce]]` survival) turned out to be the
opposite of what reading suggested.

Round 2 is not opened. The remaining items are the residuals above, none of which
is a defect in the tree.

## Post-commit: the bypass-RLS gate caught the new call site

`scripts/pre-pr.sh` failed 1 of 81 on the committed tree:
`src/lib/security/consent-form-action.ts` uses `withBypassRls` and was not on
`ALLOWED_USAGE`. That is the gate working — a new cross-tenant read must be named
before it ships.

The bypass is required and not incidental. The lookup runs in
`src/lib/proxy/page-route.ts`, a layer that executes before any tenant context is
established, so there is no RLS session variable to satisfy; it is the same
lookup `src/app/[locale]/mcp/authorize/page.tsx` already performs, by the unique
`clientId`, selecting `redirectUris` alone — values the registrant supplied and
which the consent page already displays to them. Read-only, no identity, and
every failure path returns no extra CSP sources.

The entry was red-proved rather than trusted: changing its model list to
`["tenant"]` makes the gate exit 1 with *"ALLOWED_USAGE permits a model the file
never reaches under a bypass"*, and the correct list exits 0. So the entry grants
exactly `mcpClient` and the gate can still tell the difference. The gate's own
169 tests pass, and `pre-pr.sh` is then 81/81.

## Post-push: the Docker guard refused its own Round-1 fix

CI's `Trivy: Container image scan` failed — not on a CVE (Trivy itself is exit 0
against the built image locally), but because `docker build` refused at the
patch-verification step:

```
SONNER_PATCH_MARKER_ABSENT: .next/static/chunks/3ojkuyotcudmz.js
  carries sonner but not the CSP-nonce patch
```

**The patch was applied; the marker was not in the bundle.** Round 1's fix
(finding 4) introduced the marker as

```js
let patchMarker = 'sonner-csp-nonce-patch'
let nonce = patchMarker && ((document.querySelector('script[nonce]') || {}).nonce || …)
```

A provably-truthy literal in a boolean position is exactly what a minifier folds
away. The emitted chunk reads

```js
a.type="text/css";let r=(document.querySelector("script[nonce]")||{}).nonce||…;
r&&a.setAttribute("nonce",r),…,e.appendChild(a)
```

— the patch's ordering contract is intact and `patchMarker` is gone. The
comment in the patch had reasoned that a *comment* would not survive
minification and concluded a string literal would; the missing step is that
surviving minification requires being **observably used**, which this one was
not.

*Fixed* by making the marker a DOM side effect — `style.setAttribute('data-sonner-csp-nonce-patch', '')`
— which no minifier can remove and which, unlike a bundle grep, is observable at
runtime. Both sonner chunks now carry it, and exactly those two.

Two things worth keeping from this:

- **The guard worked.** This is the third form of the same check and the first
  one that has now been seen to fail on a real state rather than a fixture. A
  marker check that had stayed green here would have shipped a Round-1 "fix"
  that verified nothing.
- **A build-time grep is the weaker half.** The attribute made a runtime
  assertion cheap, so the FR2 probe now also asserts that a style element
  carries it — a live stylesheet alone only says sonner's CSS was admitted, not
  that the patched insert is what admitted it. Red-proved by pointing the
  selector at an absent attribute: 1 failed, correct message.

One local-workflow note, not a defect: a plain `npx next build` picks up
`NEXT_PUBLIC_BASE_PATH=/passwd-sso` from `.env`, so the chunks are emitted under
a basePath the E2E server does not serve. The gate refused with
`CSP_GATE_PRECONDITION_FAILED: … the Next runtime never booted` on 8 of 11 tests
rather than reporting zero violations against a page that never hydrated — which
is the behaviour finding 6 added. Rebuilding through the E2E env restores 11/11.

Re-verified after the fix: `docker build` exit 0, Trivy `CRITICAL,HIGH
--ignore-unfixed` exit 0, gate 11/11.
