# Plan Review: harden-cli-tailnet-ssrf

Date: 2026-08-01
Review rounds: 3 (closed — see "Convergence assessment" at the end)

## Changes from Previous Round

Initial review. Three expert sub-agents (functionality, security, testing) reviewed the plan against the working tree at `main`; findings below are post-deduplication, with convergences noted.

## Convergence map (mechanical merge pre-pass)

| Merged | Reported by | Severity floor |
|--------|-------------|----------------|
| I5.1 member-set incomplete (9 listed vs 27 actual) | F1 (functionality, names `bridge-code/route.ts:177`) + S3 (security, names the full 25-file delta) | Major, `convergent: functionality+security` |
| I4.3 "every fetch inherits C4" is false | F2 (Major) + S6 (Minor) | Major, `convergent: functionality+security` |
| RFC 7526 does not deprecate `2002::/16` | F5 + S4 | Major, `convergent: functionality+security` |

## Functionality Findings

- **F1 [Major]** C5's consumer-flow walkthrough and I5.1 omit `src/app/api/extension/bridge-code/route.ts:177`, a direct `checkAccessRestrictionWithAudit` caller that inherits C5's behaviour change untested. *(convergent with S3)*
- **F2 [Major]** I4.3's member-set is drastically undercounted; the plan's own grep returns ~20 raw `fetch(` sites matching neither stated discharge, including admin-configured `okta.ts` `orgUrl`. *(convergent with S6)*
- **F3 [Major]** I3.1's member-set omits `cli/src/commands/agent-decrypt.ts:419`, which already matches C3's own forbidden pattern (`export PSSO_AGENT_SOCK='${socketPath}'`) and would make C6 red on the tree C6 certifies.
- **F4 [Major, R29]** RFC 8215 is misattributed as the source of the `/48` embedding layout; RFC 8215 §5 explicitly disclaims any assumption about embedded-IPv4 location, so decoding that prefix is a guess.
- **F5 [Major, R29]** RFC 7526 deprecates only the 6to4 *anycast relay* (RFC 3068), not the `2002::/16` prefix. *(convergent with S4)*
- **F6 [Major]** C7's acceptance grep for `tailnet` returns zero hits in the READMEs today, while the under-specified lines `README.md:63` / `README.ja.md:63` say "Tailscale" — the criterion can pass vacuously.
- **F7 [Minor]** I1.1 describes `cli/src/commands/run.ts` as using `execFile`; it uses `spawn` (the compliance conclusion holds; the citation and the file's own stale header comment do not).

## Security Findings

- **S1 [Major]** C2's pathname/host narrowing exists in prose only — I2.1–I2.3 and the acceptance criteria never constrain host or path. Verified empirically: `new URL("https://a&calc")` parses with `hostname === "a&calc"`, and raw `&`/`,` survive in `pathname`, reaching the concatenated authorization URL at `cli/src/lib/oauth.ts:415`. The plan's own scenario 2 was factually wrong.
- **S2 [Major]** C4's `/48` acceptance vector `64:ff9b:1::a:0:c0a8:1` decodes to `0.0.10.0`, not `192.168.0.1`; `0.0.10.0` is already inside `0.0.0.0/8`, so the criterion would pass regardless of whether the decoder worked.
- **S3 [Major]** I5.1's derivation returns 25 files, not the 9 enumerated; verified separately that no member holds a private adjudicator, so the fix mechanism is sound but the asserted safety net covered 2 of ~25 call sites. *(convergent with F1)*
- **S4 [Major]** SC4 silently narrows the class the Objective table claims closed: operator-assigned NAT64 prefixes (the common enterprise case per RFC 7050 discovery) remain neither blocked nor decoded, and nothing in the shipped artifact tells an operator so. Also carries the RFC 7526 citation error. *(convergent with F5)*
- **S5 [Minor, Adjacent]** The F4 reference snippet interpolates `${pid}` unquoted while C6 Rule B declares numerics non-exempt — the plan's own sample code would be red under its own gate.
- **S6 [Minor]** I4.3's discharge rule omits legitimate patterns actually present: manual `resolveAndValidateIps` + `createPinnedDispatcher` composition (`webhook-dispatcher.ts:128`), fixed-vendor-host calls, and a second same-origin self-call (`auth-gate.ts:82`). *(convergent with F2)*

Security expert checked and found no issue on: C1's `rundll32` argv safety (researched; URL reaches the process as one intact argv element, and `URL`/`URLSearchParams` never emit the space/tab/quote that trigger Windows CRT quoting), C3's completeness for `!` / newline / NUL (empirically tested — history expansion does not apply inside `eval`'d text), R43 boundary widening (C4 narrows relative to `main`), R48 parallel adjudicators, RS4.

## Testing Findings

- **T1 [Critical]** C6 lacks the sibling self-test `scripts/checks/check-gate-selftest-coverage.sh` requires. That meta-gate is wired at `scripts/pre-pr.sh:342` and runs in CI, so wiring C6 without `scripts/__tests__/check-cli-shell-safety.test.mjs` (or a debt entry) makes the PR that adds C6 fail `pre-pr.sh` outright. RT7 was satisfied only as a manual one-time act.
- **T2 [Critical]** The proposed `page-route.test.ts` / `api-route.test.ts` extension cannot prove I5.1: both files `vi.mock` the entire `@/lib/auth/policy/access-restriction` module, so no line C5 changes executes there. Such a test passes identically with C5 reverted — a false-positive test.
- **T3 [Minor]** I6.2 cites `scripts/checks/check-orphaned-checks.sh`, which does not exist in the repo; the "actually wired" property had no automated backstop.

Testing expert checked and found no issue on: RT3 (`external-http.test.ts:67-68` already asserts `BLOCKED_CIDR_REPRESENTATIVES.length === BLOCKED_CIDRS.length`, making I4.1 enforceable today), RT4 (the `sh -c` round-trip set is non-vacuous), RT5, RT10, and CI wiring for C1–C5.

## Adjacent Findings

- **S5-A** routed to functionality scope (plan-sample consistency with C6 Rule B) — applied.

## Quality Warnings

None. Every finding carried file:line evidence; the four claims with the largest consequences (S1's URL parsing, S2's bit decode, S3/F1's member-set, T1's meta-gate) were independently re-verified by the orchestrator before adoption.

## Resolution Status — Round 1

| ID | Disposition | Where applied |
|----|-------------|---------------|
| F1 + S3 | Fixed | I5.1 re-derived to 27 files with the truncation cause recorded; `bridge-code/route.ts:177` added to the consumer walkthrough; R-a rollout note extended to extension pairing |
| F2 + S6 | Fixed | I4.3 rewritten: the invariant now scopes to attacker-influenceable destinations and names four discharge categories with their members |
| F3 | Fixed | I3.1 member-set 8 → 9 sites; C3 consumer list and the Go/No-Go subject updated to seven agent-side lines; testing row extended |
| F4 + S2 | Fixed | C4 restructured: `64:ff9b::/96` decoded (RFC 6052 §2.1 fixes the layout), `64:ff9b:1::/48` blocked by prefix (RFC 8215 §5 forbids the assumption); acceptance vectors replaced, with the vacuous-pass trap of the old vector recorded |
| F5 + S4 | Fixed | RFC 7526 claim removed from the `2002::/16` justification; NAT64 residual disclosed in SC2 and made a C7 documentation obligation (I7.3) |
| F6 | Fixed | C7 acceptance grep broadened to `tailscale\|tailnet` across READMEs, messages and the policy card; `README*.md:63` named as members under I7.1 |
| F7 | Fixed | I1.1 corrected to `spawn`; the stale `execFile` header comment in `run.ts` folded into C6's scope |
| S1 | Fixed | New I2.4 constrains `hostname` and `pathname` with explicit patterns; acceptance criteria gained `https://a&calc`, `https://h/a,b`, `https://h/a&b`; scenario 2 corrected |
| S5 | Fixed | F4 snippet now quotes `pid` |
| T1 | Fixed | I6.1 rewritten around `scripts/__tests__/check-cli-shell-safety.test.mjs` following the `check-operator-echo-escaped.test.mjs` convention; I6.3 adds `CLI_SHELL_SAFETY_ROOT` so the self-test can target a fixture tree |
| T2 | Fixed | Testing strategy now explicitly forbids new assertions in the two proxy test files and explains why; the I5.1 proof moved to the choke point in `access-restriction.test.ts` |
| T3 | Fixed | Phantom `check-orphaned-checks.sh` citation replaced with a `grep -q` wiring assertion inside C6's own self-test |

No finding was skipped, accepted, or deferred; the Anti-Deferral format is therefore not exercised in this round.

## Recurring Issue Check

### Functionality expert
R1 Checked — no issue · R2 Checked — no issue · R3 Finding F3 · R4–R6 N/A · R7 N/A · R8 N/A · R9 N/A · R10 Checked — no issue · R11–R15 N/A · R16 Checked — no issue · R17 Finding F3 · R18 Checked — no issue · R19 N/A · R20–R28 N/A · R29 Findings F4, F5 (RFC 4291 §2.5.5.1, RFC 6666, RFC 6598, RFC 1918 verified accurate) · R30 N/A · R31–R33 Checked/N/A (static-checks CI confirmed to run `pre-pr.sh`, so wiring C6 into pre-pr wires CI) · R34 Finding F2 · R35–R41 N/A or Checked · R42 Findings F1, F2, F3 · R43 N/A · R44 N/A · R45 Checked — no issue · R46 Checked — no issue · R47 Checked — no issue · R48 Finding F1 · R49 Finding F6 · R50 Finding F1

### Security expert
R1 Checked · R2 Checked · R3 Finding S6 · R4–R16 N/A · R17 Checked · R18 Checked · R19–R28 N/A · R29 Findings S4, S2 · R30 N/A · R31 N/A · R32 Checked (VE4 probe required) · R33 N/A · R34 Checked · R35–R40 N/A · R41 Finding S4 · R42 Findings S2, S3 · R43 Checked — no issue (C4 narrows, does not widen) · R44–R48 N/A or Checked · R49 Finding S1 · R50 Checked · RS1 N/A · RS2 N/A · RS3 Finding S1 · RS4 Checked — no issue · RS5 Finding S1 · RS6 Checked — no issue (history-expansion, newline and NUL handling empirically verified)

### Testing expert
R1–R3 Checked · R4–R15 N/A · R16 Checked · R17 Checked · R18 Finding T1 · R19 Finding T2 · R20–R28 N/A · R29 Finding T3 · R30–R31 N/A · R32 Checked · R33 Checked (C6 gap is T1) · R34–R41 N/A · R42 Checked · R43–R47 N/A · R48 Checked · R49 Checked · R50 Checked · RT1 Checked · RT2 Checked · RT3 Checked — `external-http.test.ts:67-68` already enforces the lockstep · RT4 Checked · RT5 Checked · RT6 Checked · RT7 Finding T1 · RT8 Finding T2 · RT9 Checked · RT10 Checked

---

# Round 2

## Changes from Previous Round

All 16 Round 1 findings applied. Round 2 was an incremental review of the revised plan plus independent re-verification of the new claims.

## Findings

**Functionality**
- **F8 [Major]** `cli/src/commands/agent.ts:187` (`export SSH_AUTH_SOCK=${socketPath}`, no quoting at all) is a *third* missed member of the C3 class — and one C3's own `/'\$\{/` forbidden pattern could not have caught, since it has no quotes to match.
- **F9 [Major]** I4.3's restated cardinality ("27 call sites in 12 files") contradicts its own cited grep; also `!**/*.test.ts` does not exclude `.test.tsx`, and 4 matches were comments rather than calls.
- **F10 [Major]** The Objective table's F4 row still described the narrower "documented to eval" class after I3.1 had widened it.
- **F11 [Major]** C7's acceptance command `messages/*.json` matches nothing — translations live in `messages/en/` and `messages/ja/` (120 files) — and in zsh the unmatched glob aborts the entire command, so the check reports clean without reading any file.
- **F12 [Major]** `messages/{en,ja}/TenantAdmin.json:90` (`tailscaleEnabledHelp`) documents the exact gap C5 closes ("the tailnet name below is verified only for API/token access") and becomes **false** the moment C5 ships — an under-claim that would have admins compensating for a bypass that no longer exists.

**Security**
- **S7 [Minor]** I4.3's category (d) "fixed vendor hostname" is false for its own `okta.ts` member — the org subdomain is admin-supplied, bounded by an anchored regex, which is a different control from a compile-time literal.
- **S8 [Major, PLAUSIBLE]** The WhoIs cache keyed by IP becomes cross-tenant-isolation-critical under C5.
- **S9 [Major, PLAUSIBLE]** `extractTailnetFromFqdn` returns `parts[length-3]` — exactly one label before `ts.net` — so a domain-verified tailnet (`host.example.com.ts.net.`) yields `"com"`. The policy field accepts dotted names (`api/tenant/policy/route.ts:353`), so the comparison can never match; C5 would turn that token-path defect into a tenant-wide browser lockout.
- **S10 [Minor]** I2.4's bracketed-IP-literal branch had no stated predicate.

**Testing**
- **T4 [Critical]** The C3 testing row sent `agent-decrypt` assertions to `agent.test.ts`, which `vi.mock`s that whole module — a false-positive test of the same shape as Round 1's T2, in the round that fixed T2.
- **T5 [Major]** `agent-decrypt.ts:419` is unreachable by any specified technique: it sits in a `server.listen` callback in `startForegroundAgent`, whose trailing `await new Promise(() => {})` never settles, and the test's `listen` mock never fires its callback.
- **T6 [Major]** C4's and C5's "Forbidden patterns" have no automated enforcement, unlike C1's and C3's — the guard against the R48 class silently reopening was a review-time wish.

## Resolution Status — Round 2

| ID | Disposition | Where applied |
|----|-------------|---------------|
| F8 | Fixed — and escalated | Third expansion of the same member-set is the R42 accretion signature. I3.1 was restructured so **C6 Rule B defines membership**; the list is demoted to "a snapshot of the gate's current output", and the contract now closes on a green, red-proven gate rather than an exhausted list. |
| F9 | Fixed | Count removed entirely; derivation command hardened (`.test.tsx` excluded, comment-vs-call filter stated) |
| F10 | Fixed | Objective table F4 row points at C6 Rule B |
| F11 | Fixed | Acceptance command pinned to `messages/en/*.json messages/ja/*.json`, both silent-green failure modes recorded, R50 non-empty-output obligation added |
| F12 | Fixed | I7.1 now covers claim mismatch in **both** directions and names all four `TenantAdmin.json` strings |
| S7 | Fixed | Fifth discharge category (e) added for allowlist-bounded tenant-supplied hosts |
| S8 | **Rejected as a key change, adopted as a documented decision** | The cached value is a function of the IP alone — no tenant input reaches `callWhoIs`, and the per-tenant comparison happens after the lookup — so adding the expected tailnet to the key changes no verdict and only fragments the cache. New I5.6 records that reasoning, the accepted 30 s staleness window, and (after S11) the external node-sharing assumption it rests on. |
| S9 | Fixed | New contract **C8**, made a prerequisite of C5 (risk R-d), with I8.3 forbidding suffix matching |
| S10 | Fixed | I2.4 states the rule and names the URL parser as its adjudication authority |
| T4 | Fixed | Testing row split per file, with the false-positive reason recorded |
| T5 | Fixed | New I3.4 extracts both foreground hint blocks into pure functions, mirroring C1's `browserLaunchCommand` split |
| T6 | Fixed | New C6 Rule C over `src` |

---

# Round 3

## Changes from Previous Round

All 12 Round 2 findings applied, including two new contracts' worth of material (C8, I3.4, I5.6, C6 Rule C, discharge category (e)). Round 3 re-verified those and audited the interactions between them.

## Findings

**Functionality**
- **F15 [Major]** C8-before-C5 was asserted only in prose, under Risks, *after* the Go/No-Go table — the gate itself had no dependency column, so nothing stopped C5 being marked done with C8 pending.
- **F13 / F14 / F16 / F17 [Minor]** Citation precision: `tailscale-client.ts:191` → `:187`; `google-workspace.ts:175,241` → `:176,242`; I5.1's 27 files include a comment-only match (`mcp/oauth-server.ts:173`); I5.1's secondary grep also matches `external-http.ts:36,66` (C4's own CGNAT constant), which the description omitted — the third instance in this plan of "returns only X" about a command that also returns Y.

**Security**
- **S13 [Major]** I3.4 and C6 Rule B contradicted each other: extracting the hint blocks into pure functions moves their template literals out of a `console.log(...)`-anchored pattern, so the gate would have gone green on exactly the two sites the plan moved — green because the code became invisible, not because it became safe.
- **S12 [Major]** Rule C counts *references to a name*. An import alias, an indirect call, and above all an independently written WhoIs-and-compare implementation all pass it — and that last case is precisely how the original two-adjudicator split arose.
- **S11 [Major]** I5.6's soundness argument named time as the only axis for "same IP, different tailnet", without naming the node-sharing topology the per-tenant comparison implies.
- **S14 / S15 [Minor]** Undisclosed I2.4 acceptances (`..` segments, IPv6-literal branch); I8.1's front boundary is a fixed one-label assumption while its rationale claimed label-count independence.

**Testing**
- **T7 [Critical]** Rule C had no self-test fixture, and one scan-root override variable cannot present two differently-shaped fixture trees. The meta-gate checks only that a self-test *file* exists, so an untested third rule would pass CI while never being able to fire — the meta-gate's own failure mode, one level down.
- **T8 [Major]** The daemon-mode sites `agent-decrypt.ts:348-350` are outside I3.4's extraction and have no reachability path in `agent-decrypt.test.ts` today; `agent.test.ts:232-269` already has the fake-child scaffolding that would be needed, and the plan never named replicating it.
- **T10 [Major]** C7's acceptance criterion is a one-time human command with no CI wiring — the one invariant in the plan with no regression mechanism, guarding documentation that this very plan proves goes stale.
- **T9 [Minor]** `src/__tests__/lib/tailscale-client.test.ts` is a second suite covering `_extractTailnetFromFqdn` through the same test-only alias; extending only the file C8 names leaves a stale twin.

## Resolution Status — Round 3

| ID | Disposition | Where applied |
|----|-------------|---------------|
| F15 | Fixed | Go/No-Go table gained a "Must land no later than" column, with the three real dependencies (C8→C5, C7 with C5, C3 with C6) and their production consequences stated as part of the gate |
| S13 | Fixed | Rule B no longer anchors on `console.log` — it matches any template literal carrying shell syntax with a non-discharged interpolation, so I3.4's extraction cannot hide a member from the gate |
| S12 | Fixed by declaring the class honestly (R49) | Rule C is labelled a **tripwire**, its three bypasses are enumerated, and a `/localapi/v0/whois` clause is added as the one string a reimplementation cannot avoid. Closure remains C5's structural collapse plus review; Rule C makes a regression noisy, not impossible. |
| S11 | Fixed | I5.6 names the node-sharing assumption explicitly, mirroring SC2's treatment of the NAT64 residual |
| T7 | Fixed | I6.1 gained a per-rule red/green fixture table (a rule without its own red fixture is unproven); I6.3 gained a second override variable `SRC_ADJUDICATOR_ROOT` |
| T8 | Fixed | The C3 testing row now names the fake-child scaffolding to replicate from `agent.test.ts:232-269` and states what the gate does *not* prove |
| T10 | Fixed with a mechanism, not a deferral | New testing row: a vitest assertion that the shipped `TenantAdmin.json` help strings contain neither `API/token` nor `APIアクセス`. Cheap, runs in `app-ci`, fails loudly on regression. |
| T9 | Fixed | C8's testing row extends **both** suites and names the `_extractTailnetFromFqdn` alias |
| F13, F14, F16, F17, S14, S15 | Fixed | Citations corrected; I5.1 gained the comment-vs-call filter and its full grep output; I2.4 and I8.1 disclose their residual acceptances |

No finding in any round was skipped, accepted, or deferred, so the Anti-Deferral format is not exercised.

---

## Convergence assessment — why plan review closes at round 3

| Round | Findings | Critical | Major | Minor | Character of the substantive findings |
|-------|----------|----------|-------|-------|----------------------------------------|
| 1 | 16 | 2 | 10 | 4 | Design defects: wrong member sets, a decode that could not be right, tests that could not fail |
| 2 | 12 | 1 | 7 | 4 | Consequences of the round-1 fixes, plus one genuinely new design defect (S9 → C8) |
| 3 | 14 | 1 | 6 | 7 | **Every substantive finding is about the specification of C6's own gate** (S12, S13, T7) or citation precision (7 Minors) |

Two rules in the skill's own rule set say to stop here rather than run a fourth round.

**R42 clause ①b.** The C3 member set expanded twice (8 → 9 → 10). That is the accretion signature: the boundary was being read off files instead of derived, so the next missed member is likely still unwritten and no further round of human enumeration closes it. The prescribed convergence artifact for a ≥2×-expanded class is a mutation-verified CI guard, not another review round — and that guard (C6, now with a per-rule red-fixture table) is in the plan. The class closes when the gate is green and has been shown able to go red, which is Phase 2 work.

**Diminishing specification returns.** Rounds 2 and 3 each surfaced defects *created by the previous round's fixes* — S13 is the clearest case: two contracts written in the same round contradicted each other, and no amount of further prose would have surfaced that as reliably as writing the gate. When design Criticals reach zero while the remaining findings are all about the mechanism's own specification, the cheaper and more truthful next step is to build the mechanism.

Go/No-Go: all eight contracts flip to `locked` on this basis. The ordering column is binding.
