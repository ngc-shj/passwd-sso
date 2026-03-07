# External Security Assessment — Prioritized Roadmap

Based on: [external-security-assessment.md](external-security-assessment.md)

---

## Priority Matrix

| # | Item | Security Impact | Effort | Dependencies | Priority |
|---|------|-----------------|--------|--------------|----------|
| 1 | C: KDF metadata persistence | High (blocks future migration) | Low | None | P0 |
| 2 | G: Crypto domain separation ledger | Medium (prevents future mistakes) | Low | None | P0 |
| 3 | F: Key retention/deletion policy | Medium (operational clarity) | Low | None | P0 |
| 4 | B: Revoke + session/token kill | High (privilege persistence) | Medium | None | P1 |
| 5 | Ops: Security scanning (SAST, container) | Medium (CI hardening) | Low | None | P1 |
| 6 | Ops: npm audit blocking | Low-Medium | Trivial | None | P1 |
| 7 | Ops: Incident runbook | Medium (operational readiness) | Low | None | P1 |
| 8 | A: Attachment key hierarchy (ItemKey) | High (rotation reliability) | High | Schema migration | P2 |
| 9 | Ops: Error tracking (Sentry) | Medium (observability) | Medium | None | P2 |
| 10 | D: Argon2id migration path | Medium (KDF hardening) | Medium | Depends on #1 (C) | P2 |
| 11 | Trust: Threat model publication | Medium (trust building) | Medium | None | P2 |
| 12 | Trust: Cryptography whitepaper | Medium (trust building) | Medium | Depends on #2 (G) | P2 |
| 13 | E: History lazy re-encryption | Low (Bitwarden skips this too) | Medium | None | P3 |
| 14 | Ops: Redis HA | Low-Medium | High | Infra change | P3 |
| 15 | Ops: Concurrent session management | Low-Medium | Medium | None | P3 |
| 16 | Trust: External security audit | High (trust) | High (cost) | #1-#8 done first | P3 |
| 17 | Trust: Bug bounty program | Medium (trust) | Medium (ongoing) | #16 first | P3 |
| 18 | Trust: Reproducible builds | Low-Medium | Medium | Extension stable | P3 |

---

## Phase Plan

### Phase 0 — Documentation + Foundation (1-2 days)

Low-effort, high-leverage items that establish the groundwork.

**#1 — C: KDF Metadata Persistence**

Add `kdfType`, `kdfIterations`, `kdfMemory`, `kdfParallelism` to User/Vault schema.
All clients read params from server instead of hardcoded constants.
No crypto changes — just data model preparation.

**#2 — G: Crypto Domain Separation Ledger**

Create `docs/security/crypto-domain-ledger.md` documenting all HKDF `info` strings,
AAD scopes, and their purpose. Verify against actual code. This becomes the
reference for all future crypto feature additions.

**#3 — F: Key Retention/Deletion Policy**

Create `docs/security/key-retention-policy.md` defining:
- Old TeamMemberKey retention period
- History decryption minimum key lifetime
- Revoked member key cleanup rules
- Backup key metadata handling

---

### Phase 1 — Security Hardening (3-5 days)

Active security improvements with moderate effort.

**#4 — B: Revoke + Session/Token Kill**

Audit and enforce that member removal triggers:
- Database session deletion for the user
- Extension token invalidation
- API key scope check
- Mandatory team key rotation prompt

**#5 — Ops: Security Scanning**

- Add SAST tool (e.g., Semgrep) to CI
- Add container image scanning (e.g., Trivy)
- Make `npm audit` blocking for high/critical

**#6 — Ops: npm audit blocking**

Change CI to fail on high/critical vulnerabilities.

**#7 — Ops: Incident Runbook**

Create `docs/operations/incident-runbook.md` covering:
- Key compromise response
- Database breach procedure
- Service degradation escalation
- Communication templates

---

### Phase 2 — Architecture Evolution (1-2 weeks)

Larger changes requiring schema migration and cross-client updates.

**#8 — A: Attachment Key Hierarchy**

Introduce per-entry `ItemKey` wrapped by TeamKey:
- Schema: add `encryptedItemKey`, `itemKeyIv`, `itemKeyAuthTag` to TeamPasswordEntry
- Rotation rewraps ItemKey only (attachments untouched)
- Migration: backfill ItemKey for existing entries
- Client: decrypt ItemKey -> decrypt entry/attachment

**#9 — Ops: Error Tracking**

Integrate Sentry or equivalent. Instrument API routes and client-side errors.

**#10 — D: Argon2id Migration Path**

Requires #1 (KDF metadata) to be complete.
- Add WASM Argon2id to web/extension builds
- New user default: Argon2id
- Existing users: migrate on next passphrase entry
- CLI: native Argon2id via Node.js binding

**#11-12 — Trust: Threat Model + Whitepaper**

Publish threat model (STRIDE) and cryptography whitepaper.
Requires #2 (domain ledger) as source material.

---

### Phase 3 — Maturation (ongoing)

Long-term improvements, post-stabilization.

**#13 — E: History Lazy Re-encryption**

On history access: decrypt with old key, re-encrypt with current key, update record.
Allows eventual cleanup of old TeamMemberKey versions.

**#14 — Ops: Redis HA**

Redis Sentinel or Cluster for session/rate-limiting resilience.

**#15 — Ops: Concurrent Session Management**

Session listing, forced logout, max session limits.

**#16-18 — Trust: External Audit, Bug Bounty, Reproducible Builds**

These require items #1-#8 to be complete first.
External audit is the single highest-impact trust signal but also the most expensive.
Sequence: audit -> fix findings -> bug bounty -> reproducible builds.

---

## Decision Log

| Decision | Rationale |
|---|---|
| KDF metadata before Argon2id | Migration infrastructure must exist before changing the algorithm |
| Documentation items at P0 | Zero-risk, high-leverage, prevents future mistakes |
| Attachment key hierarchy at P2 | High impact but requires careful schema migration planning |
| External audit at P3 | Maximum value after fixing known gaps (#1-#8) |
| History re-encryption at P3 | Bitwarden doesn't do this either; old key retention is acceptable |
