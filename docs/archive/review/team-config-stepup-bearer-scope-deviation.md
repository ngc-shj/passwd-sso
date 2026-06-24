# Coding Deviation Log: team-config-stepup-bearer-scope

### D1 — JSDoc block-comment parse fix (C4, side-fix)
- **File**: `src/lib/proxy/cors-gate.ts`
- The S1-constraint doc comment originally wrote `teams/*/passwords` — the `*/` prematurely closed the JSDoc block comment (parse error). Changed to `teams/<teamId>/passwords`. Side-fix discovered during the sub-agent's own test run; documentation-only, no behavior change.

## Phase 3 deviations

### D2 — F3 in-code SC1 TODO markers skipped (review F3, Minor)
- **Anti-Deferral check**: out of scope (cosmetic — deferral already tracked)
- **Justification**: review F3 proposed adding `TODO(team-config-stepup)` comments to the SC1-deferred routes (rotate-key POST, team DELETE, member DELETE) to signal the deliberate step-up deferral in-code. Skipped because the deferral is the system-of-record in the plan's SC1 + this deviation log; adding comments to 3 route files this PR otherwise does not touch expands the diff with noise and zero behavior change (YAGNI). The functionality expert marked it optional/cosmetic.
- **Orchestrator sign-off**: deferral documented in SC1; no in-code marker needed.

## Phase 3 — reviewer follow-up + horizontal sweep (横展開)

### D3 — member DELETE step-up (reviewer High finding → C6)
- `teams/[teamId]/members/[memberId]` DELETE removed a member (deletes their team key + membership) with only MEMBER_REMOVE — no step-up. My original SC1 scope-out reasoned "no tenant counterpart", but that conflated symmetry with risk: member removal is the same key-access-revoking high-privilege op as the gated PUT (role change). Reviewer correct. Added the gate (before existence, matching the PUT/oracle-closing precedent) + reject test asserting mutation + findUnique not called.

### D4 — horizontal sweep: Tier1 step-up (user "横展開", Tier1)
- A systematic sweep of ALL team mutating routes (classified by step-up status × operation sensitivity) found 6 ungated routes in the same identity/key-custody/lifecycle class as C6. User chose Tier1 (key-custody/lifecycle): added step-up to `teams/[teamId]` PUT+DELETE (config update / team-deletion = bulk vault + key destruction), `rotate-key` POST (key rotation), `members` POST (add member = grants vault key access), `members/[memberId]/confirm-key` POST (key distribution). Tier2 (invitations POST/DELETE — precursor, no direct key access) deferred to the SSoT doc's "deferred" table.
- Ordinary content CRUD (passwords/folders/tags/attachments/favorites/bulk-*, invitation-accept) deliberately NOT gated — tenant side doesn't gate these; the threat surface is governance/identity/key, not individual records.
- **Side-fix**: the confirm-key test's "404 when admin not a member" case used the REAL requireTeamPermission (via mocked prisma findFirst). Adding the step-up reject test required mocking `@/lib/auth/access/team-auth` at the module boundary (consistent with all sibling team tests), so that case was adapted to `mockRequireTeamPermission.mockRejectedValueOnce(404)`. Behavior asserted (404) unchanged; mechanism moved to the mock boundary, matching the established pattern.

### D5 — SSoT doc created (user suggestion)
- `docs/security/step-up-reauth-routes.md` — single source of truth listing every step-up-gated route (tenant + team) by class, the gated/not-gated criteria, deferred routes, and the R19 test obligation + a grep-based conformance check. Verified to match the actual code (all 8 team + 19 tenant gated routes present; 2 deferred routes correctly ungated). This is the lightweight stand-in for the PR #606 SC2 centralized operation-sensitivity guard, and the structural defense against the "enumerate-by-route-area misses routes" failure mode this work hit repeatedly.
