# Incident Response Runbook

This document provides step-by-step procedures for responding to security
incidents and service degradation in the passwd-sso application.

---

## 1. Key Compromise Response

### 1a. Master Key Compromise

The share-link master key (`SHARE_MASTER_KEY_V<N>`) is used to encrypt ShareLink and Send blobs. It does **not** encrypt vault data — vault keys are client-derived (PBKDF2 + HKDF in the browser) and are never accessible to the server.

`POST /api/admin/rotate-master-key` re-encrypts existing share blobs from the old key version to the new key version. It does NOT affect vault entries.

**Procedure:**

1. Generate a new key version: `npm run generate:key`
2. Add to production environment: `SHARE_MASTER_KEY_V<N>=<hex64>` and set `SHARE_MASTER_KEY_CURRENT_VERSION=<N>`
3. Restart the application to load the new environment variables
4. Mint an `op_*` operator token (see [admin-tokens.md](admin-tokens.md))
5. Run the rotation script:
   ```bash
   ADMIN_API_TOKEN=op_<43-char base64url> \
   TARGET_VERSION=<N> \
   APP_URL=https://your-app-url \
   scripts/rotate-master-key.sh
   ```
6. Optionally revoke all share links encrypted under the compromised key version by setting `REVOKE_SHARES=true`

**Vault data exposure:** If you suspect vault data has been accessed, the server master key is not relevant — vault keys are client-derived. The correct response is to advise affected users to change their vault passphrase (which rotates their local secret key). Administrators can trigger a vault reset via the tenant admin UI if a user account is fully compromised.

### 1b. User Passphrase Compromise

A single user's passphrase has been leaked.

1. The user changes their passphrase via the vault settings UI
2. This triggers vault key rotation (re-encrypt secret key with new wrapping key)
3. All existing sessions for the user are invalidated
4. No action required from administrators

### 1c. Team Key Compromise

A team's encryption key may have been exposed.

1. Team admin rotates the team key via `POST /api/teams/[teamId]/rotate-key`
2. All team members receive new `TeamMemberKey` records
3. Team passwords are re-encrypted with the new team key
4. Review team membership for unauthorized members

### 1d. Database Encryption Key (PostgreSQL)

PostgreSQL-level encryption at rest is compromised.

1. Take the database offline
2. Export data: `pg_dump -Fc passwd_sso > backup.dump`
3. Create a new encrypted database instance
4. Restore: `pg_restore -d passwd_sso backup.dump`
5. Update `DATABASE_URL` and redeploy

---

## 2. Database Breach Procedure

### 2a. Assess Scope

Determine which tables/data were exposed:

| Table | Risk | Action |
|-------|------|--------|
| `users` | Passphrase verifiers are HMAC'd, not plaintext | Force all users to change passphrases |
| `sessions` | Active session tokens exposed | Delete all sessions (mass logout): `DELETE FROM sessions;` |
| `audit_logs` | Metadata may contain PII (IPs, emails) | Notify affected users |
| `password_entries` | Encrypted with AES-256-GCM | Safe without secret keys — no action needed |
| `team_member_keys` | Encrypted team keys per member | Safe without user secret keys |
| `extension_tokens` | Token hashes (SHA-256, 256-bit entropy tokens) | Revoke all tokens: `UPDATE extension_tokens SET revoked_at = NOW();` |
| `api_keys` | Token hashes (SHA-256, 256-bit entropy tokens) | Revoke all API keys: `UPDATE api_keys SET revoked_at = NOW();` |
| `service_account_tokens` | Token hashes (SHA-256, 256-bit entropy tokens) | Revoke all SA tokens: `UPDATE service_account_tokens SET revoked_at = NOW();` |
| `mcp_access_tokens` | Token hashes; short-lived but may be valid | Revoke all MCP tokens: `UPDATE mcp_access_tokens SET revoked_at = NOW(); UPDATE mcp_refresh_tokens SET revoked_at = NOW();` |
| `operator_tokens` | Token hashes; grant access to admin maintenance routes | Revoke all operator tokens: `UPDATE operator_tokens SET revoked_at = NOW();` — then re-mint via UI |
| `scim_tokens` | Token hashes; grant SCIM provisioning access | Revoke all SCIM tokens: `UPDATE scim_tokens SET revoked_at = NOW();` |
| `webauthn_credentials` | Public keys; no plaintext secrets | If private key exposure is suspected (device compromise), delete credentials: `DELETE FROM webauthn_credentials;` — users re-register on next login |

### 2b. Immediate Actions

1. Revoke all sessions: `DELETE FROM sessions;`
2. Revoke all extension tokens: `UPDATE extension_tokens SET revoked_at = NOW();`
3. Revoke all API keys: `UPDATE api_keys SET revoked_at = NOW();`
4. Force password change on next login (set `vault_setup_at = NULL` if needed)
5. Rotate `AUTH_SECRET` and `VERIFIER_PEPPER_KEY` environment variables
6. Redeploy the application

### 2c. Post-Incident

1. Review audit logs for unauthorized access patterns
2. Notify affected users within 72 hours (GDPR requirement)
3. File incident report with relevant authorities if applicable

---

## 3. Service Degradation Escalation

### 3a. Redis Down

**Impact:** Session validation falls back to direct database lookups (higher PostgreSQL load). Revocation tombstones no longer propagate across app nodes — increasing the window during which a revoked session may still be honored on other nodes. Rate limiting also degrades to in-process state, which can be exploited in a distributed deployment. This is a security-relevant incident in multi-node environments.

**Actions (standalone Redis):**
1. Check Redis health: `redis-cli ping`
2. If container issue: `docker restart redis`
3. If persistent and multi-node: consider taking nodes out of the load balancer rotation until Redis is restored, to prevent session-revocation propagation failures
4. Monitor database load — may need to scale

**Actions (Sentinel HA):**
1. Check Sentinel status: `redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster`
2. If master is down, verify automatic failover occurred (new master elected)
3. If failover did not trigger, force manual failover: `redis-cli -p 26379 SENTINEL failover mymaster`
4. Verify application reconnected: `curl -s /api/health/ready | jq .checks.redis`
5. Restart failed node — it will rejoin as replica automatically

See [Redis HA documentation](redis-ha.md) for full topology and failover test procedure.

### 3b. PostgreSQL Down

**Impact:** Full application outage. No data access possible.

**Actions:**
1. Check database status and logs
2. If container issue: `docker restart db`
3. If data corruption: restore from latest backup
4. Verify data integrity after restoration
5. Check replication status if using replicas

### 3c. Jackson (SAML) Down

**Impact:** SAML SSO login fails. Google OIDC, passkey, and magic link
continue working.

**Actions:**
1. Check Jackson container: `docker logs jackson`
2. Restart: `docker restart jackson`
3. If persistent: check Jackson configuration and database connection
4. Communicate to SSO users that alternative login methods are available

### 3d. Application Down

**Impact:** Full frontend/API outage.

**Actions:**
1. Check application logs for errors
2. Redeploy from latest stable image
3. If build issue: roll back to previous deployment
4. Check resource limits (memory, CPU)

### 3e. Audit Outbox Worker Down

**Impact:** Audit events accumulate in the `audit_outbox` table with status `PENDING`. Vault, password, and authentication operations continue normally — the web application is unaffected. However, audit events do not appear in `audit_logs` and are not forwarded to SIEM or delivery targets until the worker is restarted.

**Detect:**
```bash
# Check pending row count (requires op_* token)
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
  "$APP_URL/api/maintenance/audit-outbox-metrics"
```
A large or growing `pendingCount` with an old `oldestPendingAge` indicates the worker is not draining.

**Actions:**
1. Check worker logs: `docker logs audit-outbox-worker` (or equivalent for your deployment)
2. Restart the worker: `docker restart audit-outbox-worker` or `npm run worker:audit-outbox`
3. Verify the worker resumes draining: re-check `/api/maintenance/audit-outbox-metrics` — `pendingCount` should decrease
4. If rows are stuck in `FAILED` state, purge them after investigation:
   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"olderThanDays":1}' \
     "$APP_URL/api/maintenance/audit-outbox-purge-failed"
   ```

---

## 4. Communication Templates

### 4a. Internal Incident Notification

```
Subject: [SEVERITY] Security Incident — [Brief Description]

Incident ID: INC-YYYY-MM-DD-NNN
Severity: Critical / High / Medium / Low
Status: Investigating / Mitigating / Resolved
Detected: [timestamp]
Affected systems: [list]

Summary: [1-2 sentences]

Current actions:
- [action 1]
- [action 2]

Next update: [time]
Incident commander: [name]
```

### 4b. User Notification (Data Breach)

```
Subject: Important Security Notice — Action Required

Dear [User],

We are writing to inform you of a security incident that may have affected
your account on [date].

What happened: [brief, non-technical description]

What data was involved: [specific data types]

What we have done:
- [action 1]
- [action 2]

What you should do:
1. Change your passphrase at your earliest convenience
2. Review your vault for any unauthorized changes
3. If you use the same passphrase elsewhere, change it there too

We take the security of your data seriously and have implemented additional
measures to prevent similar incidents.

Contact: [security email]
```

### 4c. Status Page Update

```
[TIMESTAMP] - Investigating
We are investigating reports of [issue description].

[TIMESTAMP] - Identified
The issue has been identified as [root cause]. We are working on a fix.

[TIMESTAMP] - Monitoring
A fix has been deployed. We are monitoring the situation.

[TIMESTAMP] - Resolved
The issue has been resolved. [Brief summary of impact and duration].
```
