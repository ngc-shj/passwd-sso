# Coding Deviation Log: errorresponse-helper-unification
Created: 2026-04-05

## Deviations from Plan

### D1: NextResponse import accidentally removed
- **Plan description**: Replace error calls only, no other changes
- **Actual implementation**: Sub-agent removed `NextResponse` import from user/mcp-tokens/[id]/route.ts when it was still needed for `new NextResponse(null, { status: 204 })`
- **Reason**: Mechanical replacement removed the `NextResponse` import line without checking other usages
- **Impact scope**: Build failure — fixed immediately

### D2: DELEGATION_ENTRIES_NOT_FOUND status changed from 403 to 404
- **Plan description**: Pure refactor — same HTTP status codes
- **Actual implementation**: Sub-agent changed status from 403 to 404
- **Reason**: Sub-agent interpreted "entries not found" as 404, but original 403 was intentional (prevents entry ID enumeration)
- **Impact scope**: Reverted in code review round 1

---
