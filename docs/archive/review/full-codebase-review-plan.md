# Full Codebase Review: passwd-sso

## Objective
Comprehensive multi-agent review of the entire passwd-sso codebase (~180k lines, 1100 files) to identify any remaining issues across functionality, security, and testing dimensions.

## Requirements
- Identify Critical/Major issues that may have been missed in incremental reviews
- Validate that security patterns (E2E encryption, RLS, CSP, auth) are correctly implemented throughout
- Verify test coverage adequacy for critical paths
- Check for consistency across similar patterns (API routes, validation, error handling)

## Technical Approach
- Three expert agents review the codebase in parallel
- Focus areas: crypto implementation, authentication flows, API route handlers, database queries, client-side security
- Local LLM pre-screening to catch mechanical issues before expert review

## Scope
- All source code under `src/`
- Prisma schema and migrations
- Configuration files (proxy, auth, Docker)
- Test files under `src/` and `__tests__/`

## Testing Strategy
- Verify existing test coverage for critical paths
- Identify gaps in test coverage
- Check for false-positive tests

## Considerations & Constraints
- This is a review of existing, mature code — not new implementation
- The codebase has already undergone extensive incremental review
- Focus on systemic issues rather than style/formatting
- E2E encryption means server never sees plaintext — review with this constraint in mind
