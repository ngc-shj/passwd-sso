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
