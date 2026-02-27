# passwd-sso Production-Readiness ToDo

Last updated: 2026-02-27
Baseline: `main` branch

---

## Legend

- **Required** — blocker for production release
- **Strongly Recommended** — should be addressed soon after release
- **Recommended** — phased improvement item

---

## 1. Operational Foundation

| # | Priority | Item | Status | Notes |
|---|--------|------|------|------|
| 1.1 | Required | Build CI/CD pipeline | Done | GitHub Actions with 4 parallel jobs (app-ci / extension-ci / audit-app / audit-ext). ESLint native flat-config migration completed. PR #18 |
| 1.2 | Required | External audit-log forwarding (pino + Fluent Bit) | Done | Structured JSON audit events to stdout -> Fluent Bit -> arbitrary sink. Defense in depth (`sanitizeMetadata` + pino redact). PR #14 |
| 1.3 | Required | Application structured logging | Done | Generic pino app logger (`_logType: "app"`) + `withRequestLog()` wrapper for requestId/latency. Phase 1 coverage: vault/passwords/auth/csp-report. CSP report body sanitized. PR #20 |
| 1.4 | Required | Health-check endpoints | Done | `/api/health/live` (fixed 200 liveness) + `/api/health/ready` (DB + Redis readiness; unhealthy -> 503). `HEALTH_REDIS_REQUIRED=true` to fail on Redis outage. PR #22 |
| 1.5 | Required | Monitoring/alerting foundation | Done | Terraform: CloudWatch metric filters (5xx, health failures, high latency) + 4 alarms + EventBridge ECS stop detection + SNS notifications. App code remains vendor-neutral. PR #22 |
| 1.6 | Strongly Recommended | Error tracking (Sentry etc.) | Not started | Client + server error collection and notifications |

---

## 2. Security Hardening

| # | Priority | Item | Status | Notes |
|---|--------|------|------|------|
| 2.1 | Required | Environment validation | Done | Startup-time validation of 26 env vars via Zod schema (`src/lib/env.ts` + `instrumentation.ts`). PR #17 |
| 2.2 | Required | Account lockout | Done | DB-persisted progressive lockout (5->15m, 10->1h, 15->24h) + 24h observation window + audit logs (`VAULT_UNLOCK_FAILED` / `VAULT_LOCKOUT_TRIGGERED`). Works with existing rate limiter. Admin notification currently via audit/ops logs (CloudWatch alarm automation in later phase). PR #24 |
| 2.3 | Required | Passphrase recovery flow | Done | Recovery key (256-bit, HKDF+AES-256-GCM) restores `secretKey` + sets new passphrase. Vault Reset (full data deletion) as final fallback. Missing-key banner prompt (reappears after 24h). 4 audit events. CSRF (Origin validation) + rate limiting included. PR #25 |
| 2.4 | Strongly Recommended | Explicit CORS policy | Done | Same-origin-only policy explicitly enforced. OPTIONS preflight 204 + `applyCorsHeaders()` on all API return paths. `Vary: Origin` + case-insensitive dedupe. Extension bypasses CORS via Service Worker + bearer token. Policy documented in `../security/cors-policy.md`. #46, PR #57 |
| 2.5 | Strongly Recommended | Concurrent session management | Not started | Session list view, remote logout, new-login notification |
| 2.6 | Strongly Recommended | Document key-material memory handling | Partially done | Covered in `../security/security-review.md`. Risk acceptance under Web Crypto constraints should be published for users as well |
| 2.7 | Recommended | External third-party security audit | Not started | External crypto review (NCC Group, Cure53, etc.) |

---

## 3. Data Protection / Availability

| # | Priority | Item | Status | Notes |
|---|--------|------|------|------|
| 3.1 | Required | Backup/recovery strategy | Done | AWS Backup Vault Lock (WORM/compliance) + S3 Object Lock + cross-region copy + EventBridge failure notifications. RPO 1h / RTO 2h. PR #23 |
| 3.2 | Strongly Recommended | DB connection pool tuning | Done | pg.Pool via env tuning (max / connectionTimeoutMillis / idleTimeoutMillis / maxLifetimeSeconds / statement_timeout). `envInt()` strict parse + range guard (production fail-fast). `pool.on("error")` + SIGTERM graceful shutdown. CloudWatch RDS `DatabaseConnections` alarm added. #48 |
| 3.3 | Strongly Recommended | Separate migration strategy | Done | ECS one-off task definition (Fargate RunTask) fully separates migrations from app startup. `deploy.sh` enforces migrate -> success check -> app update order. docker-compose profile split. `../operations/deployment.md`. #47 |
| 3.4 | Recommended | Redis high availability | Not started | Current deployment is single Redis. Consider Redis Sentinel / ElastiCache failover |

---

## 4. Testing / Quality Assurance

| # | Priority | Item | Status | Notes |
|---|--------|------|------|------|
| 4.1 | Required | Introduce E2E tests | Done | Playwright (Chromium). 7 specs / 22 cases: setup -> unlock -> CRUD -> lock/reunlock -> Recovery Key -> Vault Reset -> locale switch. Node crypto helpers (shared `CRYPTO_CONSTANTS`), dual DB safety guard (URL pattern + `E2E_ALLOW_DB_MUTATION`), 16 crypto-compat tests. CI job includes PostgreSQL + Redis services |
| 4.2 | Strongly Recommended | Expand coverage targets | Partially done | Component test foundation in place (`@testing-library/react` + `jsdom`, `.test.tsx`). Coverage scope still limited to 4 paths -> add `crypto-client.ts` and component layers |
| 4.3 | Strongly Recommended | Load testing | Done | k6 with 6 scenarios (health / vault-unlock / passwords-list / passwords-create / passwords-generate / mixed-workload). DB seed script with triple safety guards + smoke test. Initial SLO goals + threshold-based pass/fail. #49 |
| 4.4 | Recommended | Automated security scanning | Not started | Integrate Dependabot / Snyk / Trivy (container) into CI |

---

## 5. Compliance / Documentation

| # | Priority | Item | Status | Notes |
|---|--------|------|------|------|
| 5.1 | Required | Privacy policy / terms of service | Not started | APPI (Japan), GDPR alignment. Data Processing Agreement (DPA) |
| 5.2 | Strongly Recommended | Dependency license audit | Done | CI strict mode (`--strict`) fails on unreviewed/expired entries. Allowlist JSON with 11 required fields for exceptions. Policy doc: `../security/license-policy.md` |
| 5.3 | Strongly Recommended | Incident response runbook | Not started | Escalation, patching, and user-notification flow for vulnerabilities |
| 5.4 | Recommended | SOC 2 / ISMAP certification | Not started | Long-term goal; ISMAP is especially relevant for Japan market |

---

## 6. Completed Areas

Areas already considered at production level.

- Crypto design: PBKDF2 600k + HKDF domain separation + AAD binding
- Type safety: `any` count 0, `as any` count 1, `@ts-ignore` count 0, `strict: true`
- Test ratio: app ~50k LOC vs tests ~30k LOC (295 files / 2,575 tests)
- Security review: all 7 sections PASS in `../security/security-review.md` (Section 7: tenant RLS added 2026-02-27)
- CSP + nonce enforcement + violation reporting
- Rate limiting (Redis + in-memory fallback)
- i18n (en/ja 884-key parity, APP_NAME env support)
- Terraform IaC (1,315 LOC)
- Docker multi-stage build + non-root runtime
- Browser-extension token lifecycle controls
- Input validation (486 LOC Zod schemas, 40 API touchpoints)
- Audit logs (personal + team, filter/export supported)
- External audit-log forwarding (pino + Fluent Bit sidecar)
- Environment validation (26 vars, startup-time schema check)
- CI/CD pipeline (4 parallel GitHub Actions jobs, ESLint + Vitest + Next.js build + RLS guard scripts)
- Structured app logging (pino + withRequestLog + CSP-report sanitization)
- Health checks (`/api/health/live` liveness + `/api/health/ready` readiness, DB/Redis checks, timeout protection)
- Monitoring/alerting (CloudWatch metric filters + alarms + ECS stop EventBridge + SNS)
- Backup/recovery (AWS Backup Vault Lock WORM + S3 Object Lock Compliance + cross-region copy + EventBridge failure notify)
- Passphrase recovery flow (recovery key: Base32 + HKDF + AES-256-GCM wrap + Vault Reset)
- Component test foundation (`@testing-library/react` + `jsdom`, signin/header/auto-extension-connect)
- E2E tests (Playwright 7 specs / 22 cases, 16 crypto compatibility tests, dual DB guards + scoped cleanup)
- Migration strategy separation (ECS one-off RunTask + deploy.sh sequencing + docker-compose profiles split)
- DB connection pool tuning (env tuning + maxLifetimeSeconds + graceful shutdown + RDS connection alarm)
- Load testing (k6 6 scenarios, triple-guard seed script, initial SLOs, threshold pass/fail)
- Dependency license audit (allowlist JSON 17 entries, strict CI enforcement, expiry checks, policy docs)
- Multi-tenant isolation (FORCE RLS on 28 tables, `withBypassRls` CI allowlist guard, nested auth CI guard)
- SCIM 2.0 provisioning (Users + Groups, tenant-scoped tokens, RFC 7644)
- Production code `console.log`: 0, `TODO/FIXME`: 0

---

## Recommended Execution Order (Remaining Required Items)

Required items completed: 8/9. Remaining:

1. **5.1** Privacy policy / terms — legal requirement before release

---

## OSS-Oriented Priority (Near Term)

Assuming OSS-first public operation, the following are out of immediate scope:

- `5.1` Privacy policy / terms of service
- `2.7` External third-party security audit
- `5.4` SOC 2 / ISMAP certifications

### P1 (Immediate)

1. `5.3` Incident response runbook
2. `2.4` Explicit CORS policy
3. `3.3` Migration strategy separation
4. `3.2` DB connection pool tuning
5. `4.3` Load testing

### P2 (Next Phase)

1. ~~`5.2` Dependency license audit~~ ✅
2. `4.4` Automated security scanning
3. `2.5` Concurrent session management
4. `1.6` Error tracking
5. `4.2` Coverage expansion

### P3 (Mid/Long Term)

1. `3.4` Redis high availability
2. `2.6` Additional documentation on key-material memory handling
