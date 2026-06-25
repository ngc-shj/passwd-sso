# Plan Review: team-config-stepup-bearer-scope
Date: 2026-06-25
Review rounds: 2

## Changes from Previous Round
Initial plan: step-up on team webhooks (POST/DELETE) + team policy PUT (mirroring PR #606 tenant routes), + narrow the over-broad `/api/teams` Bearer-bypass. Round 1 expanded scope and tightened the test spec; Round 2 verified the fixes and refined C5's test/ordering.

## Functionality Findings
- **F1/F8 (Major, resolved)**: `proxy.test.ts` had no positive Bearer-bypass test for team paths — a broken matcher would silently 401 all iOS/extension clients with no test catching it. Plan now adds explicit positive (cookieless-Bearer → reach handler) + deny proxy tests.
- **F10 (verified)**: the C4 allow set is exactly correct — iOS fetches `/api/teams`, `/api/teams/<id>/passwords`, `/api/teams/<id>/member-key`; extension adds `/api/teams/<id>/passwords/<entryId>` (the child path that makes the Explore agent's exact-`passwords` regex wrong). Captured as the load-bearing `passwords/e1 → allow` matrix row.
- C1/C2/C3 insertion points confirmed against actual source. `req` in scope in all handlers.

## Security Findings
- **S1 (Major → accepted residual)**: the `passwords` prefix makes mutating children (bulk-import, empty-trash, bulk-purge, etc.) Bearer-*reachable*. Safe today (all `auth()`-only, session-401 a Bearer at the handler). No clean structural split (`passwords/<entryId>` and `passwords/bulk-import` are both single-segment). Resolved via a locked constraint + grep-able TODO: these children must not gain `checkAuth` write scope without narrowing the matcher.
- **S2 (Major, resolved → C5)**: `members/[memberId]` PUT (role change, incl. OWNER transfer) is the DIRECT symmetric counterpart of the gated `tenant/members/[userId]` PUT — was wrongly scoped out as "no counterpart". Added as **C5**.
- **S3 (Minor, resolved)**: C3 step-up moved to before parseBody/DB lookup, matching the tenant policy pattern.
- **R2 S-R2-N1 (Minor, resolved)**: C5 step-up moved before the existence lookup (matching its exact tenant counterpart), closing a membership-existence oracle.
- **R2 S-R2-N2 (Informational, resolved)**: bulk-purge + the other bulk children noted in the C4 matrix row.
- **Complete tenant→team mapping verified** (R2): every `requireRecentCurrentAuthMethod`-gated tenant route was mapped to its team analog. C1-C5 cover all 4 that have a team analog (webhooks POST/DELETE, policy, members PUT); the rest (reset-vault, breakglass, mcp-clients, service-accounts, scim-tokens, audit-delivery, operator-tokens, access-requests) have no team analog. **No gated tenant route with a team counterpart is missed.**

## Testing Findings
- **T1/T2/T3/T4 (Major/Minor, resolved)**: proxy.test.ts positive+deny rows + line-206 description fix; all 11 cors-gate.test.ts matrix rows enumerated (existing file has only 3); centralized `src/__tests__/api/teams/team-policy.test.ts` named explicitly for the R19 mock (the exact PR #606 tenant-policy.test.ts recurrence); non-vacuous reject setup specified.
- **R2 T-R2-1/2/3 (Major/Minor, resolved)**: C5 reject test must assert BOTH mutation spies (`mockPrismaTeamMember.update` + `mockTransaction`, for the regular + owner-transfer branches); the reject setup specified to avoid the OWNER-target / OWNER-body vacuous traps; with the C5 ordering change (step-up before existence), the reject test no longer needs `findUnique` to return a row.

## Recurring Issue Check
- **R34 (class completeness — the user's core ask)**: addressed via the full tenant→team mapping. C5 was the missed-instance the first pass would have shipped; the mapping confirms completeness.
- **R19 (mock alignment incl. centralized tests)**: the centralized policy test is named explicitly — this is the PR #606 recurrence guard.
- **Least-privilege (C4)**: narrowing is a net improvement; the bypass only governs proxy reachability for cookieless Bearer, handlers enforce auth independently. The `passwords` prefix residual is documented + constrained.

## Environment Verification Report
- **VC1** (Bearer-bypass narrowing): the matcher is a pure string function fully `verifiable-local` via the cors-gate.test.ts acceptance matrix; the proxy behavior via proxy.test.ts. Full live iOS/extension-against-proxy E2E is `blocked-deferred` (needs running app + provisioned token) — justified in the plan's VC1 entry, pinned by the unit matrix against every real client path.

## Resolution Status
All Major/Critical findings resolved across 2 rounds. Minors either fixed or accepted with documented justification. Plan locked at 5 contracts (C1-C5). Ready for Phase 2.
