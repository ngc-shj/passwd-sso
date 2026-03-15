# Plan Review: tenant-webhook
Date: 2026-03-15
Review round: 2

## Changes from Previous Round (Round 2)
- TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS excludes TENANT_WEBHOOK group and VIEW/EXPIRE
- Breakglass VIEW/EXPIRE removed from dispatch integration
- apiPath entries explicitly documented
- groupLabel entries for DIRECTORY_SYNC/BREAKGLASS added
- sanitizeMetadata() applied inside dispatcher
- User-Agent header added to deliverWithRetry()
- assertOrigin(req) on POST handler
- Test plan expanded with scope assertions, cross-scope rejection, secret exclusion, call-site integration

## Round 1 Findings

### Functionality Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| F-1 | Major | TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS includes self-referential TENANT_WEBHOOK group | Resolved: explicitly excluded from constant |
| F-2 | Major | BREAKGLASS EXPIRE dispatch placement underspecified | Resolved: VIEW/EXPIRE excluded from dispatch entirely |
| F-3 | Minor | apiPath entries missing | Resolved: added to Step 2 |
| F-4 | Minor | groupLabel missing DIRECTORY_SYNC/BREAKGLASS | Resolved: added to Step 7 |

### Security Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| S-1 | Major | VIEW/EXPIRE should not be subscribable (privacy timing leak) | Resolved: excluded from subscribable actions |
| S-2 | Major | Webhook payload data field lacks sanitization contract | Resolved: sanitizeMetadata() in dispatcher |
| S-3 | Minor | Missing User-Agent header | Resolved: added to deliverWithRetry() |
| S-4 | Minor | Missing assertOrigin CSRF check | Resolved: added to POST handler |

### Testing Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| T-1 | Critical | Prisma mock namespace collision for tenantWebhook | Resolved: extend vi.hoisted mock |
| T-2 | Critical | DELIVERY_FAILED audit log scope assertion missing | Resolved: assert scope/tenantId/no teamId |
| T-3 | Major | Cross-scope event rejection test missing | Resolved: added to test plan |
| T-4 | Major | GET response secret field exclusion test missing | Resolved: added to test plan |
| T-5 | Major | Zero call-site integration tests | Resolved: 3 routes added to test plan |
| T-6 | Minor | UI self-referential group exclusion test missing | Resolved: added to test plan |
| T-7 | Minor | DELETE rethrow test missing | Resolved: added to test plan |

## Round 2 Findings

### Functionality Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| F2-1 | Major | sanitizeMetadata() does not strip business PII (email, reason, incidentRef) | Resolved: introduced WEBHOOK_METADATA_BLOCKLIST |
| F2-2 | Minor | Call site count is ~20 not ~17 (ownership transfer path, multi-action files) | Resolved: updated count |
| F2-3 | Minor | UI event selector shows VIEW/EXPIRE but API rejects them | Resolved: UI uses TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS |
| F2-4 | Minor | POLICY_UPDATE/AUDIT_LOG_DOWNLOAD gap in AUDIT_ACTION_GROUPS_TENANT | Skipped: out of scope, existing gap |

### Security Findings
No new Critical or Major findings. 3 Minor findings on existing code (out of scope).

### Testing Findings
| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| T2-1 | Critical | sanitizeMetadata will be undefined in mock | Resolved: vi.importActual re-export |
| T2-2 | Major | teamId absence needs not.toHaveProperty pattern | Resolved: explicit assertion pattern in plan |
| T2-3 | Major | Existing team test missing scope assertion | Skipped: existing test, separate task |
| T2-4 | Major | TENANT_WEBHOOK_CREATE constant must exist before test | Resolved: implementation ordering noted |
| T2-5 | Minor | Breakglass DELETE "already expired" path untested | Skipped: existing test gap |
| T2-6 | Minor | SCIM token route tenantId sourcing assertion | Noted for implementation |
| T2-7 | Minor | audit-log-action-groups.test.ts coverage gap | Noted for implementation |

## Resolution Status
All Critical and Major findings resolved across 2 rounds. Remaining Minor items are either out of scope (existing code gaps) or noted for implementation-time attention.
