# Code Review: webhook-card-shared-component
Date: 2026-03-31
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

No Critical or Major findings.

### F1 [Minor]: `showInactive` useState declared after computed values
- File: base-webhook-card.tsx:209
- Problem: `showInactive` useState is declared after `limitReached`, `activeWebhooks`, `inactiveWebhooks` computations (L205-208). Best practice is to group all useState declarations together.
- Assessment: Pre-existing pattern from original code. No functional impact. Deferred.

### F2 [Minor]: Test factory uses hardcoded `5` for MAX_WEBHOOKS
- File: webhook-card-test-factory.tsx (limit test)
- Problem: `Array.from({ length: 5 })` should import `MAX_WEBHOOKS` constant.
- Assessment: Pre-existing in original tests. Low priority.

## Security Findings

No Critical or Major findings.

### S1 [Minor]: Server-side SSRF validation confirmation
- File: base-webhook-card.tsx:109-119
- Problem: Client-side URL validation enforces https but server-side must also validate (no private IPs, no metadata endpoints).
- Assessment: Out of scope — this is about the API route handler, not this UI component.

### S2 [Minor]: Secret stored in React state
- File: base-webhook-card.tsx:85
- Problem: `newSecret` in React state is visible via DevTools.
- Assessment: Expected behavior — secret is user-visible by design. `null` on dismiss is correct.

## Testing Findings

No Critical findings.

### T1 [Major — pre-existing]: POST mock response shape unverified
- File: webhook-card-test-factory.tsx (setupFetchWebhooks)
- Problem: POST mock returns `{ webhook: { id, url }, secret }`. Component only reads `data.secret`. The `webhook` object presence is unverified against actual API.
- Assessment: Pre-existing mock pattern from original tests. Component behavior is correct. The `webhook` field may be extra but does not affect test validity.

### T2 [Major — pre-existing]: Event action strings hardcoded in variant-specific tests
- Files: tenant-webhook-card.test.tsx:113-141, team-webhook-card.test.tsx:105-109
- Problem: Event action names like "TENANT_ROLE_UPDATE" are hardcoded strings instead of importing from `AUDIT_ACTION` constants.
- Assessment: Pre-existing in original tests. These match i18n mock behavior (`key => key`). Not introduced by this refactor.

### T3 [Minor]: Collapsible mock does not respect open prop
- File: webhook-card-test-factory.tsx (Collapsible mock)
- Problem: Plan specified Collapsible mock should respect `open` prop. Current mock renders children unconditionally.
- Assessment: Component controls visibility via `{showInactive && ...}` JSX, not via Collapsible open prop. Auto-expand test is valid. Pre-existing pattern.

## Adjacent Findings

### [Adjacent] S3 [Minor]: Team wrapper lacks subscribable events filter
- Origin: Security expert
- Problem: Tenant wrapper uses `TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS` filter; team does not.
- Assessment: Intentional design — tenant has privacy-sensitive actions (PERSONAL_LOG_ACCESS_VIEW/EXPIRE) that must be excluded. Team audit actions are all subscribable by design. Not a bug.

## Quality Warnings
None

## Resolution Status

All findings are either pre-existing patterns from original code or out of scope for this refactoring. No code changes required for this review round. All three experts confirm the refactoring itself is clean and correct.
