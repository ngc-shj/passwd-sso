# Code Review: fix-webhook-subscribable-events
Date: 2026-04-01
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings
No findings. All requirements verified correct.

## Security Findings
No findings. SSRF protection, HMAC signing, auth/authz, and tenant isolation confirmed unchanged.

## Testing Findings

**T1 Major**: `webhook-dispatcher.test.ts` — `justification`/`requestedScope` PII stripping test missing
- Action: Added both keys to test data and negative assertions
- Modified file: `src/lib/webhook-dispatcher.test.ts:618-652`

**T2 Major**: `tenant-webhook-card.test.tsx` — SERVICE_ACCOUNT/ADMIN assertions incomplete (4/8 + 1/4)
- Action: Added all 8 SERVICE_ACCOUNT actions + 3 ADMIN vault reset actions
- Modified file: `src/components/settings/tenant-webhook-card.test.tsx:132-160`

**T3 Major**: `tenant-webhook-card.test.tsx` — MCP_CLIENT/DELEGATION exclusion untested
- Action: Added negative assertions for `MCP_CLIENT_CREATE` and `DELEGATION_CREATE`
- Modified file: `src/components/settings/tenant-webhook-card.test.tsx:86-96`

**T4 Minor**: `audit.test.ts` — group key exclusion only, no action-value-level check
- Action: Added action value assertions for excluded actions (TENANT_WEBHOOK_CREATE, MCP_CLIENT_CREATE, DELEGATION_CREATE, PERSONAL_LOG_ACCESS_VIEW/EXPIRE, HISTORY_PURGE)
- Modified file: `src/lib/constants/audit.test.ts:119-132`

## Adjacent Findings
None

## Quality Warnings
None

## Resolution Status

### T1 Major — PII stripping test for justification/requestedScope
- Action: Added to webhook-dispatcher.test.ts
- Modified file: src/lib/webhook-dispatcher.test.ts:618-652
- Status: Resolved

### T2 Major — Complete SERVICE_ACCOUNT/ADMIN assertions
- Action: Added all missing action assertions
- Modified file: src/components/settings/tenant-webhook-card.test.tsx:132-160
- Status: Resolved

### T3 Major — MCP_CLIENT/DELEGATION exclusion assertions
- Action: Added negative assertions
- Modified file: src/components/settings/tenant-webhook-card.test.tsx:86-96
- Status: Resolved

### T4 Minor — Action-value-level exclusion test
- Action: Added to audit.test.ts
- Modified file: src/lib/constants/audit.test.ts:119-132
- Status: Resolved
