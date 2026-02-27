# Feature Comparison with Major Apps

This document summarizes a **high-level feature comparison** of **passwd-sso** and major password managers (1Password / Bitwarden).
Because competitor capabilities vary by plan and deployment model, always verify details in official vendor documentation.

## Legend

| Symbol | Meaning |
|---|---|
| Done | Implemented in passwd-sso |
| --- | Not implemented |
| Yes | Supported |
| No | Not supported |
| Varies | Depends on plan / configuration |

## 1. Authentication & SSO

| Feature | passwd-sso | 1Password | Bitwarden | Notes |
|---|---|---|---|---|
| Master password / passphrase | Done | Yes | Yes | |
| Google OAuth 2.0 | Done | No | No | Workspace domain restriction supported |
| SAML 2.0 SSO | Done | Yes | Yes | Via BoxyHQ SAML Jackson |
| Passkey / WebAuthn | --- | Yes | Yes | |
| MFA / 2FA (at login) | --- | Yes | Yes | |

## 2. Vault & Encryption

| Feature | passwd-sso | 1Password | Bitwarden | Notes |
|---|---|---|---|---|
| E2E encryption | Done | Yes | Yes | Personal vault is E2E |
| Server-side encryption (team) | Done | Yes | Yes | For sharing use cases |
| Auto-lock | Done | Yes | Yes | 15 min idle / 5 min hidden tab |
| Key rotation | --- (prepared) | Yes | No | |
| Multiple vaults | --- | Yes | Yes | |
| Travel Mode | --- | Yes | No | |

## 3. Entries & Attachments

| Feature | passwd-sso | 1Password | Bitwarden | Notes |
|---|---|---|---|---|
| Password / note / card / identity | Done | Yes | Yes | |
| TOTP storage | Done | Yes | Yes | |
| File attachments | Done | Yes | Yes | |
| SSH keys | --- | Yes | No | |
| Boolean custom field | --- | No | Yes | |

## 4. Sharing & Team

| Feature | passwd-sso | 1Password | Bitwarden | Notes |
|---|---|---|---|---|
| Expiring link sharing | Done | Yes | No | Access logs + rate limiting |
| Team / team vault | Done | Yes | Yes | RBAC |
| Emergency Access | Done | Yes | No | |

## 5. Audit / Monitoring

| Feature | passwd-sso | 1Password | Bitwarden | Notes |
|---|---|---|---|---|
| Audit logs (personal + team) | Done | Yes | Yes | |
| Breach/weak/reuse checks | Done | Yes | Yes | |

## 6. Import / Export

| Feature | passwd-sso | 1Password | Bitwarden | Notes |
|---|---|---|---|---|
| CSV / JSON export | Done | Yes | Yes | |
| Password-protected export | Done | No | Yes | AES-256-GCM + PBKDF2 |
| Major CSV imports | Done | Yes | Yes | BW/1P/Chrome |

## 7. Client Platforms

| Feature | passwd-sso | 1Password | Bitwarden | Notes |
|---|---|---|---|---|
| Web UI | Done | Yes | Yes | |
| Browser extension | Done | Yes | Yes | Chrome MV3 |
| Desktop app | --- | Yes | Yes | |
| Mobile app | --- | Yes | Yes | |

## 8. Operations / Self-hosting

| Feature | passwd-sso | 1Password | Bitwarden | Notes |
|---|---|---|---|---|
| Self-hosted | Done | No | Yes | Docker/Terraform |
| API / integration | Done | Varies | Yes | Webhook/SCIM not yet implemented |

---

*Last updated: 2026-02-14*
