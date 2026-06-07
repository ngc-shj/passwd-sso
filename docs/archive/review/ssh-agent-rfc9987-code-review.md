# Code Review: ssh-agent-rfc9987
Date: 2026-06-07
Review round: 1

## Changes from Previous Round
Initial code review (3 parallel experts on `git diff main...HEAD`, 3 commits).

## Functionality Findings
- **F1 [Minor]** EXTENSION case relies on the outer drain catch for `readExtensionRequest` throws (no local try/catch on the `query`/name-parse path). Behavior is fail-closed (outer drain catch → buildFailure); cosmetic asymmetry vs the session-bind branch. — **Accepted (no behavior change needed).**
- **F2 [Minor]** `readString` clamps on over-long length rather than throwing; latent footgun but every caller is inside a fail-closed try/catch. — **Accepted (changing the shared primitive risks regression across all callers for marginal benefit; all callers already fail-closed).**
- **F3 [Adjacent→Testing]** captured ed25519 golden vector not committed → see T1.
- Otherwise: implementation faithful to C1–C10; all checklist files present; crypto (RSA mpint, ed25519/ecdsa extraction, P-521 DER long-form fix, algorithm-binding) verified correct; drain has no lost-wakeup; query response format matches OpenSSH (no count prefix); route authz/fail-closed/audit correct. **No Critical/Major.**

## Security Findings
- **S1 [Conditional→fixed]** `isAlgoConsistentWithKeyType` accepted legacy `ssh-rsa` (SHA-1) for session-bind verification. Audit-only path (host fields are client-asserted, not an authz input), but no need to admit SHA-1. — **FIXED**: dropped `ssh-rsa`, now requires `rsa-sha2-256`/`rsa-sha2-512` only.
- **S2 [Adjacent→Testing]** captured-vector deferred → see T1.
- All six focus areas verified: userId-from-token authz boundary (sound IDOR barrier), fail-closed on every path, MCP_AGENT audit attribution, no audit-metadata injection (Json + capped + sanitized), session-bind never stored unverified, fail-closed authorizer/confirm, per-connection isolation, DoS/TOCTOU guards preserved, ssh:sign least-privilege honestly scoped. **No Critical/Major.** No escalations.

## Testing Findings
- **T1 [Major→resolved]** captured ed25519 golden vector absent + deviation undisclosed. — **RESOLVED**: formally recorded as a descope in the deviation log (C6), tied to Phase 1 constraint VC1 (live-ssh blocked-deferred); synthetic vectors use INDEPENDENT encoders and exercise real `node:crypto` primitives (flip-byte negatives a stub fails); VC1 manual-test §1 covers real-OpenSSH fidelity.
- **T2 [Major→fixed]** `loadKey` `requireReprompt` defensive default (non-boolean → deny-side `true`) had zero coverage (no `ssh-key-agent.test.ts`). — **FIXED**: added `cli/src/__tests__/unit/ssh-key-agent.test.ts` (true/false/undefined→true/non-boolean→true + entryId/keyType).
- **T3 [Minor]** connection-isolation test observable: expert confirmed it does catch the leak path (B runs after A binds, observed via authorizeSign spy). — **Accepted (no change required).**
- **T4 [Minor→fixed]** route test `hasUserId` mock diverged from the real guard (missing `userId !== null`). — **FIXED**: aligned the mock + added a null-userId mcp_token → 403 case asserting findFirst not called.
- Confirmed sound: reply-ordering test non-vacuous (write-count 0 before resolve, real handleConnection), once-per-process hint asserts exactly once, route matrix complete, algorithm-binding negatives real, nistp521 long-form-DER exercised.

## Adjacent Findings
F3/S2 → T1 (captured vector, resolved as descope). No cross-expert routing left open.

## Quality Warnings
None — all findings carried file:line evidence.

## Recurring Issue Check
- Functionality: R1/R12 (const-object + audit coverage) satisfied; R29 (RFC 9987 constants verified against OpenSSH source); R37/ja-vault clean; R11 (group divergence) intentional; R2 (passwd-sso literal) pre-existing/deferred. Rest N/A.
- Security: RS1→S1 (SHA-1 removed); RS3 fail-closed verified all modules; RS2 downgrade closed (key-type-driven dispatch); RS4 least-privilege honest; R8/R12 audit integrity; R9 injection clean; R14 CSRF (cookieless Bearer, no assertOrigin) clean; R20 DoS / R22 TOCTOU preserved.
- Testing: RT4 (race vacuous-guard) clean; RT5 (real exported path) clean; RT6→T2 (now fixed); RT2 testability confirmed. Rest N/A.

## Environment Verification Report
- **VC1 (real OpenSSH handshake)** — `blocked-deferred`: session-bind live capture deferred to manual test (`ssh-agent-rfc9987-manual-test.md` §1); predicted by Phase 1 VC1; cost-justified in the deviation log (C6 descope). Verifier logic covered by synthetic vectors `verified-local`.
- **VC2 (Unix socket)** — `verified-local`: socket dispatch/ordering/isolation tests pass on Linux.
- **VC3 (server authorize round-trip)** — `verified-local` (mocked route tests, 69 pass) + `blocked-deferred` live round-trip (manual-test §1–2).
- **VC4 (TTY confirm)** — `verified-local` (injected isTTY/prompt) + `blocked-deferred` real terminal prompt (manual-test §3).

## Resolution Status
### T1 [Major] captured golden vector — Resolved (descope recorded)
- Action: deviation-log entry tying the synthetic-only vectors to VC1; manual-test §1 covers fidelity.
- File: docs/archive/review/ssh-agent-rfc9987-deviation.md
### T2 [Major] loadKey requireReprompt default untested — Fixed
- Action: added ssh-key-agent.test.ts (5 cases incl. non-boolean → deny-side true).
- File: cli/src/__tests__/unit/ssh-key-agent.test.ts
### S1 [Conditional] ssh-rsa SHA-1 in session-bind allowlist — Fixed
- Action: dropped ssh-rsa; require rsa-sha2-256/512.
- File: cli/src/lib/ssh-session-bind.ts:230-234
### T4 [Minor] hasUserId mock drift — Fixed
- Action: aligned mock to real guard + null-userId 403 case.
- File: src/app/api/vault/ssh/sign-authorize/route.test.ts:24,114-127
### F1, F2, T3 [Minor] — Accepted
- **Anti-Deferral check**: acceptable risk (quantified).
- F1: Worst case = cosmetic try/catch asymmetry; Likelihood = n/a (fail-closed via outer catch); Cost = ~5 min but no behavior gain.
- F2: Worst case = a future caller of `readString` forgets the fail-closed wrapper; Likelihood = low (all current callers wrapped); Cost = changing a shared primitive used by every protocol path = regression risk > benefit.
- T3: expert confirmed the test already catches the leak path; no change.
- **Orchestrator sign-off**: all three are inline-minor with no security-boundary or behavior impact.

---

# Code Review: ssh-agent-rfc9987 — Round 2 (incremental)
Date: 2026-06-07

## Changes from Previous Round
Verified the Round-1 fixes (mcp.ts/time.ts refactor, S1 allowlist tightening, T2/T4 test changes, T1 descope).

## Findings (Round 2)
- **Functionality: No new findings.** Refactor confirmed value-preserving (all 6 TTL constants byte-identical; SEC_PER_* correct; no import cycle; consumers unaffected). S1 cross-branch clean.
- **Security: S5 [Minor] — RESOLVED.** The S1 tightening shipped without a regression test (a revert re-adding `ssh-rsa` to the allowlist would not fail any test). Added a **mutation-verified** regression test: a SHA-256 RSA signature labeled `ssh-rsa` — passes with S1 applied, FAILS when S1 is reverted (confirmed by temporarily re-adding the case and observing the test fail). This also surfaced that the original `ssh-rsa` allowance was NOT cosmetic: it admitted a SHA-256 signature under a legacy label (label-confusion acceptance), now closed.
- **Testing: No new findings.** Both Round-1 test additions mutation-verified by the testing expert (forcing the requireReprompt default to false breaks 3 assertions; reverting the hasUserId mock breaks the null-userId case).

## Convergence
Round 2 produced one Minor (S5), resolved with a test-only, mutation-verified regression guard. The production security boundary (S1) was unchanged in this round and confirmed correct by all three experts in Round 2. No production findings remain. All suites green: root 11080, CLI 303. **Converged.**

## Resolution Status (Round 2)
### S5 [Minor] missing S1 regression test — Fixed
- Action: added a mutation-verified regression test (SHA-256 sig labeled `ssh-rsa` → false; fails on S1 revert).
- File: cli/src/__tests__/unit/ssh-session-bind.test.ts (RSA-sha2-256 describe block)
