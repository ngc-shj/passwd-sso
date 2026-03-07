# Incident Response Runbook

This document provides step-by-step procedures for responding to security
incidents and service degradation in the passwd-sso application.

---

## 1. Key Compromise Response

### 1a. Master Key Compromise

The master key (`SHARE_MASTER_KEY`) is used for server-side encryption.

1. Generate a new key: `npm run generate:key`
2. Update the `SHARE_MASTER_KEY` environment variable in production
3. Redeploy the application
4. If vault data integrity is compromised, trigger admin mass vault reset
   via `POST /api/admin/rotate-master-key`
5. Notify all affected users to re-setup their vaults

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
| `sessions` | Active session tokens exposed | Delete all sessions (mass logout) |
| `audit_logs` | Metadata may contain PII (IPs, emails) | Notify affected users |
| `password_entries` | Encrypted with AES-256-GCM | Safe without secret keys — no action needed |
| `team_member_keys` | Encrypted team keys per member | Safe without user secret keys |
| `extension_tokens` | Token hashes (bcrypt) | Revoke all tokens as precaution |
| `api_keys` | Token hashes (bcrypt) | Revoke all API keys as precaution |

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

**Impact:** Rate limiting and session caching degrade. Auth.js falls back to
database sessions automatically.

**Actions:**
1. Check Redis health: `redis-cli ping`
2. If container issue: `docker restart redis`
3. If persistent: switch to database-only mode (remove `REDIS_URL`)
4. Monitor database load — may need to scale

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
