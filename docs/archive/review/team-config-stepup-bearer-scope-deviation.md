# Coding Deviation Log: team-config-stepup-bearer-scope

### D1 — JSDoc block-comment parse fix (C4, side-fix)
- **File**: `src/lib/proxy/cors-gate.ts`
- The S1-constraint doc comment originally wrote `teams/*/passwords` — the `*/` prematurely closed the JSDoc block comment (parse error). Changed to `teams/<teamId>/passwords`. Side-fix discovered during the sub-agent's own test run; documentation-only, no behavior change.
