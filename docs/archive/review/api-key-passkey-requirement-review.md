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
