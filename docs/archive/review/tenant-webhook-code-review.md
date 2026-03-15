# Code Review: tenant-webhook
Date: 2026-03-15
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| F-1 | Minor | dry-run dispatches webhook in directory-sync/run | Fixed: guarded with `if (!dryRun)` |
| F-2 | Minor | URL validation doesn't check DNS-resolved IPs | Skipped: same as team webhook, separate task |

## Security Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| S-1 | Major | SSRF via DNS-resolved FQDN | Skipped: pre-existing limitation in team webhook, separate task |
| S-2 | Major | Decryption failure indistinguishable from network error | Fixed: separate try/catch with explicit log message |
| S-4 | Minor | TOCTOU on webhook count limit | Skipped: same pattern as team webhook |

## Testing Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| T-1 | Major | HMAC test uses raw event, sanitization is no-op | Fixed: explicit sanitized form in test |
| T-2 | Major | rethrow test only covers delete, not findFirst | Fixed: added findFirst rethrow test |
| T-3-6 | Minor | Various test improvements | Noted for future improvement |

## Resolution Status
### F-1 Minor: dry-run webhook dispatch
- Action: Added `if (!dryRun)` guard
- Modified file: src/app/api/directory-sync/[id]/run/route.ts:117

### S-2 Major: Decryption error logging
- Action: Separated decryption into own try/catch with specific error message
- Modified file: src/lib/webhook-dispatcher.ts:137-149

### T-1 Major: HMAC test payload
- Action: Used explicit sanitized event form for payload construction
- Modified file: src/lib/webhook-dispatcher.test.ts:310-313

### T-2 Major: findFirst rethrow test
- Action: Added test case for findFirst errors propagating
- Modified file: src/app/api/tenant/webhooks/[webhookId]/route.test.ts:146-155
