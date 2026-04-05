# Coding Deviation Log: p2002-put-route-error-handling
Created: 2026-04-05

## Deviations from Plan

### D1: Used errorResponse helper instead of NextResponse.json
- **Plan description**: Pattern shows `NextResponse.json({ error: ... }, { status: 409 })` following service-accounts reference
- **Actual implementation**: Used `errorResponse(API_ERROR.*, 409)` helper
- **Reason**: Local LLM pre-screening caught that all other error responses in the same files use `errorResponse`. Using `NextResponse.json` directly would be inconsistent.
- **Impact scope**: No behavioral change — `errorResponse` wraps `NextResponse.json` with the same shape

### D2: Added personal tags route (not in original plan)
- **Plan description**: Only 3 routes targeted (folders, team folders, team tags)
- **Actual implementation**: Added 4th route — `/api/tags/[id]` (personal tags)
- **Reason**: Code review found that personal tags have @@unique([name, parentId, userId]) and the PUT handler updates both name and parentId — same vulnerability as team tags
- **Impact scope**: src/app/api/tags/[id]/route.ts + route.test.ts

---
