# Load Testing (k6)

A load testing suite using k6. Measures API throughput, latency, and error rates across 6 scenarios.

## Prerequisites

- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed
- PostgreSQL + Redis running
- App running at `http://localhost:3000`
- `SHARE_MASTER_KEY` (or `VERIFIER_PEPPER_KEY`) configured

## Quick Start

```bash
# 1. Seed test users into DB (50 users, takes a few minutes due to PBKDF2)
#    Add ALLOW_NON_TEST_DBNAME=true if dev DB name doesn't contain test/loadtest/ci
ALLOW_LOAD_TEST_SEED=true \
ALLOW_NON_TEST_DBNAME=true \
DATABASE_URL=postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso \
npm run test:load:seed

# 2. Run load test
k6 run load-test/scenarios/mixed-workload.js

# 3. Clean up test data
ALLOW_LOAD_TEST_SEED=true \
ALLOW_NON_TEST_DBNAME=true \
DATABASE_URL=postgresql://passwd_user:passwd_pass@localhost:5432/passwd_sso \
npm run test:load:cleanup
```

## npm Scripts

| Command | Description |
|---------|-------------|
| `npm run test:load:seed` | Seed test users |
| `npm run test:load:cleanup` | Remove test data |
| `npm run test:load:smoke` | Smoke test (guard validation + 1-user seed + API check + cleanup) |
| `npm run test:load` | Run mixed workload scenario |
| `npm run test:load:health` | Run health scenario |

## Scenarios

| Scenario | Endpoint | Executor | Load |
|----------|----------|----------|------|
| `health.js` | GET /api/health/ready | constant-arrival-rate | 50 rps, 30s |
| `vault-unlock.js` | POST /api/vault/unlock | ramping-vus | 1->20->0, 50s |
| `passwords-list.js` | GET /api/passwords | constant-arrival-rate | 30 rps, 30s |
| `passwords-create.js` | POST /api/passwords | ramping-vus | 1->10->0, 40s |
| `passwords-generate.js` | POST /api/passwords/generate | constant-arrival-rate | 50 rps, 30s |
| `mixed-workload.js` | All of the above | ramping-vus | 1->20->0, 90s |

## Initial SLO Targets

| Endpoint | p95 | p99 | Error Rate |
|----------|-----|-----|------------|
| GET /api/health/ready | < 200ms | < 500ms | < 0.1% |
| POST /api/vault/unlock | < 500ms | < 1000ms | < 1% |
| GET /api/passwords | < 300ms | < 800ms | < 0.1% |
| POST /api/passwords | < 500ms | < 1000ms | < 0.5% |
| POST /api/passwords/generate | < 100ms | < 300ms | < 0.1% |
| Mixed workload | < 500ms | < 1500ms | < 0.5% |

When k6 `thresholds` are breached, the process exits with **exit code 99**. This can be used for pass/fail determination in scripts and CI.

## Baseline Benchmark (2026-02-17)

### Environment

| Item | Value |
|------|-------|
| CPU | Apple M3 Pro |
| RAM | 18 GB |
| OS | macOS 26.2 (Darwin 25.2.0) |
| Node.js | v25.2.1 |
| PostgreSQL | 16.11 (Docker) |
| k6 | v1.6.1 (go1.26.0, darwin/arm64) |
| App | Next.js 16 dev server (Turbopack, build cache warm) |
| Seeded Users | 50 |

### Results by Scenario

| Scenario | Load | p95 | p99 | Error Rate | SLO |
|----------|------|-----|-----|------------|-----|
| health | 50 rps x 30s | 13.86 ms | 40.19 ms | 0.00% | PASS |
| vault-unlock | 1->20->0 VU, 50s | 129 ms | 142 ms | 0.00% | PASS |
| passwords-list | 30 rps x 30s | 31.84 ms | 115 ms | 0.00% | PASS |
| passwords-create | 1->10->0 VU, 40s | 102 ms | 123 ms | 0.00% | PASS |
| passwords-generate | 50 rps x 30s | 30 ms | 255 ms | 0.00% | PASS |
| mixed-workload | 1->20->0 VU, 90s | 52 ms | -- | 0.00% | PASS |

All scenarios cleared SLO thresholds with comfortable margins.

> **Note**: These are measurements from a local dev server and do not guarantee production performance. Use as a baseline for regression detection within the same environment.

## Safety Guards

The seed script uses a triple guard to prevent accidental connections to production databases:

1. **URL parsing**: hostname must be one of `localhost`, `127.0.0.1`, `::1`, or `db`, and the dbname must contain `test`, `loadtest`, or `ci`
   - Prevents cases where a production DB appears as localhost via SSH tunnel / SSM port-forward
   - For dev DB names like `passwd_sso`, explicitly opt in with `ALLOW_NON_TEST_DBNAME=true`
2. **NODE_ENV**: Rejected if set to `production`
3. **Explicit flag**: `ALLOW_LOAD_TEST_SEED=true` is required

> **Note**: The hostname `db` is for docker-compose internal networks only. Do not use in external environments.

## Authentication

- Auth.js v5 database session strategy (raw token)
- Session tokens are directly INSERTed into the DB (same pattern as E2E tests)
- k6 sends requests with the `authjs.session-token` cookie
- For HTTPS environments, set `COOKIE_NAME=__Secure-authjs.session-token`

## Baseline Management

```bash
# Save baseline (environment-prefixed)
k6 run load-test/scenarios/mixed-workload.js \
  --out json=load-test/baselines/local-$(date +%F).json

# Staging environment
BASE_URL=https://staging.example.com k6 run load-test/scenarios/mixed-workload.js \
  --out json=load-test/baselines/staging-$(date +%F).json
```

**Important**: Local measurements are reference values for production SLOs and should not be directly compared. Use comparisons for detecting regressions over time within the same environment.

## Auth Artifact Handling

- `.load-test-auth.json` is local-only and must not be shared
- `chmod 600` is applied automatically
- Delete after use with `npm run test:load:cleanup`
- Listed in `.gitignore`

## Troubleshooting

### Session Auth Errors (401)

```bash
# Check cookie name
COOKIE_NAME=__Secure-authjs.session-token npm run test:load:seed
```

### Rate Limiting (429)

vault-unlock has a rate limit of 5 requests per 5 minutes. Distributed across 50 users + `sleep(1)` to avoid hitting limits. To increase users:

```bash
ALLOW_LOAD_TEST_SEED=true DATABASE_URL=... \
  node load-test/setup/seed-load-test-users.mjs --users 100
```

### Manual Cleanup

If the cleanup command fails:

```sql
DELETE FROM password_entries WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local');
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local');
DELETE FROM vault_keys WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local');
DELETE FROM users WHERE email LIKE 'lt-user-%@loadtest.local';
```

### k6 Not Installed

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | \
  sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```
