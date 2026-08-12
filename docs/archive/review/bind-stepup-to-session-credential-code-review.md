# Code Review: bind-stepup-to-session-credential
Date: 2026-08-12
Review round: 1

## Changes from Previous Round

Initial code review. Phase 2's Step 2-5 self-R-check (R1–R57 + RS*/RT*) came back clean for
functionality and security and found three testing gaps, all closed before this round; Round 1 is
therefore incremental verification on top of that baseline. Ollama seed generation was attempted and
timed out on the 4759-line diff, so all three experts fell back to full-diff review — the documented
fallback. Local LLM pre-screening (`pre-review.sh code`) returned "No issues found".

## Merged Findings (deduplicated, convergence-stamped)

| ID | Severity | Subject | Reported by | Convergence |
|----|----------|---------|-------------|-------------|
| C1 | **Critical** | The "I9 ordering" integration test does not exercise the mechanism its name and comment claim. The deletion commits before the route runs, so `ON DELETE SET NULL` has already nulled the binding and step 3 denies first — proven by an instrumented probe (the verifier is never called) and by mutation (swapping the route to `verifyAssertionAnyCredential`, the exact regression `C4` exists to prevent, left it green). RT4/RT7. | testing F1 | single-perspective, but **execution-verified** |
| M1 | Major | Wrapping the migration in `BEGIN`/`COMMIT` after it had been applied left `_prisma_migrations.checksum` permanently divergent from the file (`1842111f…` recorded vs `c694b2ec…` on disk, both measured). Any database that applied the pre-wrap file is blocked at the next `db:migrate`. | functionality F1 | single-perspective |
| M2 | Major | `check-bypass-rls.mjs`'s fixed 10-line `SCAN_RADIUS` no longer reaches the Prisma model calls in the three `withBypassRls` callbacks this branch lengthened — the binding read, the existence re-check and the `passkey_verified_at` write sit 8 to 67 lines past the window. Verified by injecting an unlisted model at each site: the gate still exited 0. Also falsifies the plan's claim that `C5` member 1 "moves it inside" (R29). | security 1 | single-perspective, **execution-verified** |
| M3 | Major | `e2e/tests/step-up-credential-binding.spec.ts` — the plan's own "only full-stack proof of the reported regression", explicitly in scope and not deferred — had never been executed in any environment, and so could be classified neither `verified-*` nor `blocked-deferred`. | testing 2 | single-perspective |
| m1 | Minor | `presentedCredentialIdMetadata` set `presentedCredentialIdRejected: true` both when the id was legitimately absent and when it was present but refused — collapsing the two states the flag exists to keep apart, resolved the opposite way from what its own comment argues for. | security 2 | single-perspective |
| m2 | Minor | Two files named under `C5` in the plan's Implementation Checklist (`signin/page.test.ts`, `page.basepath.test.ts`) are absent from the diff with no deviation entry. Both were re-run and pass unmodified — the gap is an unreconciled manifest, not a coverage regression. | functionality F2, testing 3 | **functionality+testing** |
| m3 | Minor | `presentedCredentialId`'s 512-char bound had a distant deny test (600) and a charset deny test, but no boundary-adjacent allow case at exactly 512 — asymmetric with `boundCredentialId`, which has one. An off-by-one (`<` for `<=`) would reject every legitimately-sized id undetected. | testing 4 | single-perspective |
| m4 | Minor | `C7`'s "the row survives (`truncateMetadata` did not fire)" criterion was proven only against the route's own pre-bounding function with `logAuditAsync` mocked, never against the real audit pipeline. | testing 5 | single-perspective |

## Adjacent Findings

- functionality F2 → routed to Testing; merged with testing 3 as `m2`.
- testing F1 (C1) carried an `[Adjacent]` tag to Security; the finding is a test defect, so it stays
  in Testing's lane and Security's independent review reached no contradicting conclusion.

## Quality Warnings

None. Every finding carried file/line evidence, and the two most consequential (C1, M2) were
demonstrated by execution rather than argued from reading.

## Environment Verification Report

Per the plan's `Verification environment constraints` VE1–VE3:

| Path | Classification | Basis |
|---|---|---|
| Signed WebAuthn ceremony, any tier | `blocked-deferred` | VE1 + its Anti-Deferral entry, owner `SC5`. Link present and correct. |
| `counter_mismatch` / `signature_invalid` at the integration tier | `blocked-deferred` | Plan's tier split + deviation D2. Covered instead at the route tier, as the plan assigns. |
| `credential_missing` via a same-user mid-transaction deletion | `blocked-deferred` | Deviation D2, and now D9 for the same conclusion reached about I9. |
| Integration suite | `verified-local` | `npm run test:integration` → 98 files / 611 passed (VE3 satisfied; `audit-outbox-worker` stopped for the run and restarted after — the guard refused a run while it was up, which is the guard working). |
| Unit suite / lint / build | `verified-local` | `npx vitest run` → 1008 files / 14530 passed; `npm run lint` and `npx next build` exit 0. |
| `scripts/pre-pr.sh` (70 gates) | `verified-local` | `check-pre-pr.sh run` exit 0. |
| The 7 CI-only gates of D5 | `verified-local` | Each run by hand, each exit 0; `refactor-phase-verify --force` explained by D8. |
| Manual two-authenticator scenarios 1–7 on `mrx33` (VE2) | **not verified** | No access from this session. Outstanding for the human merge gate. |
| E2E dialog-selection spec | **not verified — see D13** | Attempted; `globalSetup` fails seeding the first pre-existing fixture user with an RLS violation, blocking every E2E spec locally. Runs in CI on the PR (`ci.yml:491`, path filter `e2e/**`). Anti-Deferral entry in D13. |

## Resolution Status

### C1 Critical — the I9 test does not reach the mechanism it names
- Action: renamed to "the FK cascade's effect reaches the route: an outstanding ceremony on a
  deleted binding denies at step 3, verifier never called"; comment rewritten to state what it does
  and does not prove; two assertions added so it cannot be re-read as verifier evidence (the audit
  `reason` is pinned to `no_binding`, and the Redis challenge is asserted still present). The
  substitution defense is left where it is actually proven — `verify-authentication-assertion.test.ts`'s
  DENY case against the real verifier, and the "bound row present, wrong credential presented"
  integration case. Recorded as deviation D9 with the reason the true race is unschedulable, the same
  conclusion D2 reached for `credential_missing`.
- Modified: `src/__tests__/db-integration/reauth-credential-binding.integration.test.ts:237-300`

### M1 Major — migration checksum drift
- Action: measured both values, re-synced the recorded checksum on the dev database, verified
  equality and `prisma migrate status` up to date. D12 records the one-line re-sync any other
  environment that applied the pre-wrap file needs, `mrx33` included.
- Modified: `_prisma_migrations` row (dev DB, metadata only);
  `docs/archive/review/bind-stepup-to-session-credential-deviation.md` (D12)

### M2 Major — the bypass-RLS gate's scan window no longer covers its subjects
- Action: replaced the fixed radius with a balanced-delimiter walk of each call's actual extent;
  comment-only matches are skipped (`src/auth.ts:66` names the helper in prose); a call whose extent
  cannot be determined now fails the gate by name instead of falling back silently.
  **Red-proved per site**: injecting `tx.someUnauthorizedModel.` at the previously-invisible line of
  each of the three files makes the gate exit 1 in all three cases, while the real tree exits 0.
  Mutations were applied to scratchpad-backed copies; the files were verified byte-identical after.
  The widened window surfaced two pre-existing legitimate members in
  `src/app/api/user/mcp-tokens/route.ts` (`mcpRefreshToken`, `delegationSession`, `auditLog` — the
  sibling `[id]` route has listed exactly those for as long as it has existed), whose entry was
  extended. The plan's false "moves it inside" sentence was corrected in place. D10.
- Modified: `scripts/checks/check-bypass-rls.mjs`;
  `docs/archive/review/bind-stepup-to-session-credential-plan.md` (checklist correction)

### M3 Major — the E2E spec had never run
- Action: attempted, with a dedicated dev server so the existing one was untouched. Playwright exit
  1, and it never reached this branch's spec: `globalSetup` fails on the first pre-existing fixture
  user with `new row violates row-level security policy for table "users"` — a local-harness
  limitation affecting every E2E spec here, predating this branch. Not repaired in this branch (it is
  its own change and touches how tests bypass RLS). Teardown clean, no residue, port released. The
  CI `e2e` job runs the spec on the PR. Recorded as D13 with a quantified Anti-Deferral entry and a
  grep-able TODO.
- Modified: `docs/archive/review/bind-stepup-to-session-credential-deviation.md` (D13)

### m1 Minor — absent vs refused collapsed into one audit flag
- Action: `presentedCredentialIdMetadata` now returns `presentedCredentialIdAbsent: true` when the
  request carried no id, keeping `presentedCredentialIdRejected` for a value that was present and
  refused. New test asserts the absent case does **not** set the rejected flag.
- Modified: `src/app/api/auth/passkey/reauth/verify/route.ts:99-121`,
  `src/app/api/auth/passkey/reauth/verify/route.test.ts`

### m2 Minor — two checklist files absent from the diff
- Action: both re-run (25/25 pass unmodified) and the reason they need no edit recorded as D11 —
  they mock the module boundary and neither signature changed.
- Modified: `docs/archive/review/bind-stepup-to-session-credential-deviation.md` (D11)

### m3 Minor — no boundary-adjacent allow case for `presentedCredentialId`
- Action: added the exact-512 allow test, mirroring `boundCredentialId`'s.
- Modified: `src/app/api/auth/passkey/reauth/verify/route.test.ts`

### m4 Minor — truncation survival never proven through the real pipeline
- Action: added an integration case that registers a 600-character credential id, drives a mismatch
  denial through the real route, and asserts the `audit_outbox` row carries the truncated id plus its
  marker and lacks `_truncated` / `_originalSize`.
- Modified: `src/__tests__/db-integration/reauth-credential-binding.integration.test.ts`

### Verification after fixes
`npx tsc --noEmit` 0 · `npm run lint` 0 · `npx vitest run` 1008 files / 14530 passed ·
`npm run test:integration` 98 files / 611 passed · `npx next build` 0 ·
`check-pre-pr.sh run` 70/70 pass, exit 0 · `npm run check:bypass-rls` 0 (and red-provable).

## Recurring Issue Check

### Functionality expert
R1–R57 checked incrementally on top of the Phase 2 baseline; clean except as noted.
R1 clean (`BASE64URL_RE` consolidated per D3). R2 clean (`AUDIT_CREDENTIAL_ID_MAX_LENGTH` kept
distinct from `USER_AGENT_MAX_LENGTH` despite the equal value — value equality is not meaning
equality). R3 clean (zero remaining references to `verifyAuthenticationAssertion`; all three
production call sites and all four test callers moved). R4–R13 N/A to this diff's shape. R14 clean
(table-level grants cover the new column). R15/R16 N/A. R17 clean (all shared helpers reused).
R18 clean (allowlist updated exactly as derived). R19 clean (both exact-shape assertions moved).
R20–R23 N/A. R24 clean (additive-only). R25–R28 N/A. R29 spot-checked three inline citations
(`tenant-management.test.ts:45`, `with-request-log.ts`, the `reauth/options` "reachable, not
defensive" comment) — all accurate. R30–R33 N/A. R34 clean (SC1–SC6 all carry cost comparisons).
R35 N/A. R36 clean (zero suppressions remain). R37 N/A. R38 N/A. R39 N/A. R40 clean (the `reason`
union is exhaustively switched with a `never`-typed default). R41 N/A. **R42 → finding m2.**
R43 clean. R44 N/A (D8 covers the one instance). R45/R46 N/A. R47 clean (`reason` replaced the
`details`-text classification). R48 clean (C6's removal verified by grep). R49 clean (D1's guard
closes the gap the plan had flagged as unenforced). R50 clean. R51–R57 N/A.

### Security expert
R1 OK. R2 OK. **R3 → finding M2.** R4 N/A. R5 OK. R6 OK (`ON DELETE SET NULL`, not `Cascade`).
R7 OK. R8 N/A. R9 OK. R10 N/A. R11 N/A. R12 OK. R13 N/A. R14 OK. R15 OK. R16 OK (`REDIS_URL`
present in CI, so the two real-Redis integration tests are not silently skipped). R17 OK.
**R18 → finding M2** (values correct, enforcement radius insufficient). R19 OK. R20–R23 N/A.
R24 OK. R25 OK (MS7: the session cache carries neither `provider` nor the new fields). R26–R28 N/A.
**R29 → finding M2** (the plan's "moves it inside" claim false on re-verification). R30–R33 N/A.
R34 OK. R35 OK. R36 OK. R37 OK. R38 OK (the unbound-session `stale` state always has a live
sign-in-again escape; no wedge). R39 N/A. R40 OK. R41 OK. R42 OK (MS1/MS2/MS4/MS6 re-derived by
grep; no missed writer or adjudicator). R43 OK (the change only narrows). R44 OK. R45 N/A.
**R46 overlaps M2** (fixed-line window instead of actual callback scope). R47 OK (no branch on
`details`). R48 OK (one `passkeyVerifiedAt` reader remains). **R49 → M2.** R50 OK. R51 N/A.
R52 OK. R53 OK (the 512 bound justified against real ids and `METADATA_MAX_BYTES`; boundary tested).
R54 OK. R55 OK. R56/R57 N/A. RS1 N/A (no new secret comparison). RS2 OK. **RS3 → finding m1.**
RS4 OK. RS5 OK (`credentialRowId` is always server-derived). RS6 OK (the charset check runs before
serialization, closing the escaping-expansion vector by construction).

### Testing expert
R1–R57 not re-run as a rote pass (the Phase 2 baseline stands); spot checks during the
acceptance-criteria walk (R14, R18, R24, R29, R36, R42) found no contradicting evidence.
RT1 clean (every `authCredential` fixture carries `userId`; the 8 previously-uncompilable `GET()`
calls fixed). RT2 all findings testable in this harness; none rejected. RT3 clean.
**RT4 → finding C1.** RT5 clean (the real verifier is reached by the scoping tests).
RT6 clean. **RT7 → finding C1**, satisfied elsewhere; the E2E gate is wired in `ci.yml`.
RT8 clean (every denial test asserts the guarded mutation did not happen). RT9 clean (no twin).
**RT10 → finding m3**, otherwise satisfied. RT11 clean (the dedicated `TEST_USERS` entry is unique
and reclaimed by `cleanup()`; no contamination of the ~25 specs sharing other users).

## Seed Finding Disposition

Seed unavailable — no dispositions to record. (Ollama seed generation exceeded its budget on the
4759-line diff; all three experts performed full-diff review, the documented fallback.)

---

# Round 2 (incremental)

## Changes from Previous Round

All eight Round-1 findings were verified **resolved** by the three experts, each re-proving the
claim by execution rather than reading the commit message: the migration checksum was recomputed by
hand, the widened bypass-RLS scan was re-red-proved with independently chosen injections, the
`mcp-tokens` allowlist change was adjudicated against the route's real code, and the renamed I9 test
was re-run under the Round-1 mutation. Round 2's own findings are all against **the Round-1 fixes**.

## Merged Findings

| ID | Severity | Subject | Reported by | Status |
|----|----------|---------|-------------|--------|
| SEC-5 | **Major** | The comment-skip added for M2's remedy judged "is this a comment?" with a surface-form regex over raw text. A genuine `withBypassRls(` call preceded on the same line by a string containing `//` was skipped **entirely** — not scanned, not extent-walked, and not reported as an undeterminable extent, so it also escaped the fail-loud net the remedy was built to guarantee. Strictly worse than the defect M2 fixed. R47, proven by execution. | security | new |
| T2 | **Major** | ~130 new lines of parsing logic in a gate that enforces a security invariant, with **zero** automated coverage: the Round-1 red-proof was manual and not persisted, and the gate's existing test file covers only the unrelated F3 check. RT7. | testing | new |
| SEC-6 | Minor | The mirror direction: call-shaped text inside a string opened earlier on the same line was detected as a call site and its parens walked as code. Fails safe (over-scan or unresolved), but the same root cause. | security | new |
| m5 | Minor | `callExtentEnd` treated a template literal as opaque, so a `${fn(x)}` interpolation's parens were not counted. No current occurrence; filed as a question per the Finding Floor. | functionality | new |
| T1 | Minor | The regression C1 is about (route pointed at the any-credential verifier) *is* caught by the suite, but only as 13 unit tests failing with a downstream `503` — nothing asserts the call site, so a maintainer has to reconstruct the diagnosis. | testing | new |
| R43 check | — | The `mcp-tokens` allowlist gaining three models was adjudicated by two experts independently against the route's real code and `git log`: the file is untouched by this branch, the callback has always used exactly those five models, and the sibling `[id]` route has listed the same four all along. **Surfacing of pre-existing class members, not a boundary widening.** | security + functionality | resolved, no defect |

## Resolution Status — Round 2

### SEC-5 + SEC-6 + m5 Major/Minor — one root cause, one fix
- Action: the surface-form comment skip and the per-call lexer were both replaced by a single
  whole-file pass (`stripNonCode`) that blanks comment and string/template bodies to spaces,
  preserving offsets and line numbers. Every predicate — call-site detection, paren balancing, model
  extraction — now runs on code-only text, so none of them can be fooled by, or blinded by, text
  that only looks like code. This closes all three at once: the skipped-call blind spot (SEC-5), the
  string-mention false call site (SEC-6), and the untracked `${…}` interpolation (m5).
- **Red-proof, decisive**: a scratchpad copy of the checker with the old logic restored exits **0**
  on the SEC-5 fixture (blind — the defect), while the current checker exits **1** and names
  `prisma.tenantMember`. The real script was never mutated.
- Modified: `scripts/checks/check-bypass-rls.mjs`

### T2 Major — the gate's parsing logic had no tripwire
- Action: seven cases added to `scripts/__tests__/check-bypass-rls.test.mjs`, using the harness the
  F3 suite already proved fit: a model reference 30 lines past the old radius; the allow-side long
  callback that must still pass; a real call on a line whose string contains `//` (SEC-5's exact
  shape); a prose mention in a comment; a mention inside a string literal; a paren inside a string
  plus a call inside a template interpolation; and an unbalanced call that must fail **by name**.
  10/10 pass. The manual red-proofs of Rounds 1 and 2 are now persisted, which is the point — a gate
  proven once by hand has no defence against its own next edit.
- Modified: `scripts/__tests__/check-bypass-rls.test.mjs`

### T1 Minor — the regression was caught, but not legibly
- Action: `expect(mockVerifyAssertionForCredential).toHaveBeenCalledTimes(1)` moved ahead of the
  status assertion in the happy-path test, so pointing the route at the any-credential verifier fails
  on the call site rather than on a downstream 503.
- Modified: `src/app/api/auth/passkey/reauth/verify/route.test.ts:156-163`

### Verification after Round-2 fixes
`npx tsc --noEmit` 0 · `npm run lint` 0 · `npx vitest run` 1008 files / **14537** passed ·
`npm run test:integration` 98 files / 611 passed · `npx next build` 0 ·
`check-pre-pr.sh run` 70/70 exit 0 · `npm run check:bypass-rls` 0.

---

# Round 3 (incremental)

## Changes from Previous Round

Scope: `git show 72629ee14` only — the SEC-5/SEC-6/T2 remedy (`stripNonCode`, the whole-file
comment/string-blanking pass) plus its seven persisted tests and one unrelated test-legibility tweak
(T1's follow-through). Security attacked `stripNonCode` itself: does the blanking preserve what every
caller assumes (offsets, line count, delimiters), and is there an input where blanking makes the gate
**more** blind than the raw-text scan it replaced. Two were found, both execution-verified, both
against the same function. Functionality and testing re-derived the seven tests' claims against the
gate's own behavior; one test earns a Minor for not pinning what its own comment says it pins.

## Merged Findings

| ID | Severity | Subject | Reported by | Convergence |
|----|----------|---------|-------------|-------------|
| SEC-7 | **Major** | `stripNonCode` has no lexical category for regex literals — it decides comment-vs-code from two-character lookahead alone, with no concept of "this `/` opens a regex, skip its body." A `/` immediately followed by `*` or `/` *inside a regex character class* (where `/` needs no escaping — e.g. `` /[/*]/ ``) is misread as opening a real block/line comment. Once misdetected, everything after is blanked until an unrelated `*/` happens to occur — in the demonstrated case, to end of file. This erases the `withBypassRls(` call text itself, so the call is not scanned, not extent-walked, and not reported as unresolved either: the exact SEC-5 shape (a real access-control-relevant call escapes the fail-loud net) reopened via an unhandled lexical category, with a strictly wider blast radius (whole remainder of file, not one line). | security | new, execution-verified |
| SEC-8 | **Major** | The same whole-file strip now backs *every* predicate in Check 3, including the Prisma-model-allowlist scan, which previously ran over raw (unstripped) `content.split("\n")`. `stripNonCode` blanks template-literal bodies unconditionally — it does not re-enter "code" state inside `${...}` — so a genuine Prisma call written inside a template interpolation (e.g. an inline log/error message) is now invisible to the allowlist check. Verified as a **regression introduced by this diff**: the identical fixture exits 1 (correctly names `prisma.tenantMember`) against the pre-commit checker (`72629ee14~1`) and exits 0 ("OK") against the current one. Round 2's m5 covered only `callExtentEnd`'s paren-counting inside interpolations (filed as "no current occurrence"); this is a distinct, demonstrated loss in the model-allowlist scan itself. | security | new, execution-verified |
| T3 | Minor | The Round-2 test "still passes a long callback that only touches allowed models" (`check-bypass-rls.test.mjs:129`) is stated to guard against extent-scanning over-correction ("widening the window must not turn every long callback into a violation") but does not: its fixture has no code after the callback's closing brace, so a mutant `callExtentEnd` that always returns `codeLines.length` (scans to EOF unconditionally) passes this exact test unchanged (verified by mutation). The test only starts to distinguish bounded-vs-unbounded extent once an unrelated non-bypass `prisma.` call exists later in the same file — the true over-correction case is currently untested. | testing | new, execution-verified |

## Verification (executed, scratchpad-isolated; production file confirmed byte-identical throughout)

- `npx vitest run scripts/__tests__/check-bypass-rls.test.mjs` → 10/10 pass (matches the commit's claim).
- **SEC-7 PoC**: fixture `src/lib/audit/audit-outbox.ts` (allowlisted for `auditOutbox` only) containing
  `const GLOB_RE = /[/*]/;` before a `withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => { return
  tx.tenantMember.findFirst(...) })`. Current gate: `check-bypass-rls: OK` (exit 0). Same fixture against
  `72629ee14~1` (pre-Round-3 checker): exit 1, `prisma.tenantMember` named. Direct inspection of
  `stripNonCode`'s output on this input confirms the entire `export async function drain() {...}` block —
  including the real call and model reference — is blanked to spaces.
- **SEC-8 PoC**: fixture with `` log(`processed batch, unlisted model access: ${await
  tx.tenantMember.count()}`); `` inside an otherwise-`auditOutbox`-only callback. Current gate: exit 0
  ("OK"). Same fixture against `72629ee14~1`: exit 1, `prisma.tenantMember` named at the correct line.
- Backtick-toggle sanity checks: a same-line nested template (`` `${cond ? `a` : `b`}` ``) and a
  double-quoted string containing a literal backtick inside an interpolation were also tried as
  candidate desync vectors; both happened to end on an even backtick count and re-synced state before
  reaching the real call, so neither reproduces a blind spot on its own — noted as a further latent risk
  of the same design (any odd-count backtick imbalance within an interpolation desyncs the rest of the
  file) but not filed as a separate finding since no concrete instance was demonstrated.
- End-of-input edge cases (unterminated string/block-comment, trailing backslash at EOF): no crash, no
  infinite loop; an unterminated block comment or string blanks to EOF (fails safe, consistent with
  "examined nothing must not read as found nothing" *only* to the extent the call text itself survives
  blanking — which SEC-7/SEC-8 show it does not always). A file ending mid-string with a trailing
  backslash as its literal last character causes `blank(n)` to write one element past the `out` array's
  end, growing the joined output by one trailing space; traced through and confirmed inconsequential
  (the extra character lands after the last real newline, so no real line's content or number shifts) —
  such a file is not valid TypeScript and would fail the build regardless, so not filed as a finding.
- **T3 mutation**: a scratchpad copy of the checker with `callExtentEnd` forced to `return
  codeLines.length` unconditionally reproduces the *stated* Round-2 test's exact fixture at exit 0
  (indistinguishable from correct behavior) — confirming the test does not pin what it claims. Adding a
  second, unrelated `prisma.user.findFirst(...)` call after the callback's closing brace makes the two
  diverge: current gate exit 0, EOF-scanning mutant exit 1 naming `prisma.user`.

## Status of Prior Findings

| ID | Status |
|----|--------|
| SEC-5 | resolved — the same-line string-hides-a-real-call shape from Round 2 is fixed and pinned by test (`check-extent scanning › scans a real call whose line also contains a string holding '//'`), confirmed still exit 1 on that fixture. |
| SEC-6 | resolved — call-shaped text inside a string is confirmed not treated as a call site, and not reported as unresolved (pinned by test). |
| T2 | resolved — seven cases now exist and 10/10 pass; the manual red-proofs are persisted. |
| m5 | resolved for its stated scope (`callExtentEnd` paren-counting inside `${...}`) — pinned by test 6 (`is not fooled by a paren inside a string or a template interpolation`). Note: this round's SEC-8 is a distinct, broader loss (model-*visibility*, not paren-*counting*) introduced by extending the same blanking to the allowlist scan; it is a new finding, not a reopening of m5. |
| T1 | resolved — `mockVerifyAssertionForCredential` call-count assertion confirmed present ahead of the status assertion in `route.test.ts:163`; the added lines are correctly scoped and do not touch unrelated assertions. |

## Recurring Issue Check

R1–R57, RS1–RS6: reviewed incrementally against the four-file diff only.

**R47 (surface-form judgement where only a lexer can answer) → recurs a third time, now as SEC-7/SEC-8.**
This is the same rule Round 2 routed SEC-5/SEC-6 through. The remedy replaced one surface-form judgement
(regex-over-raw-text) with a hand-rolled character automaton that is *itself* still a surface-form
judgement one level down — it decides "comment vs. code" and "string vs. code" from local 1–2-character
lookahead with no token-context (no notion of "previous significant token," which is what a real parser
uses to disambiguate `/` as division vs. regex-literal start), and it has no representation at all for
"currently inside a regex literal" or "currently inside a nested-code region of a template." Two rounds
of hand-patching this class of bug in the same function is the threshold this project's own retrospective
lessons name for "escalate the mechanism instead of adding another case": the sibling gates in the same
`scripts/checks/` directory (`check-bound-unknown-ip.mjs`, `check-null-tenant-fail-closed.mjs`,
`check-session-token-hashed.mjs`, `check-cli-shell-safety.mjs`, and others) already use `ts-morph` — an
existing devDependency wrapping the real TypeScript scanner/parser — specifically to avoid this exact
class of defect. `check-bypass-rls.mjs` is the outlier still reimplementing tokenization by hand.
Recommended remedy (Major, both SEC-7 and SEC-8, one fix): replace `stripNonCode`'s character automaton
with token/trivia classification from the TypeScript compiler API (directly, or via `ts-morph`'s
`SourceFile`) for comment, string, regex-literal, and template-literal boundaries; keep call-site
detection and model extraction as AST queries (`CallExpression` where the callee resolves to
`withBypassRls`; `PropertyAccessExpression` chains rooted at `prisma`/`tx`) rather than regex-over-text
matched line-by-line. This structurally closes the regex-literal and template-interpolation classes at
once — a parser does not need a special case for "is this `/` a regex" or "did this `` ` `` close the
outer template," it already knows. Remedy Floor: (1) allow side — the seven existing tests plus the
F3 suite must still pass unmodified, and `npm run check:bypass-rls` must still exit 0 on the real tree;
(2) red-prove each of SEC-7 and SEC-8 separately against the rewritten gate (the two PoCs above, reused
as new persisted tests, must flip from exit-0 to exit-1 naming `prisma.tenantMember`); (3) a source file
the TS scanner cannot tokenize (a genuine syntax error) must route to the existing unresolved-extent
fail-loud path, not silently pass; (4) the fix must not drop the fail-loud unresolved-extent report path
itself, and must not narrow SEC-5/SEC-6/T2's existing coverage to buy this; (5) boundary: a Prisma
model access that is *genuinely* reachable code inside a template interpolation or inside a callback
nested arbitrarily deep within `${...}` must be flagged exactly like any other call-site-scoped access —
the AST approach makes this the default outcome rather than a case to special-case for.
R42 (re-derive the member-set for anything class-shaped) applied here: the class is "any JS lexical
category `stripNonCode` doesn't model" — regex literals and template re-entrancy are the two demonstrated
members; JSX attribute text and tagged templates were checked and found to behave the same
pre- and post-diff (not a regression, out of this round's scope).
All other R-numbers: no new evidence contradicting Round 1/2's dispositions; not re-litigated.

RT7 (a gate proven once by hand has no tripwire against its own next edit) — the stated purpose of
T2's seven tests. **T3 shows one of the seven does not fully deliver on it**: the allow-side long-callback
test cannot fail for the over-correction reason its own comment claims, because its fixture has nothing
after the call site that a wider-than-correct window could wrongly ingest. Same rule Round 2 fired,
now against Round 2's own remedy.
RT1–RT6, RT8–RT11: no new evidence; not re-litigated (out of this round's diff).

## Seed Finding Disposition

Not applicable this round — targeted incremental review of one commit, not a fresh triangulate pass.

```json
[
  {
    "id": "SEC-7",
    "severity": "Major",
    "file": "scripts/checks/check-bypass-rls.mjs",
    "line": 244,
    "problem": "stripNonCode has no lexical category for regex literals; a '/' inside a regex character class immediately followed by '*' or '/' (e.g. /[/*]/) is misread as opening a real comment, blanking everything after it — up to end of file in the demonstrated case — including real withBypassRls call sites and prisma/tx model references, with no unresolved-extent report either.",
    "failure_scenario": "A file allowlisted only for 'auditOutbox' contains `const GLOB_RE = /[/*]/;` before `withBypassRls(prisma, BYPASS_PURPOSE.AUDIT, async (tx) => { return tx.tenantMember.findFirst(...) })`. The gate exits 0 ('OK'); the pre-Round-3 checker on the same input exits 1 and names prisma.tenantMember.",
    "recommended_fix": "Replace the hand-rolled comment/string automaton with token classification from the TypeScript compiler API (directly or via the existing ts-morph dependency, already used by sibling gates in scripts/checks/), so regex-literal boundaries are determined by the real grammar instead of two-character lookahead. Red-prove against this exact fixture (must flip to exit 1 naming prisma.tenantMember) without regressing any of the seven existing tests or check:bypass-rls on the real tree.",
    "escalate": false
  },
  {
    "id": "SEC-8",
    "severity": "Major",
    "file": "scripts/checks/check-bypass-rls.mjs",
    "line": 342,
    "problem": "Check 3's Prisma-model-allowlist scan now runs exclusively over stripNonCode's output, which blanks template-literal bodies unconditionally (no re-entry to code state inside ${...}). A genuine Prisma call written inside a template interpolation is invisible to the allowlist check — a regression from the pre-diff behavior, which scanned raw unstripped lines and therefore still matched the literal substring.",
    "failure_scenario": "A callback allowlisted only for 'auditOutbox' contains `log(`processed batch, unlisted model access: ${await tx.tenantMember.count()}`);`. The gate exits 0 ('OK'); the identical fixture against the pre-Round-3 checker (72629ee14~1) exits 1 and names prisma.tenantMember at the correct line.",
    "recommended_fix": "Same remedy as SEC-7 (shared root cause): move model-reference extraction to an AST query (PropertyAccessExpression chains rooted at prisma/tx) over the real parse tree, which resolves expressions inside template interpolations by construction rather than needing template bodies to stay opaque. Add the demonstrated fixture as a persisted test; it must flip to exit 1 naming prisma.tenantMember.",
    "escalate": false
  },
  {
    "id": "T3",
    "severity": "Minor",
    "file": "scripts/__tests__/check-bypass-rls.test.mjs",
    "line": 129,
    "problem": "The 'still passes a long callback that only touches allowed models' test is stated to guard against extent-scanning over-correction but its fixture has no code after the callback's closing brace, so it cannot distinguish correct bounded extent from a mutant that always scans to end of file.",
    "failure_scenario": "A mutant callExtentEnd forced to always return codeLines.length passes this exact test unchanged (exit 0). Only adding an unrelated prisma.user.findFirst(...) call after the callback's closing brace makes the mutant diverge (exit 1, false positive) from the correct implementation (exit 0).",
    "recommended_fix": "Add an unrelated non-bypass prisma.<model> call after the withBypassRls callback's closing brace in this fixture (or a sibling test), asserting exit 0, so the test can actually fail if extent-bounding regresses to an unbounded scan.",
    "escalate": false
  }
]
```

---

# Round 4 (incremental)

## Changes from Previous Round

Scope: `git show d4085e076` only — the round-3 remedy that moved the model scan onto the parse tree,
plus its tests. Three experts ran in parallel. Ollama seed generation was skipped: this is a targeted
review of one commit, not a fresh triangulate pass.

All three lanes converged on the same shape, independently: **the AST move was applied to one
predicate, and its four siblings were left deciding code questions by spelling.** Security reached it
from the threat model (SEC-9/10/11/12), functionality from reading the comments against the code
(F1/F2/F3), testing from mutation coverage (T-4/5/6/7). SEC-7 and SEC-8 — the findings the round-3
commit was written to close — are confirmed **resolved**, by re-running both proof-of-concept
fixtures against the shipped gate and its parent. T3 is confirmed resolved by the mutation that
originally exposed it.

Two of the new findings are regressions **introduced by** d4085e076; two are pre-existing blind spots
the AST rewrite made cheap to close and did not; one is a fail-loud control that could never fire.

## Merged Findings

| ID | Severity | Subject | Reported by | Convergence |
|----|----------|---------|-------------|-------------|
| **R4-1** | **Major** | The fail-loud "unparseable" net asks whether any `withBypassRls` **identifier** survives the parse. An `import { withBypassRls }` specifier is one, so the net could never fire for a file that imports the helper — which is every real call site. A syntax error that swallows a real call therefore exits **0** with `check-bypass-rls: OK`. Round 3's own Remedy Floor clause (3) declared this property kept; it was not. The mirror direction is a new false alarm: a healthy file mentioning the helper only in prose was reported as "could not be parsed". | security SEC-10, functionality F2, testing T-4/T-5 | **all three lanes**, execution-verified |
| **R4-2** | **Major** | Check 3a (the C2 tx-less rule) is introduced by a comment saying it reads the call's arguments from the AST; the four lines under it re-split the **raw** file and regex a 10-line window. At `d4085e076~1` that window came from comment-blanked text, so this is a regression: a compliant `(tx) =>` call whose comment quotes the banned `() =>` form — this repo's own comment style — now reds the build. The 10-line blind spot the AST was supposed to remove also survives here. | security SEC-9, functionality F1, testing T-6/T-9 | **all three lanes**, execution-verified |
| **R4-3** | **Major** | `modelRefsIn` identifies the bypassed client by name (`tx`/`prisma`) on a tree that holds the callback's actual parameter. Renaming the callback parameter to `db` removes the file from the model allowlist's view with a one-token edit; a nested `tx.$transaction(async (inner) => …)` client is invisible for the same reason. Not a regression — the deleted regex had the identical limitation — but the AST made closing it a two-line change and it was not taken. | security SEC-11, testing T-10 | security+testing |
| **R4-4** | **Major** | The file filter `BYPASS_CALL_RE` requires the literal text `withBypassRls(`, which `import { withBypassRls as wb }` … `wb(prisma, …)` does not contain. The file is skipped whole, so an aliased call escapes the **file** allowlist, not merely the model allowlist. Raised as a question under the Finding Floor; promoted to Major after confirming no lint rule or sibling gate constrains the import form. | security SEC-12 (as question) | single-perspective, execution-verified |
| **R4-5** | Major | Three predicates added or modified by this diff survive deletion with the suite green and the real tree green: the fail-loud net, the tx-less check, and `.tsx` scanning (dropping `.tsx` from the scan set silently unscans the two allowlisted `.tsx` call sites). RT7. | testing T-4/T-6/T-7 | single-perspective, mutation-verified |
| R4-6 | Minor | Documentation rot around the rewrite: `ast-project.mjs`'s maintained adopter registry omits its newest adopter and lists 4 where the derivation gives 9; the gate's own comment said "five sibling gates"; `PRISMA_MODEL_RE`'s doc comment outlived the constant; the plan's "10-line radius" paragraph and its round-1 correction are both falsified; D14's "13 tests" counts 3 unrelated F3 tests. | functionality F3/F4/F5/F7/F8/F9 | single-perspective |
| R4-7 | Minor | D5 states seven CI gates have no pre-PR equivalent. Five are wired — `pre-pr.sh` invokes them by script path, not by the `npm run check:*` alias the entry was derived from. | testing T-11 `[Adjacent]` | single-perspective |

### Findings assessed and rejected

The testing expert's evidence for R4-7 cited `scripts/pre-pr.sh:332` and its four siblings. A grep for the
npm alias names returned nothing, which read as a hallucinated citation; re-checking by script path
confirmed the line numbers exactly. Recorded because the *rejection* would have been the error — the
claim was right and the first instrument was wrong.

## Resolution — one mechanism, applied to the whole class

R4-1 through R4-5 are one defect wearing five faces, and the branch has now paid for fixing the
instance instead of the class three times. So the remedy is not five patches. Every code question in
`check-bypass-rls.mjs` is now answered by the parse tree, and the file states that as its rule rather
than as a description of what one function happens to do:

| Predicate | Was | Now |
|---|---|---|
| which files to scan | raw text `withBypassRls\s*\(` — a **verdict** | raw text `with*Rls|tenant-rls` — a **prefilter** only, deliberately a superset (238 files parsed vs 88, ~0.7 s) |
| which calls are calls | name equality on callee text | local binding names resolved from the `tenant-rls` import, aliases included |
| which callback runs | inline function arguments only | found by kind (position differs per helper); an identifier resolves to its unique function-valued binding, else the site is **named** |
| which identifier is the client | `=== "tx" \|\| === "prisma"` | the callback's own declared parameter, `prisma`, and nested `$transaction` parameters |
| tx-less (C2) | raw-text 10-line window regex | the callback's declared parameter count |
| F3 unused `tx` | raw-text regex for the eslint-disable words | the parameter's actual use in the callback body |
| parse health | "does any `withBypassRls` identifier survive?" | `sf.compilerNode.parseDiagnostics`; absent ⇒ deny |

Three full walks of `src/` collapse into one. `SCAN_RADIUS`, `TX_LESS_CALLBACK_RE`,
`RLS_UNUSED_TX_DISABLE_RE`, `BYPASS_CALL_RE` and `PRISMA_MODEL_RE`'s orphaned comment are gone.

**Two pre-existing production issues surfaced rather than fixed**, recorded in
`INDIRECT_CALLBACK_ALLOWLIST` with the reason and a grep-able TODO (D15): the vault status and
unlock/data routes pass `withTenantRls` their own wrapper's `fn` parameter, whose
`fn: () => Promise<T>` contract is the tx-less form C2 forbids one level up. Allowlisting keeps the
gate honest about what it did not examine and forces review of any *new* such site.

### Verification

**Allow side.** `node scripts/checks/check-bypass-rls.mjs` on the real tree → exit **0**. Unit suite
1008 files / **14552** passed (was 14540; +12 new tests). `npm run lint` 0 · `npm run typecheck` 0 ·
`check:migration-drift` 0 · `check:crypto-domains` 0 · `check:team-auth-rls` 0 ·
`check-state-mutation-centralization` 0. Every status read from the command's own exit, never
through a pipe (R44).

**Deny side, per finding, each run against the shipped round-3 gate first.** Every row below is an
observed exit status, not an expectation:

| Input | `d4085e076~1` | `d4085e076` | now |
|---|---|---|---|
| R4-4 aliased import, non-allowlisted file | 0 | 0 | **1** — "not on the allowlist" |
| R4-1 unterminated template swallowing a real call | 0 | 0 | **1** — named unscanned |
| R4-1 healthy file, prose mention only | 0 | **1** (false) | **0** |
| R4-2 compliant call, comment quotes banned form | 0 | **1** (false) | **0** |
| R4-3 callback parameter named `db` | 0 | 0 | **1** — `prisma.tenantMember` |
| R4-3 nested `$transaction` client | 0 | 0 | **1** |
| callback passed by name | 0 | 0 | **1** |
| callback unresolvable (wrapper's own parameter) | 0 | 0 | **1** — named, not silently passed |
| SEC-7 regex character class | 0 | 1 | **1** (preserved) |
| SEC-8 template interpolation | 0 | 1 | **1** (preserved) |
| F3 eslint-disable words inside a string, `tx` used | **1** (false) | **1** (false) | **0** |

**Mutation proof (R4-5, RT7, Remedy Floor clause 2).** Eleven mutations applied one at a time to a
scratchpad copy, each reddening a *different* clause: prefilter, client-name set,
nested-`$transaction` traversal, by-name callback resolution, the unresolvable-callback report, the
tx-less check in both directions, the F3 predicate, the fail-loud net, and `.tsx` scanning. Where a
mutant still exits 1 for the wrong reason — dropping by-name resolution turns a model catch into an
unresolved-callback report — the test discriminates on the **message**, which is why those
assertions name the string; a status-only assertion would have been vacuous there. The harness
prints `MUTATION DID NOT APPLY` and refuses rather than reporting a pass, which it did four times on
a first attempt with bad quoting (R50).

**Coverage differential.** All 93 `ALLOWED_USAGE` entries emptied in all three implementations, run
over the real `src/` tree, `(file, model)` pairs compared: **nothing lost** against round 3, two
gains (`passkey-enforcement.ts`'s by-name callback). One pair present in the round-2 raw-text scan is
absent from both AST versions — `src/lib/notification.ts:78` (`prisma.notification`), which is
`typeof tx.notification.create` inside a `Parameters<…>` **type query**. A type position is not a
runtime access and the model is allowlisted regardless: examined and accepted, not a loss.

**Production files were never mutated.** All red-proofs ran on scratchpad copies; `git status
--porcelain` names only the four intended files.

## Status of Prior Findings

| ID | Status |
|----|--------|
| SEC-7 | **resolved** — regex-literal fixture: parent exit 0, current exit 1 naming `prisma.tenantMember`; still exit 1 after this round's rewrite, and pinned by test. |
| SEC-8 | **resolved** — template-interpolation fixture: same shape, same result, still pinned. |
| T3 | **resolved** — `callExtentEnd` is gone; the equivalent over-correction mutant (`modelRefsIn(call)` → `modelRefsIn(sf)`) reds exactly the reworked test and no other, so it now fails for the reason its comment claims. |

## Recurring Issue Check

**R47 (surface-form adjudication where an interpreter defines the meaning) — fires a fourth time,
and this round is the one that closes the class rather than an instance.** Rounds 1–3 each replaced
one surface-form predicate with a better-informed surface-form predicate. Round 3 finally reached the
parser but applied it to a single question, so the rule the file recorded was "the model scan uses the
AST" — under which leaving the tx-less check on a raw-text window is consistent. The rule is now "no
predicate in this file decides a code question by surface form", with the one survivor named as a
prefilter and argued for. R42's convergence condition is met the same way: the class was re-derived
from the mechanism (every predicate in the file), not from the prior rounds' finding list, and each
member is pinned by a persisted, mutation-verified test in a gate wired into `scripts/pre-pr.sh:333` and
`ci.yml`.

**R29 (rationale accuracy) — fires six times, all corrected.** The costly one was D14's "the parser
recovers from truncation and still yields the call", which is the reason given for deleting the old
fail-loud path and is false in general. Next costliest: the Check 3a comment describing the correct
implementation above code doing the rejected one. Also corrected: the adopter registry, the "five
sibling gates" and "13 tests" counts, `PRISMA_MODEL_RE`'s orphaned comment, and the plan's radius
paragraph. **My own R29 failure is recorded too** — see "Findings assessed and rejected": I derived
D5's member set from the spelling `pre-pr.sh` does not use and nearly rejected a true finding.

**R49 (claim stronger than implementation) → R4-1.** The fail-loud net was documented as a structural
guarantee and was a tripwire that could not fire for its own population. **R50** → the same, plus the
mutation harness's refusal path. **R46 (scope-blind binding resolution)** → R4-3, and the fix declines
to guess: a name with several function-valued bindings resolves to none and the site is reported.
**R43** → the two round-3 widenings were both fail-closed false positives; the coverage differential
confirms no fail-open widening in either direction. **R45** → measured, ~0.7 s over 238 parsed files,
bounded by the prefilter. **R1/R17** → `ast-project.mjs`'s registry now records this gate as a partial
adopter *with the reason its walk is not migrated* (walkSourceFiles returns `[]` for a missing root;
this gate must fail loudly there).

**RT7/RT10** → R4-5, closed: every new deny case has a paired allow case, and both sides are
mutation-proven. **RT11** → clean; fixtures live in `mkdtempSync` dirs removed by `afterEach`, which
runs on the failure path.

## Environment Verification Report

Unchanged from Round 1 except as noted. The two paths still **not verified** are the same two, both
predicted in Phase 1 and both carrying Anti-Deferral entries: the E2E dialog-selection spec (D13 —
`globalSetup` fails seeding the first pre-existing fixture user with an RLS violation, a local-harness
limit predating this branch; the CI `e2e` job runs it on the PR) and the manual two-authenticator
scenarios 1–7 on `mrx33` (VE2 — no access from this session; outstanding for the human merge gate).
This round touched neither path: its entire diff is a CI gate and its tests.

---

# Round 5 (incremental)

## Changes from Previous Round

Scope: `git show e535bb16f` only — the Round-4 remedy. Three experts in parallel, each told to
assume nothing about it and to re-prove Round 4's own claimed prior-vs-now table by execution.

All three re-derived that table independently and **every row reproduced**, as did the coverage
differential, the `src/lib/notification.ts:78` type-query exception, the adopter count, and all nine
prior-verdict comments in the new tests. What they also found is that Round 4 closed the class it
enumerated and then declared the class closed — and the enumeration was of *the predicates Round 4
changed*, not of every predicate in the file. R47 therefore fires for a **fifth** consecutive round.

## Merged Findings

| ID | Severity | Subject | Reported by | Convergence |
|----|----------|---------|-------------|-------------|
| **R5-1** | **Major** | **A regression Round 4 introduced.** `callbackOf` accepted a by-name callback when exactly one *function-valued* binding of that name existed anywhere in the file. So an unrelated `const job = async (tx) => …` in a sibling function resolved a `job` that actually referred to the enclosing function's own parameter: the gate scanned a body the call never runs and printed OK — **in place of** the "could not be resolved" report Round 4 had just added. Adding six lines of unrelated code turns a fail-loud report into a silent pass. | security S5-1 | execution-verified, both directions |
| **R5-2** | **Major** | Round 4's header states "no predicate in this file decides a code question by surface form". False when written: `declaresUnusedTx` compared `getName() !== "tx"`, so renaming the unused parameter to `db` defeats F3 entirely; and `clientNamesIn` used `getName()` on the first parameter, which returns pattern text for a destructuring binding, so `async ({ tenantMember }) => tenantMember.findFirst()` hides the model. Both are the exact shape R4-3 fixed one function earlier. | security S5-4/S5-5, functionality F1 | **security+functionality** |
| **R5-3** | **Major** | The prefilter's stated closure argument — "a file matching neither cannot contain a call" — is false for a **renaming re-export**: the caller's text names neither the helper nor the module, so the file is never parsed and escapes the *file* allowlist, R4-4's outcome by a spelling Round 4 did not enumerate. Also `localHelperNames` keys aliases on `/tenant-rls$/`, so `@/lib/tenant-rls.js` resolves no aliases. | security S5-2/S5-3, functionality F5 | **security+functionality** |
| **R5-4** | **Major** | Check 2 (`BYPASS_PURPOSE`) was rewritten by Round 4 from a text regex to an AST scan, kept file-level granularity, and gained a comment claiming *call-site* enforcement. It has **zero** tests: its push, its report block and its definition-file exemption are each deletable with the suite and the real tree green. A file whose only call site passes a string literal exits 0 if any `BYPASS_PURPOSE.X` sits elsewhere. | testing R5-T1, functionality F2 | **testing+functionality** |
| **R5-5** | **Major** | "154 files parsed instead of 88" does not reproduce — measured **238**, repeated across the gate header, D15 and this document. 154 was the count of files importing `@/lib/tenant-rls`, not the regex's match count. The `~0.7 s` half of the same sentence does reproduce. R29. | all three lanes | **all three lanes** |
| **R5-6** | **Major** | `ast-project.mjs`'s new "Partial adopter" note is wrong on both load-bearing claims: `isScannableSourceFile` already excludes `src/lib/tenant-rls.test.ts`, and the two exclusion predicates select the **same** 1011 files out of 2066 — the differential is empty. "Five tx-less calls" is 15. And the property the note justifies is not delivered: a present-but-empty `src/` printed OK. | functionality F3 | single-perspective, execution-verified |
| **R5-7** | Major | 15 of 50 single mutations survive the suite; 13 survive the real tree too. Untested clauses include `callbackOf`'s uniqueness rule, `helperCallsIn`'s property-access branch, `localHelperNames`' canonical seed, `clientNamesIn`'s `"prisma"` seed, `modelRefsIn`'s `$`-prefix skip (allow side), and `INDIRECT_CALLBACK_ALLOWLIST` (allow side). | testing R5-T2/T3/T4/T5 | single-perspective, mutation-verified |
| R5-8 | Minor | `callbackOf` cannot resolve a `FunctionDeclaration` (only `VariableDeclaration`), contradicting its own doc — and the remedy it prints ("add the file to `INDIRECT_CALLBACK_ALLOWLIST`") would unscan the whole file. Fail-closed, but its prescribed resolution is fail-open. | functionality F6, security S5-9 | security+functionality |
| R5-9 | Minor | `f3DisableViolations` no longer holds eslint-disable findings; two test assertions pin `"could not be determined"`, a message removed in Round 3, so neither can fail; the test file still cites the renamed `F3_UNUSED_TX_DISABLE_ALLOWLIST`. | functionality F7, testing R5-T10 | functionality+testing |
| R5-10 | Minor | `INDIRECT_CALLBACK_ALLOWLIST` is keyed by file, so a new unresolvable call site inside an already-listed file is excused without review — the review doc's "forces review of any new such site" is stronger than the code. | security S5-6, functionality F8 | security+functionality |
| R5-11 | Major | The scan root is `src/` only. `scripts/tenant-domain.ts` (6 call sites, runs against a live database) and `scripts/manual-tests/share-access-audit.ts` (5 tx-less `withBypassRls`) have no file entry, no model constraint and no C2 verdict. The class was re-derived over *predicates in a file*, not over *files that can call the helper*. | security S5-8 | single-perspective |

### Findings assessed and not adopted

None rejected as wrong. The security lane's `escalate: true` on R5-1/R5-2/R5-3/R5-11 was assessed:
each is a CI-gate blind spot for a code shape that does not occur in the tree today, not a live
bypass, so none was escalated to Critical.

## Resolution — scope decision, taken with the user

This is the fifth consecutive round whose findings are in the previous round's fix, all inside one
CI gate. The branch's actual subject — contracts C1–C7, the step-up credential binding across 45
routes — has been clean in all three lanes for **four** consecutive rounds; the gate is here only
because contract `C5`'s two new allowlist entries needed enforcing. Three options were put to the
user: narrow the branch by reverting the gate (costing the enforcement `C5` needs), fix everything
including the structural items, or fix the regressions and the false claims and declare the rest.
**The user chose the third.**

**Fixed** — R5-1, R5-2, R5-3 (both halves), R5-5, R5-6, R5-8, R5-9, and the empty-corpus hole:

| Predicate | Was | Now |
|---|---|---|
| by-name callback resolution | one function-valued binding **anywhere in the file** | the bindings **visible from the call** — scope-enclosing, all binding kinds counted for ambiguity, `FunctionDeclaration` included |
| F3 unused client | `getName() !== "tx"` | the parameter's own binding; a same-named **property access** is not a use |
| client identifier | `getName()` on a destructuring pattern (matches nothing) | destructured properties read as model accesses directly |
| import specifier | `/tenant-rls$/` | `/(^\|\/)tenant-rls(\.[cm]?[jt]sx?)?$/` |
| empty `src/` | `check-bypass-rls: OK`, exit 0 | refuses, naming the working directory |
| success output | `OK` | `OK (parsed 238 of 2066 source files)` — the count cannot rot silently again |

**Declared, not closed** — R5-4, R5-10, R5-11 and the re-export half of R5-3, each with its reason,
its verification, and (for three of the four) its non-occurrence in today's tree, recorded in **D16** *and in the gate's own
header* where the next editor reads it. R5-7's remaining untested clauses are covered by the same
declaration: they guard the shapes named there.

The header no longer claims the class is closed. Declaring closure is precisely what made this round
necessary — Round 4 enumerated the predicates it changed, called that the class, and wrote the claim
into the file.

### Verification

**Allow side.** Real tree exit **0**, `check-bypass-rls: OK (parsed 238 of 2066 source files)`.
Suite 33/33. Full unit suite 1008 files / **14560** passed. `npm run lint` 0 · `npm run typecheck` 0 ·
`check:migration-drift` 0 · `check:crypto-domains` 0 · `check:team-auth-rls` 0 ·
`check-state-mutation-centralization` 0. Every status read from the command's own exit (R44).

**Deny side, each run against the Round-4 gate first** — observed statuses, not expectations:

| Input | Round 4 | now |
|---|---|---|
| by-name callback + unrelated same-named binding (R5-1) | 0 | **1** — "could not be resolved" |
| the same without the decoy (control) | 1 | **1** |
| unused client parameter renamed `db` (R5-2) | 0 | **1** — "never uses it" |
| `tx` used only as `cfg.tx` (property position) | 0 | **1** |
| destructured client `({ tenantMember })` (R5-2) | 0 | **1** — `prisma.tenantMember` |
| aliased import from `@/lib/tenant-rls.js` (R5-3) | 0 | **1** — "not on the allowlist" |
| callback as `async function job(tx)` (R5-8) | 1, "could not be resolved" | **1**, `prisma.tenantMember` |
| present-but-empty `src/` (R5-6) | 0, "OK" | **1** |
| Check 2 string-literal purpose (R5-4) | 0 | **0** — declared, D16 |

**Mutation proof.** Seven mutations applied singly to a scratchpad copy, each reddening a different
clause: the scope filter, `FunctionDeclaration` indexing, destructured-model extraction, the `tx`
name gate, the property-name exclusion, the specifier regex, and the empty-corpus refusal. Two still
exit 1 under mutation and are discriminated by **message** — dropping `FunctionDeclaration` turns a
model catch into an unresolved report — which is why those assertions name the string rather than
the status. The patcher aborts with `ANCHOR MATCHED n TIMES — MUTATION DID NOT APPLY` rather than
running, and did so once (R50).

**Coverage differential** against Round 4, all 93 allowlist entries emptied, real tree:
**279 pairs both sides — nothing lost, nothing gained.** Every fix addresses a shape the tree does
not yet contain, which is what a gate is for.

**Production files were never mutated**; all red-proofs ran on scratchpad copies.

## Status of Prior Findings

Round 4's R4-1 … R4-7 all confirmed **resolved** by independent re-execution of the full
prior-vs-now table; no row failed to reproduce. R5-1 is a *new* defect in R4-4's remedy, not a
reopening.

## Recurring Issue Check

**R47 — fires a fifth consecutive round, and this round stops claiming otherwise.** The lesson is
not about parsers. Each round derived the class as "the predicates I just touched", fixed those, and
wrote a closure claim into the file; the next round then found the siblings. What changes here is
the *claim*, not just the code: the header now enumerates what is known **not** to be covered, so
the next editor inherits the gaps rather than the assurance.

**R42** — the member set was re-derived twice more this round: over *every* predicate in the file
(finding `declaresUnusedTx` and Check 2, which Round 4's eleven-clause enumeration missed), and over
*files that can call the helper* (finding the `scripts/` tree, R5-11). Both derivations are recorded
in D16 so a sixth round does not have to rediscover them.

**R29 — fires on my own prose.** "154 parsed files" was wrong and repeated in three places; the
`ast-project.mjs` note was wrong on both its claims. The gate now prints the count at runtime, and
the header carries the reproducing command beside it rather than the bare number.

**R49** → R5-2/R5-3/R5-4/R5-6: five statements broader than what executed. **R46** → R5-1, closed by
scope-visibility rather than by a wider search. **R50** → the empty-corpus refusal and the published
subject count. **R43** → clean; differential identical. **R45** → see Round 6: the round-5 commit added ~25%, since corrected.
**RT7/RT10** → the seven new fixes each carry a paired allow case and a single-clause mutation;
R5-7's remaining survivors are the declared-gap clauses.

## Environment Verification Report

Unchanged. The two paths still **not verified** are the same two, both predicted in Phase 1 with
Anti-Deferral entries: the E2E dialog-selection spec (D13 — `globalSetup` RLS failure predating this
branch; the CI `e2e` job runs it on the PR) and the manual two-authenticator scenarios 1–7 on
`mrx33` (VE2 — no access from this session). This round's diff is a CI gate and its tests; it
touches neither path.

---

# Round 6 (verification, scoped)

## Changes from Previous Round

The single scoped verification round the user's Round-5 decision called for. Scope: `git show
ed3e2ec5c` only, with the four D16 gaps explicitly out of scope. Three experts, each asked three
questions: do the Round-5 fixes work, did they create new defects, and are the declared gaps
honestly declared.

**Every Round-5 fix reproduced** — all nine rows of the prior-vs-now table, the 279-pair coverage
differential, the declared-gap supporting facts (193 call sites with 0 missing purposes; `rg` for a
re-export empty; 6+5=11 sites under `scripts/`), and the 33/33 suite. And the round found new
defects in that same fix, which is the fifth time running.

## Merged Findings

| ID | Severity | Subject | Reported by | Convergence |
|----|----------|---------|-------------|-------------|
| **R6-1** | **Major** | **Fail-open I introduced.** `callbackOf` reached `decl.getInitializer?.()` for whatever single visible declaration it found. On a `Parameter` that returns the **default value** — one of the values a caller may supply, not the one supplied at any call that passes an argument. `drain(job = async (tx) => tx.auditOutbox.findMany())` called as `drain(async (tx) => tx.user.deleteMany())` exits **0**: a bypassed `deleteMany` never scanned. Verbatim the shape Round 5's own commit message says it fixed. | security R5V-1 | execution-verified |
| **R6-2** | **Major** | **Fail-open I introduced.** `bindingIndex` indexed each declaration under `getName()`, which for a destructuring binding returns the *pattern text* (`"{ job }"`). So a destructured binding is indexed under a name no identifier can equal, the ambiguity count misses it, and an unrelated same-named `const` elsewhere resolves as unique — the gate scans a body the call never runs. The same `getName()`-on-a-pattern mistake Round 5 fixed in `clientNamesIn` and `declaresUnusedTx`, left in the function it added. | functionality F1 | execution-verified |
| **R6-3** | **Major** | **False claim I wrote.** "~0.7 s, unchanged from before the widening", carried into four places including the R45 verification verdict. Measured 0.656 → 0.797 s (means over 8 runs each; distributions do not overlap), ~+21–25%. Cause measured, not inferred: `bindingIndex` ran for all 238 parsed files while only 3 ever consult it. | functionality F3 | execution-verified |
| **R6-4** | **Major** | **False claim I wrote.** D16's justification says "each requires a code shape that does not occur today" for all four gaps — eleven lines after the same entry enumerates gap 3's live occurrences. Re-derived: `scripts/tenant-domain.ts` 6 + `scripts/manual-tests/share-access-audit.ts` 5 = **11** live unreviewed call sites. Gaps 1, 2 and 4 do genuinely not occur. | functionality F2 | execution-verified |
| **R6-5** | **Major** | Two clauses Round 5 added — the scope-visibility filter and `bindingIndex`'s `Parameter` kind — survive removal with all 33 tests green. The test credited with covering the filter is satisfied by the *ambiguity count* instead: its fixture binds the name twice, so `visible.length !== 1` either way. RT7. | testing T5-1/T5-2 | mutation-verified |
| **R6-6** | **Major** | `run()` returned `{ code: 0, stderr: "" }` on the success path — `execFileSync` surfaces stderr only when it throws. Every `expect(stderr).not.toContain(...)` paired with `code === 0` was asserting against a hardcoded empty string. Three sites, two of them the assertions Round 5 repointed off a dead message onto a live one — and onto a dead channel. Pre-existing harness defect. | testing T5-3 | execution-verified |
| R6-7 | Minor | `destructuredModelRefs` walked every `BindingElement` descendant, so `...rest` was reported as `prisma.rest` — a model that does not exist — while `rest.user.deleteMany()` reached through it stayed invisible. A new false positive concealing a blind spot. Nested patterns emitted delegate methods as models. | security R5V-3 | execution-verified |
| R6-8 | Minor | A reassignable (`let`/`var`) callback binding was resolved from its initializer, so a function reassigned before the call is scanned by nothing. Pre-existing (Round 4 identical), one line to refuse. | security R5V-2 | execution-verified |
| R6-9 | Minor | A bodyless `FunctionDeclaration` (ambient/overload signature) resolved, and was then misreported as an F3 unused-`tx` violation whose printed remedy — allowlist the file — would unscan it entirely. | security R5V-4 | execution-verified |
| R6-10 | Minor | The F3 message named `` `tx` `` although `declaresUnusedTx` is now parameter-name agnostic, so an author writing `async (db) => …` was told they declared `tx`. And `parsed 238 of 2066 source files` divided by the raw walk, 1055 of which are test files skipped unconditionally — reading as an 11.5% coverage ratio where the real one is 23.5%. | functionality F5/F6 | single-perspective |

## Resolution

All ten fixed. R6-1/R6-2/R6-7/R6-8/R6-9 are one function's worth of "refuse rather than guess":

| Predicate | Was | Now |
|---|---|---|
| `bindingIndex` keying | `getName()` — pattern text for a destructuring binding | each `BindingElement`'s own bound name |
| callback from a `Parameter` | its default value | refused — the caller decides |
| callback from `let`/`var` | its initializer | refused — only `const` answers |
| callback from a bodyless declaration | the signature | refused — the implementation is elsewhere |
| `...rest` in a client pattern | reported as a model | a receiver (`clientNamesIn`), models read through it |
| nested pattern elements | reported as models | skipped — delegate methods are not models |

R6-3 is fixed by *making the claim true* rather than restating it: `bindingIndex` is now built
lazily on first use, so the 235 files that never pass a callback by name never pay for it.
Re-measured **0.67–0.69 s**, indistinguishable from Round 4's 0.68 — the sentence now reproduces.

R6-6: `run()` uses `spawnSync`, returning both streams from the process on both paths, so the three
`not.toContain` assertions can now fail. R6-4: the justification is per-gap — 1, 2 and 4 on
non-occurrence, gap 3 explicitly **on scope, not on non-occurrence**, with its 11 live sites named.
R6-10: the F3 message prints the offending parameter's real name; the success line divides by the
**scannable** set (`parsed 238 of 1011 scannable source files`).

### Verification

**Allow side.** Real tree exit **0**, `check-bypass-rls: OK (parsed 238 of 1011 scannable source
files)`. Suite **40/40** (was 33). Full unit suite 1008 files / **14567** passed. `lint` 0 ·
`typecheck` 0 · `check:migration-drift` 0 · `check:crypto-domains` 0 · `check:team-auth-rls` 0 ·
`check-state-mutation-centralization` 0. Every status from the command's own exit (R44).

**Deny side, each against the Round-5 gate first:**

| Input | Round 5 | now |
|---|---|---|
| callback = a parameter's default value (R6-1) | **0** | **1** — "could not be resolved" |
| by-name callback shadowed by a destructured parameter (R6-2) | resolved the wrong body | **1** — "could not be resolved" |
| by-name callback, single out-of-scope binding (R6-5) | 1 | **1**, now pinned by a test |
| by-name callback shadowed by a plain parameter (R6-5) | 1 | **1**, now pinned by a test |
| `let` callback reassigned before the call (R6-8) | **0** | **1** |
| `...rest` reaching an unlisted model (R6-7) | `prisma.rest`, `user` hidden | **1** — `prisma.user`, no `prisma.rest` |
| destructured client touching only allowed delegates (allow) | 0 | **0** |

**Mutation proof.** Seven mutations applied singly to a scratchpad copy: the scope filter (1→0), the
`Parameter` kind (1→0), pattern indexing (1→0), the `const`-only refusal (1→0), the rest-element skip
(message: `prisma.rest` appears), the body requirement (message: unresolved → F3), and the
parameter-default refusal. **Stated precisely**: the default-value refusal is not independently
observable — a `Parameter` has no `getVariableStatement`, so the `const` clause already excludes it;
removing *both* clauses flips the fixture 1→0. The kind check is kept as a statement of intent, not
claimed as a second independent guard. The patcher aborts with `ANCHOR MATCHED n TIMES` rather than
running, and did.

**Coverage differential** vs Round 5, all 93 allowlist entries emptied: **279 pairs both sides,
nothing lost, nothing gained.**

**Performance**, 5 runs each, interleaved: Round 4 `0.68 0.67 0.68 0.68 0.69`; Round 5 (eager index)
`0.85 0.85 0.85 0.83 0.86`; now (lazy) `0.69 0.67 0.69 0.67 0.69`.

## Recurring Issue Check

**R29 fires on my own prose for the second round running** — the performance figure and the
universal non-occurrence claim, both mine, both repeated across multiple files. The pattern is
specific and worth naming: I write a number or a scope claim while making a change, and it is true
of the change I *intended* rather than the one I made. Both are now derived at runtime or stated
per-item rather than asserted once and copied.

**R47/R42** — the class "predicate that reads a binding pattern with `getName()`" was derived over
`clientNamesIn` and `declaresUnusedTx` in Round 5 but not over `bindingIndex`, which the same commit
introduced. Deriving a class over *the functions I was already editing* rather than over *every
function with the shape* is the same error in a fourth costume.

**RT7/RT10** → R6-5, closed: every clause added in Rounds 5–6 now has a case that fails when the
clause is removed, and each deny case has a paired allow case. **R44** clean. **R50** — the mutation
harness's refusal path fired again and was honoured. **R43** — differential identical, no widening.
**R45** — now genuinely clean, and measured rather than asserted.

## Environment Verification Report

Unchanged. The two paths still not verified are the same two, both predicted in Phase 1 with
Anti-Deferral entries: the E2E dialog-selection spec (D13) and the manual two-authenticator
scenarios 1–7 on `mrx33` (VE2). This round's diff is a CI gate and its tests.
