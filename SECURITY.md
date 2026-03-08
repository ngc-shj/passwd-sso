# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in passwd-sso, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **[github.com@jpng.jp](mailto:github.com@jpng.jp)**

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

| Action | Timeline |
| --- | --- |
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix development | Depends on severity |
| Public disclosure | After fix is released |

## Scope

### In Scope

- Web application (Next.js) and browser extension
- API endpoints (`/api/*`)
- Authentication and session management
- E2E encryption implementation (client-side crypto)
- Docker container configuration

### Out of Scope

- Social engineering attacks
- Denial of service attacks
- Third-party services (Google OIDC, BoxyHQ Jackson)
- Issues in upstream dependencies (report to the respective project)

## Safe Harbor

We support safe harbor for security researchers who:

- Make a good faith effort to avoid privacy violations, data destruction, and service disruption
- Only interact with accounts you own or with explicit permission
- Do not exploit a vulnerability beyond what is necessary to confirm it
- Report vulnerabilities promptly

We will not pursue legal action against researchers who follow these guidelines.

## Security Model

passwd-sso uses a **zero-knowledge** architecture:

- All password data is encrypted **client-side** using AES-256-GCM before being sent to the server
- The server stores only ciphertext and cannot decrypt user data
- Key derivation: Master passphrase → PBKDF2 (600k iterations) → HKDF → AES-256-GCM key
- An additional **Secret Key** (account salt) provides defense against server-side compromise
- Database sessions (not JWT) with 8-hour timeout
- Vault auto-locks after 15 minutes idle or 5 minutes tab hidden
- Clipboard auto-clears after 30 seconds

## Supported Versions

| Version | Supported |
|---|---|
| latest (main branch) | Yes |

## Best Practices for Deployment

- Always use HTTPS in production
- Do **not** expose PostgreSQL (port 5432) or SAML Jackson (port 5225) to the public internet
- Use strong, unique values for `AUTH_SECRET` and database credentials
- Keep Docker images up to date
- Restrict Google sign-in to your Workspace domain via `GOOGLE_WORKSPACE_DOMAIN`
