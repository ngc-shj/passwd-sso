# Coding Deviation Log: p3-security-hardening
Created: 2026-03-08T02:30:00+09:00

## Deviations from Plan

### DEV-1: ioredis API migration (getDel, set EX, pExpire, pTTL)
- **Plan description**: Migrate redis.ts and rate-limit.ts from node-redis to ioredis
- **Actual implementation**: Also required migrating all redis.set() calls from `{ EX: ttl }` (node-redis options object) to `"EX", ttl` (ioredis positional args), and getDel → getdel (case-sensitive in ioredis). Affected files: webauthn register/authenticate options/verify routes, passkey options routes, webauthn-authorize.ts
- **Reason**: ioredis uses lowercase method names and positional parameters instead of node-redis's camelCase methods and options objects
- **Impact scope**: src/app/api/webauthn/*, src/app/api/auth/passkey/*, src/lib/webauthn-authorize.ts, and their test files

### DEV-2: NOTIFICATION_TYPE constant synchronization
- **Plan description**: Add SESSION_EVICTED to Prisma NotificationType enum
- **Actual implementation**: Also required adding SESSION_EVICTED to src/lib/constants/notification.ts which has a `satisfies Record<NotificationType, NotificationType>` constraint
- **Reason**: TypeScript compilation fails if the constant map doesn't include all enum values
- **Impact scope**: src/lib/constants/notification.ts

### DEV-3: i18n keys for new audit actions
- **Plan description**: Add ENTRY_HISTORY_REENCRYPT and SESSION_EVICTED audit actions
- **Actual implementation**: Also required adding i18n translation keys for both actions in messages/en/AuditLog.json and messages/ja/AuditLog.json
- **Reason**: Existing test (audit-log-keys.test.ts) enforces that every AUDIT_ACTION has corresponding i18n entries
- **Impact scope**: messages/en/AuditLog.json, messages/ja/AuditLog.json

### DEV-4: Existing test updates for auth-adapter and sessions route
- **Plan description**: Write new tests for session enforcement and history re-encryption
- **Actual implementation**: Also required updating existing tests: auth-adapter.test.ts (transaction mock needed tx.tenant.findUnique and tx.session for session enforcement), sessions/route.test.ts (response shape changed from array to {sessions, sessionCount, maxConcurrentSessions})
- **Reason**: Implementation changes affected the behavior of existing code paths
- **Impact scope**: src/lib/auth-adapter.test.ts, src/app/api/sessions/route.test.ts

### DEV-5: docker-compose.ha.yml not created
- **Plan description**: Create docker-compose.ha.yml with Redis Sentinel overlay
- **Actual implementation**: Documented Sentinel configuration in docs/operations/redis-ha.md but did not create the actual compose file
- **Reason**: Infrastructure configuration files should be customized per deployment; documentation provides the reference configuration
- **Impact scope**: docs/operations/redis-ha.md
