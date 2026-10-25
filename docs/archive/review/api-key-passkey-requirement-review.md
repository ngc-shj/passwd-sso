# Plan Review: api-key-passkey-requirement
Date: 2026-10-25

## Round 1 (plan revision 1)

Local LLM pre-screen: no issues.

### Security
- S1 Critical (escalate: true): sessions are not passkey-checked on API requests.
  - The proxy gate is only in `page-route.ts`. `api-route.ts` has none, and the route-handler-auth
    classes are not classified for a session at all.
  - The plan's Session and Delegation rows, SC2, and the `src/auth.ts` comment stated otherwise.
  - A passkey-less admin can turn the requirement off through `/api/tenant/policy`.
- S2 Minor: the extension-token window can reach 30 d (the tenant idle maximum), not 7 d. A
  per-use check costs almost nothing when it is folded into the existing membership read.
- S3 Minor: the iOS AutoFill mint is ungated and missing from the member set. The MCP access token
  lives 1 h, not up to 1 d.
- S4 Minor: `validateOperatorToken` has no membership check. A gate placed before one leaks more
  than it should, and it audits a non-admin.
- S5 Minor: `blockedPath` must be a constant per credential kind, not the request path, and the
  metadata should carry the credential id.
- S6 Minor [Adjacent]: the consumers were not enumerated (overlaps F1, F4).

### Functionality
- F1 Major: `validateV1Auth` hardcodes 401, and the seven v1 handler sites map every auth failure
  to 401.
- F2 Major: the CLI prints only the HTTP status.
- F3 Major [Adjacent]: the same finding as S1.
- F4 Minor: the ten `verifyAdminToken` routes were not listed.
- F5 Minor: the helper needs `req`, and `recordPasskeyAuditEmit` only deduplicates. Putting the
  audit import in `passkey-enforcement.ts` would pull it into the proxy graph.
- F6 Minor: `blockedPath` was unspecified.
- F7 Minor: OpenAPI lists no 403 for these operations.
- F8 Minor: the cost estimate omitted the extra transaction.

### Testing
- T1 Major: sixteen mapping sites, two of them tested.
- T2 Major: the unit mock boundary. A mock of `derivePasskeyState` cannot reach a helper in the
  same module.
- T3 Major: the audit write must be awaited, and the dedup needs a positive control.
- T4 Major: the integration I2 assertion is vacuous, because the `lastUsedAt` write is
  fire-and-forget and throttled.
- T5 Major: I1 has no static gate. Use an AST manifest gate keyed on `tokenHash` lookups.
- T6–T12 Minor: the forbidden pattern is unenforced; the fail-closed assertion is too weak;
  `authOrToken` has no test; the fixtures; boundary cells; the `validateV1Auth` mock; the helper's
  `req` (the last one overlaps F5).

### User decision
Widen the scope (S1/F3, S2): this PR gates sessions on `/api/*` and extension-row tokens in
addition to API keys and operator tokens. MCP stays refresh-bound (1 h).

### Revision 2
- C4: the session gate in the proxy, with a pinned exempt set.
- C5: the extension-row gate, which also covers iOS.
- C6: the AutoFill mint is gated.
- C7: an AST manifest gate.
- C1: the full consumer list, a shared mapper, OpenAPI and the CLI.
- C2: a membership check before the gate, and the ten routes.
- C3: a new proxy-free module that takes `req`, awaits the audit, uses a constant `blockedPath`,
  and records the credential id.
- The testing strategy is rewritten per T1–T12.

## Recurring Issue Check
### Functionality expert
R3 F1, F4; R29 F3, F8; R42 partial (session); R52 F8; R10 risk (F5); R1/R17 F5; R48/R49 clean.
### Security expert
R1 OK; R3 S6; R29 S2, S3; R42 S1, S3; R48 OK; R49 S1; RS2 OK (S5); RS4 OK; RS1/RS3/RS5/RS6 N/A.
### Testing expert
R3 T1; R19 T2, T8; R42 T5; R49 T6; R50 T5; RT1 T11, T2; RT2 T7; RT5 OK; RT6 T2; RT7 T4, T5;
RT8 T4, T7; RT10 T10; RT11 OK.

## Round 2 (plan revision 2)

### Security
- S2–S6 resolved.
- S1 continuing.
- S7 Critical (escalate: true; verified by the orchestrator): the proxy's session-cookie
  extraction is not the session Auth.js resolves.
  - `extractSessionToken` keys the cache on the first cookie found in
    `ALL_KNOWN_SESSION_COOKIE_NAMES` order, while Auth.js reads only `getSessionCookieName(...)`.
  - On `__Secure-` (basePath) and http deployments, the cache can bind an attacker-chosen key to
    another session. That bypasses the IP restriction today, and it would bypass C4.
- S8 Critical (escalate: true): a cookie plus a junk Bearer header skips C4.
- S9–S12 Major:
  - S9: the proxy's own fetches recurse or get blocked;
  - S10: the exempt passkey page cannot register while the vault is locked;
  - S11: the C5 order contradicts the DPoP helper writing `lastUsedAt`;
  - S12: revocation is blocked.
- S13–S15 Minor.

### Functionality
- F1–F7 resolved; F8 is partial.
- F9 and F10 Critical: the exempt page sits behind `VaultGate`, and the session lookup recurses.
- F11–F16 Major:
  - F11: the audit-emit self-fetch is answered 403;
  - F12: C4's placement, its premise, and the routes that own their passkey UX;
  - F13: `authOrToken` gives 401, not 403, and the clients;
  - F14: the C5 order, `lastUsedAt` and the grant;
  - F15: self-revocation;
  - F16: tabs that are already open.
- F17–F20 Minor:
  - F17: the exempt-page request derivation (to `#959`);
  - F18: C6 is unreachable behind C5, and `issueAutofillToken` lacks `req`;
  - F19: passkey registration does not invalidate the session cache (to `#959`);
  - F20: miscounts — 5 direct extension callers (6 sites), 8 `derivePasskeyState` sites.

### Testing
- T2–T8, T10 and T12 resolved for bearers; T1 and T11 continuing; T9 partial.
- TQ1 Critical: the self-fetch recursion is hidden by the global fetch mock.
- TQ2–TQ9 Major:
  - TQ2: existing proxy tests flip;
  - TQ3: no real-path session test;
  - TQ4: the exempt-set pin;
  - TQ5: the C5 status;
  - TQ6: the C5 I2 proof;
  - TQ7: C6 is shadowed by C5;
  - TQ8: the placement of the mapper;
  - TQ9: the C7 mechanism.
- TQ10–TQ12 Minor.

### Character of the round
- The C4 session gate carries 4 of the Critical and 9 of the Major findings.
- The bearer contracts (C1, C2, C5, C7) carry Majors of specification, not of design: shapes,
  ordering, mock boundaries.
- S7 is a pre-existing defect, independent of either.

### User decision
Split into three:
1. S7 as its own small PR, first.
2. This branch: the bearer credentials only (C1, C2, C3, C5, C6/C7), with the round-2 bearer
   findings applied.
3. The session gate (C4) as a separate issue and plan, carrying S1, S8–S10, S12 (session part),
   S13, S14, F9–F12, F15–F17, F19, TQ1–TQ4 and the TQ11 session cells.

## Round 3 (plan revision 3, bearer credentials only)

No Critical findings.

### Functionality (F21–F30, all Minor)
- F21 prose: one-time codes are keyed by `codeHash`, so C7 cannot "classify" them.
- F22 prose: the README has no passkey-policy text; `docs/security/policy-enforcement.md` is the table.
- F23 design: C2 omitted `PASSKEY_REQUIRED` in `OperatorTokenValidationError`, and `verifyAdminToken`
  collapses every failure to `INVALID`.
- F24 design: the gate now precedes the scope and clientKind checks, which was unstated; a distinct
  reason in the two MCP-scope routes serves no client.
- F25 prose: the shared OpenAPI `Forbidden` is also used by session routes; the v1 operations
  missing a 403 were not named.
- F26 prose: the CLI passkey message covers only `env`/`run` with an API key; the OAuth CLI uses MCP.
- F27 design: C5 shadows the refresh route's inline gate and reorders it before family/presence
  revocation.
- F28 [Adjacent] design: the gate runs before `enforceAccessRestriction`.
- F29 prose: the `openapi.json` denial status was unspecified.
- F30 prose: F17–F20 had no recorded content (now recorded above).

### Security (S16–S20, all Minor)
- S16 design: as F28 — an off-network use of a stolen key is audited as a deduped passkey block,
  not `ACCESS_DENIED`.
- S17 prose: revision 3 dropped `personalAuditBase`, the token's `tenantId` and the named
  `blockedPath` constants.
- S18 design: dedup by user and kind collapses distinct credentials.
- S19 design: the C7 exemption pin had no key, no literal-argument rule, no member match.
- S20 prose: the member table claimed C7 sees codes and a removed admin env token; the iOS refresh
  inline gate was not recorded.

### Testing (T13–T18 Major, T19–T23 Minor)
- T13 Major design: no inventory of the existing tests the change breaks.
- T14 Major design: the C5 I2 proof could not see the write returning to the DPoP helper; the IP/UA
  cells would be lost; per-branch and DPoP-failure cells were missing.
- T15 Major design: exempt allow cells are vacuous where route tests mock the validator.
- T16 Major design: the CLI and OpenAPI deliverables had no cells.
- T17 Major design: the C7 manifest member set, key format and count were not listed.
- T18 Major design: C7 "used result" undefined; escape spellings without fixtures.
- T19–T22 Minor design: status assertions and `OPENAPI_PUBLIC`; mapper cells and the v1 count;
  where audit deltas are counted; fail-closed routes and the grant pin.
- T23 Minor [Adjacent] prose: the iOS 403 handling is not uniform, so E1's premise was wrong.

### Revision 4
- C1: CLI `env`/`run` named; a v1-specific forbidden response; `passwords/{id}` gains 403.
- C2: `OperatorTokenValidationError` and `verifyAdminToken` carry `PASSKEY_REQUIRED` to a 403.
- C3: the audit spec restored; per-credential dedup; the precedence over scope and network stated
  and accepted, with the reason (the validator placement is what makes I1 structural).
- C5: write on both branches; the exemption call shape; the refresh inline gate removed with the
  outcome change stated.
- C7: `tokenHash` and `codeHash`; refuse non-literal `where`; attribution, classes, "used", the
  exemption pin and forbidden-read spellings defined; the 21-function initial manifest; the
  self-test name.
- C8: MCP-scope routes use the existing 403 arm; `openapi.json` answers 403.
- E1 corrected; SC5 (iOS presentation) added; the documentation target is `policy-enforcement.md`.
- Testing strategy: T13–T22 applied.

## Recurring Issue Check (round 3)
### Functionality expert
R1 OK; R3 F23, F30; R10 OK; R17 OK; R29 F21, F22, F25, F26 (counts reproduced); R42 F21; R48/R49
OK; R52 OK.
### Security expert
R3 OK; R29 S17, S20; R42 S20; R43 OK (exempt routes read end to end); R46/R47 S19; R48 S16; R49 S17;
R1/R52 OK; RS4 OK; RS1/RS2/RS3/RS5/RS6 N/A.
### Testing expert
R3 T13, T16, T20; R29 checked (v1 and C7 counts were unstated); R42 T17; R19/R49/R50 OK; RT1 T13;
RT2 T15, T19, T22; RT5 OK; RT6 T14; RT7 T14, T15, T18; RT8 T21; RT10 OK; RT11 OK; RT3/RT4/RT9 N/A.

## Round 4 (plan revision 4)

No Critical findings. S16 (precedence over network restriction) was re-judged: the reason holds.

### Functionality (F31–F33 Major, F34–F40 Minor)
- F31 Major design: removing the refresh route's inline gate fails `check-passkey-mint-gate.sh`.
- F32 Major design: C5 reverses C9 of `passkey-enforcement-token-paths-plan.md` (AutoFill mint left
  ungated to avoid a first-passkey-save deadlock) without addressing it.
- F33 Major design: "non-literal `where` fails" fails on the current repo (`mcpClient`, `webAuthnCredential`).
- F34 design: the `per-use-gated` predicate rejects the exemption guard and does not prove both
  branches are gated. F35: `detectRefreshReplay` is revocation only. F36: `check-bypass-rls` stale
  entry. F37 prose: the dedup cap is global and overflow re-emits. F38 prose: the absolute/idle rows
  in `policy-enforcement.md`. F39 prose: the extension's broken window. F40 [Adjacent]: a second
  refresh test file.

### Security (S21–S25, all Minor)
- S21 design: C7 does not require the gate before every success return.
- S22 design: the exemption pin escapes through value references, `.call`/`.apply`, re-export.
- S23 prose: the dedup bound was misstated. S24 design: the durable audit write on the refusal arm is
  unthrottled once the dedup map overflows. S25 prose: the MCP code exemption reason.

### Testing (N1–N3 Major, N4–N8 Minor)
- N1 Major: `check-passkey-mint-gate` and `check-bypass-rls` break (= F31, F36).
- N2 Major: `passwords/route.test.ts` runs the real validator; exempt-route factory mocks; the
  `PASSKEY_EXEMPTION` module unnamed.
- N3 Major: as F33.
- N4: route 500 is unobservable (`withRequestLog` rethrows). N5: per-branch DPoP error codes. N6: the
  exempt-route assertion shape for `extension/token/route.test.ts`. N7: the `lastUsedAt` throttle can
  make I2 cells vacuous. N8: the refresh outcome change has no cell.

### User decision
F32: stop the AutoFill mint and upload for a blocked user (C9 superseded). Its deadlock avoidance
only ever lasted the host token's idle window; a blocked user registers with another authenticator.

### Revision 5
- C3: the audit write is bounded by a per-credential `createRateLimiter` (Redis-shared), separate
  from the proxy map; the bound restated.
- C5: one gate, one write, one success return; `PASSKEY_EXEMPTION` in the leaf types module; the
  refresh route and AutoFill reasons in `passkey-mint-gate-exempt.txt`; the `check-bypass-rls`
  entry removed; C9 superseded.
- C7: refusal scoped to token models from the schema; the gate-before-every-success-return rule; value
  references and re-exports refused; `detectRefreshReplay` exempt; the MCP code reason.
- Testing: N2, N4–N8 applied; both refresh trees; the static gates in the inventory.
- Docs and scenarios: F38, F39; SC5 covers the extension too.

## Recurring Issue Check (round 4)
### Functionality expert
R3 F31, F36, F38; R17 F31; R18 F36; R29 F32, F35, F37, F39 (21 functions, v1 7, admin 10, C8
reproduced); R42 OK; R43 F32; R47 F33; R48 F31; R49 F34; R52 F33; R10 OK; R1 OK.
### Security expert
R1 OK; R3 OK; R29 S23, S25 (21 reproduced); R42 OK; R43 OK; R46/R47 S21, S22; R48 OK (S16 holds);
R49 OK; R52 OK (S24 belongs here — a durable write on a refusal arm; recorded as RS6 at the time, which is the escape-ordering rule, corrected in round 5); RS4 OK; RS1/RS2/RS3/RS5/RS6 N/A.
### Testing expert
R3 N1, N2; R29 counts reproduced; R42 N3; R19/R49/R50 OK; RT1 N1, N2, N8; RT2 N4–N7; RT5 N2; RT6 OK;
RT7 N3, N6; RT8 OK; RT10 OK; RT11 OK; RT3/RT4/RT9 N/A.

## Round 5 (plan revision 5)

No Critical findings. Every round-4 item verified resolved; the F32 decision opens no hole (a refused
AutoFill upload cancels before any credential reaches the relying party).

### Functionality (F41–F45, all Minor)
- F41 prose: the mint-gate exempt file header and a self-test fixture still give only the C9 rationale.
- F42 prose: `auth-surface-matrix.md` names `validateIosTokenDpop`.
- F43: the limiter key lacks the `rl:` prefix.
- F44 prose: the AutoFill silent cancel is not in SC5; the no-orphan property is unrecorded.
- F45 prose: "after that `if`" is ambiguous in the nested exemption form.

### Security (S26–S30, all Minor)
- S26 prose: "cannot churn" is false for API keys and operator tokens until `#959`.
- S27 design: the limiter's Redis-failure mode is unpinned.
- S28 design: the ordering rule sees only literal `ok: true` returns.
- S29 design: C7 inspects only `find*`; token-like columns outside the scan are unrecorded.
- S30 design: the exemption pin misses namespace and dynamic imports.

### Testing (T24 Major, T25–T30 Minor)
- T24 Major design: the dedup cell passes if the second request is refused before the gate.
- T25: the borrowed harnesses mock audit and rate-limit. T26: the limiter options are unpinned. T27:
  the AutoFill acceptance cells have no home. T28: an inverted exemption guard passes C7. T29: as S28.
  T30: the schema input has no fixture override and fails open when empty.

### Revision 6
- C3: `rl:` key; no `failClosedOnRedisError`; the bound restated with the `#959` precondition.
- C5: the no-orphan property; the exempt file header and fixture reason.
- C7: every `where`-taking method and raw SQL; the negated guard; returns before the gate must be
  `ok: false` literals; namespace and dynamic imports refused; the schema under the fixture root,
  empty set fails; out-of-class columns recorded.
- Testing: T24 (second response asserted, fresh proofs, red proof), T25–T27.
- Docs: `auth-surface-matrix.md`; SC5 names the AutoFill extension.

## Recurring Issue Check (round 5)
### Functionality expert
R1 F43; R3 F41, F42; R10 OK; R17 OK; R18 OK; R29 checked (21 functions, 13 token models / 44 `find*`,
9 `validateExtensionToken` sites, limiter semantics); R42 OK; R43 F44; R47 OK; R48 OK; R49 F45; R52 OK.
### Security expert
R1 OK; R3 OK; R29 S26; R42 S29; R43 OK; R46 S30; R47 S28; R48 OK; R49 S27; R52 OK; RS4 OK;
RS1/RS2/RS3/RS5/RS6 N/A.
### Testing expert
R3 T27; R29 reproduced; R42 T27; R46/R47 T28, T29; R19/R49/R50 OK; RT1 OK (no C9 assertion exists);
RT2 T24; RT4 OK; RT5 T25, T26; RT6 OK; RT7 T28–T30; RT8 OK; RT10 OK; RT11 OK; RT3/RT9 N/A.
