# Plan Review: refactor-team-password-endpoints
Date: 2026-03-19
Review rounds: 3

## Round 1 — Initial Review

### Functionality Findings

#### F1 [Major] Components render `teamName` and `role` from response — RESOLVED (Round 1)
- **Problem:** Both components use `entry.teamName` and `entry.role` from the API response, but the team-specific endpoint does not return these fields.
- **Resolution:** Plan updated to pass `teamName` and `role` as props from the parent page.

#### F2 [Minor] Dead code branches after `teamId` becomes required — RESOLVED (Round 1)
- **Resolution:** Plan explicitly removes `!scopedTeamId` conditional branches.

#### F3 [Minor] Verify `API_PATH.TEAMS_FAVORITES` callers — RESOLVED (Round 1)
- **Resolution:** Added to pre-implementation verification checklist.

### Security Findings

#### S1 [Minor — Improvement] RLS bypass removal — NOTED
- Cross-team endpoints use `withBypassRls`; replacement uses `withTeamTenantRls`. Net security improvement.

#### S2 [Minor] `createdBy.email` over-disclosure — RESOLVED (Round 1)
- **Resolution:** Added verification step. UI does not render email. Accepted.

#### S3 [Minor] TypeScript strict null for `teamId` — RESOLVED (Round 1)
- **Resolution:** Making prop required + `npx next build` covers this.

### Testing Findings

#### T1 [Critical] No behavioral component tests for URL switch — RESOLVED (Round 1)
- **Resolution:** Plan now includes URL-assertion tests for both components.

#### T2 [Major] `team-bulk-wiring.test.ts` regression gap — RESOLVED (Round 1)
- **Resolution:** Covered by new URL tests in T1.

#### T3 [Major] Surviving route test coverage verification — RESOLVED (Round 1)
- **Resolution:** Pre-implementation step added. Confirmed: `route.test.ts` already has `?archived=true` and `?trash=true` test cases.

#### T4 [Minor] Grep confirmation after constant removal — RESOLVED (Round 1)
- **Resolution:** Added to verification checklist.

## Round 2 — Incremental Review

### Functionality Findings

#### F4 [Major] `team` state is null at mount time — RESOLVED (Round 2)
- **Problem:** `team` is initialized as `null` and `teamName`/`role` props would be undefined at first render.
- **Resolution:** Plan updated to guard rendering with `team !== null` check.

#### F5 [Minor] `scopedRole` derivation block in TeamTrashList — RESOLVED (Round 2)
- **Resolution:** Plan explicitly mentions replacing `scopedRole` block with `role` prop.

### Security Findings

#### S4 [Minor] `createdBy.email` in new response — ACCEPTED
- Team-specific endpoint includes `createdBy.email`; UI does not render it. Accepted as-is.

### Testing Findings
No findings.

## Round 3 — Final Review

### Functionality Findings

#### F6 [Major] `userRole` variable does not exist — RESOLVED (Round 3)
- **Problem:** Plan referenced `role={userRole}` but the correct variable is `team.role`.
- **Resolution:** Fixed to `role={team.role}`.

### Security Findings
No findings.

### Testing Findings
No findings.

## Final Status

All Critical and Major findings resolved. Plan is ready for implementation.
