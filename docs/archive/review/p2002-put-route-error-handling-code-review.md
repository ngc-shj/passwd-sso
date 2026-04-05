# Code Review: p2002-put-route-error-handling
Date: 2026-04-05
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### CR-F1 [Major] Missing P2002 handling in personal tags PUT route
- File: src/app/api/tags/[id]/route.ts:94-99
- Problem: /api/tags/[id] PUT updates name and parentId on Tag model with @@unique([name, parentId, userId]) but had no P2002 catch — same race condition vulnerability as the 3 routes already fixed
- Fix: Added P2002 try-catch with errorResponse(API_ERROR.TAG_ALREADY_EXISTS, 409) and test case

## Security Findings
No findings

## Testing Findings
No findings (minor style inconsistency noted: mockResolvedValue vs mockResolvedValueOnce — safe due to vi.clearAllMocks in beforeEach)

## Adjacent Findings
None

## Quality Warnings
None

## Resolution Status
### CR-F1 [Major] Missing P2002 in personal tags PUT
- Action: Added P2002 catch + test to src/app/api/tags/[id]/route.ts and route.test.ts
- Commit: review(1): add missing P2002 handling to personal tags PUT route
