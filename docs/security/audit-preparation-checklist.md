# External Security Audit Preparation Checklist

## Scope Definition

- [ ] Web application (Next.js App Router)
- [ ] REST API (`/api/v1/*` and internal `/api/*`)
- [ ] Authentication flow (Google OIDC, SAML 2.0, Passkey, Magic Link)
- [ ] E2E encryption implementation (client-side AES-256-GCM, PBKDF2/Argon2id KDF)
- [ ] Browser extension (Chrome/Firefox)
- [ ] Docker container security
- [ ] Database schema and access control (RLS)

## Required Documentation

- [ ] Architecture overview (CLAUDE.md, README)
- [ ] Cryptography design (`docs/security/crypto-domain-ledger.md`)
- [ ] Key retention policy (`docs/security/key-retention-policy.md`)
- [ ] Threat model (STRIDE-based, if published)
- [ ] API endpoint inventory (OpenAPI spec at `/api/v1/openapi.json`)
- [ ] Dependency list (`package.json`, `package-lock.json`)

## Access Provisioning

- [ ] Read-only access to source repository
- [ ] Test environment with seeded data (no production data)
- [ ] Test accounts with various roles (OWNER, ADMIN, MEMBER)
- [ ] Docker Compose setup instructions for local deployment
- [ ] Environment variable documentation (`.env.example`)

## Pre-Audit Self-Assessment

- [ ] All known vulnerabilities from internal review are documented
- [ ] `npm audit` shows no high/critical findings
- [ ] SAST scan (Semgrep) results reviewed
- [ ] Container image scan (Trivy) results reviewed
- [ ] Rate limiting configured on all sensitive endpoints
- [ ] Session management reviewed (concurrent limits, eviction)
- [ ] Input validation on all API endpoints (Zod schemas)

## Engagement Types

| Type | Scope | Duration | Cost Range |
| --- | --- | --- | --- |
| Code review | Source code analysis | 2-4 weeks | $$$ |
| Penetration test | Black/grey box testing | 1-2 weeks | $$ |
| Crypto review | Encryption implementation | 1-2 weeks | $$$$ |
| Full audit | All of the above | 4-8 weeks | $$$$$ |

## Post-Audit

- [ ] Receive findings report
- [ ] Triage and prioritize findings
- [ ] Fix critical/high findings before public disclosure
- [ ] Publish audit summary (optional)
- [ ] Schedule re-test for fixed findings
