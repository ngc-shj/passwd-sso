# Plan Review: feat-share-access-password
Date: 2026-03-11
Review round: 2

## Round 1 Findings (All Resolved)
F1-F13: All resolved in plan update. See details below.

## Round 2 Changes
- F1: sessionStorage + Authorization header (no URL params)
- F2: viewCount deferred to content API
- F3: E2E shares supported with password gate
- F7: Imports fixed in share-access-token.ts
- F8: Password max(44)
- F9: JSON payload format
- F10: Download endpoint maxViews check added
- F11-F13: Testing strategy expanded

## Round 2 New Findings (Consolidated & Deduplicated)

### F14 [Major] Route param `[shareId]` vs `[id]` inconsistency (Func R2-F15, Test R2-#1)
- **Status**: RESOLVED — unified to `[id]` matching existing pattern

### F15 [Major] FILE viewCount ambiguity (Func R2-F16, Sec R2-F12)
- **Status**: RESOLVED — viewCount incremented only in page.tsx (non-protected) or content API (protected). Download never increments.

### F16 [Major] Download lacks maxViews check for ALL shares (Sec R2-F11, Test R2-#3)
- **Status**: RESOLVED — added maxViews/viewCount to download select + check for all shares

### F17 [Major] page.tsx must pass `token` to ShareProtectedContent (Test R2-#6)
- **Status**: RESOLVED — props now include `token` and `shareId`

### F18 [Major] page.tsx needs `accessPasswordHash` in select (Test R2-#9)
- **Status**: RESOLVED — documented in plan

### F19 [Major] Download needs `accessPasswordHash` in select (Test R2-#10)
- **Status**: RESOLVED — documented in plan

### F20 [Minor] Password max(44) vs actual 43 chars (Func R2-F14)
- **Status**: Accepted — max(44) gives 1 char headroom, no security impact

### F21 [Minor] Rate limiter key design (Sec R2-F13)
- **Status**: RESOLVED — documented exact key patterns and noted tokenHash usage

### F22 [Minor] Section numbering duplicate (Test R2-#7)
- **Status**: RESOLVED — renumbered sections

### F23 [Minor] Access token replay within TTL (Sec R2-F14)
- **Status**: Accepted — maxViews atomic check prevents abuse, TTL is short

### F24 [Minor] generateAccessPassword character set test (Test R2-#8)
- **Status**: Accepted — base64url format validated by length test, Node.js guarantees character set

## Current Status
- Critical: 0
- Major: 0 (all resolved)
- Minor: 3 accepted (F20, F23, F24 — no action needed)
- All other findings: Resolved

## Functionality Findings
F14, F15, F17, F18 — all resolved

## Security Findings
F16, F19, F21, F23 — resolved or accepted

## Testing Findings
F14, F16, F17, F18, F19, F22, F24 — resolved or accepted
