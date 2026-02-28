# Feature Gap Analysis Report

Last updated: 2026-02-28

## Purpose

Compare passwd-sso with major password managers (1Password, Bitwarden, LastPass, Dashlane, KeePassXC, Proton Pass, NordPass) and identify missing capabilities.

## Products in Scope

| Product | Characteristics |
| --- | --- |
| 1Password | 22+ entry types, SSH Agent, Travel Mode, Secrets Automation |
| Bitwarden | OSS, Send (temporary sharing), Secrets Manager, self-hosted support |
| LastPass | Dark-web monitoring, SaaS monitoring, 15+ secure note templates |
| Dashlane | Built-in VPN, Confidential SSO, phishing detection |
| KeePassXC | Fully local, Auto-Type, SSH Agent, Secret Service API |
| Proton Pass | Email aliases, Pass Monitor, Swiss jurisdiction |
| NordPass | XChaCha20, email masking, offline mode |

---

## 1. Implemented Capabilities in passwd-sso

### Encryption / Security

- E2E encryption (PBKDF2 600k -> HKDF -> AES-256-GCM)
- Team vault E2E encryption (ECDH-P256 key distribution)
- Multi-tenant isolation (FORCE ROW LEVEL SECURITY on 28 tables)
- Auto-lock (15 min idle / 5 min hidden tab)
- Concurrent session management (list/revoke, device detection, rate limited)
- Account lockout (progressive: 5 -> 15 min, 10 -> 1h, 15 -> 24h)
- Rate limiting (Redis + in-memory fallback)
- CSP + nonce + security headers (HSTS, X-Frame-Options, etc.)
- Passphrase verifier (HMAC-based)
- Clipboard auto-clear (30 sec, Web UI)
- Master-password reprompt (`requireReprompt`) for view/copy/edit

### Vault Management

- 7 entry types (LOGIN, SECURE_NOTE, CREDIT_CARD, IDENTITY, PASSKEY, BANK_ACCOUNT, SOFTWARE_LICENSE)
- Favorites / archive / trash (30-day auto purge)
- Bulk operations (archive / trash / restore / permanent delete)
- Tags (with color, user-scope unique constraint)
- Custom fields (TEXT, HIDDEN, URL, BOOLEAN, DATE, MONTH_YEAR)
- File attachments (10 MB, max 20 per entry, E2E encrypted)
- Folders / hierarchical grouping (personal + team, max depth 5, cycle detection)
- Entry history (max 20 snapshots per entry, 90-day purge, restore support)
- Duplicate entry detection (Watchtower, host + username match)
- Entry expiration (`expiresAt`, Watchtower expiry checks)

### Password Generation / Analysis

- Random passwords (8-128 chars, 6 symbol groups)
- Passphrases (3-10 words, BIP39 word list)
- Watchtower (HIBP k-Anonymity, weak/reused/old/HTTP/duplicate/expired detection)
- Entropy scoring and pattern detection (keyboard runs, sequences, etc.)

### Sharing / Collaboration

- Share links (expiry / max views / revoke / access logs)
- Send (Bitwarden-like temporary text/file sharing)
- Team vault (RBAC: OWNER, ADMIN, MEMBER, VIEWER)
- Invitation flow (token + expiry)
- Team-scoped tags, favorites, and folders
- SCIM 2.0 provisioning (Users + Groups, tenant-scoped tokens)

### Emergency Access

- ECDH-P256 key exchange + ML-KEM hybrid (PQC-ready)
- 8-step state machine (PENDING -> ACTIVATED)
- Waiting periods (7/14/30 days)
- Email notifications across all 6 EA workflows (invite, accept, decline, request, approve, revoke)

### Recovery

- Recovery key (256-bit, Base32, HKDF + AES-256-GCM)
- Vault reset (full deletion, last resort)
- Passphrase change / key rotation (API prepared)

### Notifications

- Email notification infrastructure (Resend + SMTP dual-provider, bilingual templates)
- Emergency-access email notifications (6 types across all EA workflows)

### Other

- Browser extension (Chrome MV3, form detection, manual/auto fill, TOTP autofill)
- i18n (ja/en, 884 keys)
- Audit logs (34 actions, personal + team)
- Import/export (CSV, JSON, password-protected encrypted export)
- Dark mode / keyboard shortcuts
- Health checks / structured logs / Terraform IaC

---

## 2. Feature Gap List

### 2.1 Security

| # | Feature | 1P | BW | LP | DL | KP | PP | NP | Impact | Implementation Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ~~S-1~~ | ~~Clipboard auto-clear~~ | Yes | Yes | Yes | Yes | Yes | Yes | Yes | — | — |
| ~~S-2~~ | ~~Master-password reprompt (sensitive actions)~~ | - | Yes | - | - | - | Yes | - | — | — |
| ~~S-3~~ | ~~FIDO2 / WebAuthn (login 2FA)~~ | Yes | Yes | Yes | Yes | - | Yes | Yes | — | — |
| S-4 | Passkey-based vault unlock | - | Yes | - | - | - | - | - | Medium | High |
| ~~S-5~~ | ~~Concurrent session management (list/revoke)~~ | Yes | Yes | Yes | Yes | - | Yes | Yes | — | — |
| S-6 | New-device login notification | Yes | Yes | Yes | Yes | - | Yes | Yes | Medium | Medium |
| S-7 | Phishing detection alert | - | - | - | Yes | - | - | - | Low | High |

> **Out of scope by design: S-3 FIDO2 / WebAuthn (login 2FA)**  
> passwd-sso follows an OSS-first design that delegates login authentication (including MFA/2FA) entirely to external IdPs (Google OAuth, SAML IdPs). Equivalent security can be achieved by enabling FIDO2 security keys on the IdP side.

Legend: 1P=1Password, BW=Bitwarden, LP=LastPass, DL=Dashlane, KP=KeePassXC, PP=Proton Pass, NP=NordPass

#### ~~S-1 Clipboard auto-clear~~ — Implemented (2026-02-20)

Implemented as 30-second auto-clear (`navigator.clipboard.writeText("")`) in `CopyButton` (Web UI).

#### ~~S-2 Master-password reprompt~~ — Implemented (2026-02-18)

Added `PasswordEntry.requireReprompt`. Requires master-password re-entry for view/copy/edit operations. Implemented via `RepromptDialog` + `useReprompt` hook.

#### ~~S-3 FIDO2 / WebAuthn~~ — Out of scope

By OSS-first design, authentication is not embedded in the app. MFA/2FA is expected at external IdP level (Google Advanced Protection / SAML IdP MFA features).

#### ~~S-5 Concurrent session management~~ — Implemented (2026-02-23)

Active session list (`GET /api/sessions`) and individual/bulk revocation (`DELETE /api/sessions/[id]`, `DELETE /api/sessions`). Device/browser/OS detection via Bowser. Rate limited (10/min single, 5/min bulk). Audit logged (`SESSION_REVOKE`, `SESSION_REVOKE_ALL`). Tenant RLS applied. UI in `sessions-card.tsx`.

---

### 2.2 Vault Management / Team

| # | Feature | 1P | BW | LP | DL | KP | PP | NP | Impact | Implementation Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ~~V-1~~ | ~~Folders / hierarchy~~ | Vault | Folder+Collection | Folder | Collection | Hierarchical Group | Vault+Folder | Folder | — | — |
| ~~V-2~~ | ~~Entry history~~ | Yes | Yes | - | - | Yes | - | - | — | — |
| ~~V-3~~ | ~~Duplicate detection~~ | Yes | - | - | - | - | - | - | — | — |
| ~~V-4~~ | ~~Entry expiration / rotation reminders~~ | Yes | - | Yes | - | Yes | - | - | — | — |
| V-5 | Multiple personal vaults | Yes | - | - | - | Yes | Yes | - | Low | High |
| V-6 | Nested tags | Yes | - | - | - | - | - | - | Low | Low |

#### ~~V-1 Folders / hierarchy~~ — Implemented (2026-02-18)

Implemented `Folder` / `TeamFolder` for personal + team hierarchical folders. Max depth 5, cycle detection, drag-and-drop ordering. Tags and folders coexist: folders for hierarchy, tags for cross-cutting classification.

#### ~~V-2 Entry history~~ — Implemented (2026-02-18)

Added `PasswordEntryHistory` / `TeamPasswordEntryHistory`. PUT automatically snapshots old `encryptedBlob`. Max 20 records per entry, 90-day purge, restore support. Sensitive-field masking and reprompt guard included.

#### ~~V-3 Duplicate detection~~ — Implemented (2026-02-20)

Added duplicate section in Watchtower. Compares host + username after client-side decryption of `encryptedOverview` (`www.` normalization included). Adds 5% weight in score calculation.

#### ~~V-4 Entry expiration~~ — Implemented (2026-02-20)

Added `PasswordEntry.expiresAt`, date-picker UI, Watchtower expired/expiring detection, and card badges.

---

### 2.3 Entry Types

| # | Feature | 1P | BW | LP | DL | KP | PP | NP | Impact | Implementation Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E-1 | SSH keys (+ SSH Agent) | Yes | Yes | - | - | Yes | - | - | High | High |
| ~~E-2~~ | ~~Bank account~~ | Yes | - | Yes | Yes | - | - | - | — | — |
| ~~E-3~~ | ~~Software license~~ | Yes | - | Yes | - | - | - | - | — | — |
| ~~E-4~~ | ~~Custom field: BOOLEAN~~ | - | Yes | - | - | - | - | - | — | — |
| ~~E-5~~ | ~~Custom field: DATE, MONTH_YEAR~~ | Yes | - | - | - | - | - | - | — | — |
| E-6 | Secure note Markdown support | Yes | - | - | - | - | - | - | Low | Low |

#### E-1 SSH key management

- Current: no SSH-key type
- Competitors: 1Password (SSH Agent + Git signing), Bitwarden (SSH Agent), KeePassXC (SSH Agent + Auto-Type)
- Proposal: add `SSH_KEY` entry type with `privateKey` (encrypted), `publicKey`, `fingerprint`, `keyType` (Ed25519/RSA/ECDSA), `comment`; future SSH-agent proxy support

#### ~~E-2 Bank account~~ — Implemented (2026-02-28)

Added `BANK_ACCOUNT` entry type with encrypted-blob fields: bankName, accountHolderName, accountType (checking/savings/money_market/line_of_credit/other), accountNumber, accountNumberLast4, routingNumber, iban, swiftBic, branchName. Full form UI in personal + team vaults, detail/share views, export/import support (JSON + passwd-sso CSV), audit logged.

#### ~~E-3 Software license~~ — Implemented (2026-02-28)

Added `SOFTWARE_LICENSE` entry type with: softwareName, licenseKey, licensee, email, version, purchaseDate, expirationDate. Validation: expirationDate >= purchaseDate. Watchtower expiry detection. Full form UI, detail/share display with date formatting, export/import support, audit logged.

#### ~~E-4 Custom field: BOOLEAN~~ — Implemented (2026-02-28)

Extended custom field types enum to include BOOLEAN type. Supports true/false toggle in forms, localized "Yes"/"No" display in views.

#### ~~E-5 Custom field: DATE, MONTH_YEAR~~ — Implemented (2026-02-28)

Extended custom field types to support DATE (full date picker, YYYY-MM-DD) and MONTH_YEAR (month/year picker, YYYY-MM). Both with localized formatting across all views (detail, history, export).

---

### 2.4 Browser Extension

| # | Feature | 1P | BW | LP | DL | KP | PP | NP | Impact | Implementation Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ~~X-1~~ | ~~TOTP autofill~~ | Yes | Yes | - | - | Yes | Yes | Yes | — | — |
| X-2 | Credit-card / address autofill | Yes | Yes | Yes | Yes | - | Yes | Yes | Medium | Medium |
| ~~X-3~~ | ~~Context menu (right click)~~ | Yes | Yes | Yes | - | - | - | - | — | — |
| ~~X-4~~ | ~~Extension keyboard shortcuts~~ | Yes | Yes | - | - | - | - | - | — | — |
| ~~X-5~~ | ~~New-login detect & save prompt~~ | Yes | Yes | Yes | Yes | Yes | Yes | Yes | — | — |
| X-6 | TOTP QR capture | - | Yes | - | - | - | - | - | Low | Medium |

#### ~~X-1 TOTP autofill~~ — Implemented (2026-01)

Implemented TOTP generation (SHA1/SHA256/SHA512) and auto-fill into 2FA fields in extension.
Runs automatically after login autofill; password autofill is not blocked when TOTP generation fails.

#### ~~X-3 Context menu~~ — Implemented (2026-02-28)

Chrome `contextMenus` API with URL-matched entry listing (max 5), debounced updates on tab switch, autofill on click with UUID validation on entryId. Includes "Open passwd-sso" shortcut.

#### ~~X-4 Extension keyboard shortcuts~~ — Implemented (2026-02-28)

5 Chrome `commands`: open popup (Cmd+Shift+A, Chrome-native), copy password (Cmd+Shift+P), copy username (Cmd+Shift+U), trigger autofill (Cmd+Shift+F), lock vault. Clipboard auto-clear after 30 seconds.

#### ~~X-5 New-login detection~~ — Implemented (2026-02-28)

Form submit capture (capture phase) + click-based detection for SPAs. Registration form skipping heuristics (multiple password fields, registration-specific URL paths, extra form fields). Save/update banner in Shadow DOM (15s auto-dismiss). Pending save push/pull mechanism for post-navigation persistence. Security: sender.tab.url validation (untrusted message.url), cross-origin push guard, AAD-bound encryption, pending save TTL 30s / max 5.

---

### 2.5 Cross-platform

| # | Feature | 1P | BW | LP | DL | KP | PP | NP | Impact | Implementation Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P-1 | Mobile apps (iOS/Android) | Yes | Yes | Yes | Yes | 3rd party | Yes | Yes | High | Very High |
| P-2 | CLI tool (vault operations) | Yes | Yes | - | - | Yes | Planned | - | Medium | Medium |
| P-3 | Offline access | Yes | Yes | Partial | Partial | Yes | Yes | Yes | Medium | High |
| P-4 | Desktop app | Yes | Yes | - | - | Yes | Yes | Yes | Low | High |
| P-5 | Biometric unlock (Touch ID/Face ID) | Yes | Yes | Yes | Yes | - | Yes | Yes | Medium | Depends on P-1 |

#### P-1 Mobile apps

- Current: web UI only; accessible via mobile browser but no native autofill integration
- Competitors: all provide iOS/Android native apps
- Proposal: React Native or Capacitor/Ionic reusing existing React components; integrate iOS/Android credential-provider APIs; replace Web Crypto via `react-native-quick-crypto`

#### P-2 CLI tool

- Current: no CLI; only web UI / extension
- Competitors: 1Password `op`, Bitwarden CLI, KeePassXC `keepassxc-cli`
- Proposal: Node-based CLI package (`commander` + existing crypto libraries), useful for CI/CD secret injection and scripting

---

### 2.6 Sharing / Collaboration

| # | Feature | 1P | BW | LP | DL | KP | PP | NP | Impact | Implementation Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ~~C-1~~ | ~~Send (text/file sharing to non-users)~~ | - | Yes | - | - | - | - | - | — | — |
| C-2 | Granular sharing permissions (view/edit/admin) | Yes | Yes | Yes | Yes | - | Yes | - | Medium | Medium |
| C-3 | Vault-level sharing | Yes | Collection | - | - | KeeShare | Yes | - | Low | High |

#### ~~C-1 Send~~ — Implemented (2026-02-19)

Implemented Bitwarden-like temporary text/file sharing.
Added `sendContentType` to `PasswordShare` model; supports expiry, view limits, password protection, revocation.
Audit events: `SEND_CREATE`, `SEND_REVOKE`. Sidebar integrated under "Share".

---

### 2.7 Notifications / Alerts

| # | Feature | 1P | BW | LP | DL | KP | PP | NP | Impact | Implementation Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ~~N-1~~ | ~~Email notifications (breach etc.)~~ | Yes | Yes | Yes | Yes | - | Yes | Yes | — | — |
| N-2 | In-app notification center | Yes | Yes | Yes | Yes | - | Yes | Yes | Medium | Medium |
| ~~N-3~~ | ~~Password-change reminders~~ | Yes | - | Yes | - | Yes | - | - | — | — |
| ~~N-4~~ | ~~Emergency-access request email~~ | - | Yes | Yes | - | - | - | Yes | — | — |

#### ~~N-1 Email notification infrastructure~~ — Implemented (2026-02-23)

Dual-provider email foundation: Resend and SMTP (nodemailer). Provider selection via `EMAIL_PROVIDER` env var. Bilingual templates (en/ja). Async non-blocking sends with error logging. HTML + plain-text variants. HTML escaping for injection prevention.

#### ~~N-4 Emergency-access email notifications~~ — Implemented (2026-02-23)

6 email notification types across all emergency access workflows: invite, grant accepted, grant declined, access requested (with wait period), access approved, access revoked. Integrated into all EA API routes. Uses N-1 email infrastructure.

---

### 2.8 Enterprise

| # | Feature | 1P | BW | LP | DL | KP | PP | NP | Impact | Implementation Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ~~B-1~~ | ~~SCIM provisioning~~ | Yes | Yes | Yes | Yes | - | Yes | Yes | — | — |
| B-2 | Directory sync (AD/Azure AD/LDAP) | Yes | Yes | Yes | Yes | - | - | - | Medium | High |
| B-3 | SIEM integration (events API) | Yes | Yes | Yes | Yes | - | - | - | Medium | Medium |
| B-4 | Security policies (enforce 2FA/password requirements) | Yes | Yes | Yes | Yes | - | Yes | Yes | Medium | Medium |
| B-5 | Admin password reset | Yes | Yes | Yes | - | - | - | Yes | Low | Medium |

#### ~~B-1 SCIM provisioning~~ — Implemented (2026-02-27)

Implemented SCIM 2.0 provisioning scoped to tenant level. Endpoints: `/api/scim/v2/Users` (CRUD), `/api/scim/v2/Groups` (CRUD), `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas`. Bearer token auth with tenant-scoped token management. Groups map to team membership roles. Rate limiting and RFC 7644 compliant error responses included.

#### B-3 SIEM integration

- Current: audit logs stored in DB + pino stdout; no external SIEM API
- Proposal: audit-log REST export (JSON Lines / CSV) and optional webhook notifications

---

### 2.9 Developer-Focused

| # | Feature | 1P | BW | LP | DL | KP | PP | NP | Impact | Implementation Effort |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-1 | SSH Agent integration | Yes | Yes | - | - | Yes | - | - | High | High |
| D-2 | Secrets management (CI/CD) | Yes | Yes | - | - | API | Planned | - | Medium | Medium |
| D-3 | REST API (external integration) | Yes | Yes | - | - | - | - | - | Low | Medium |

---

### 2.10 Unique Differentiators

| # | Feature | Provided by | Impact | Implementation Effort |
| --- | --- | --- | --- | --- |
| U-1 | Email alias generation | Proton Pass (unlimited), NordPass (200) | Medium | High |
| U-2 | Continuous dark-web monitoring | Dashlane, LastPass | Medium | Medium |
| U-3 | Travel Mode | 1Password | Low | Medium |
| U-4 | Secure note templates | LastPass (15+) | Low | Low |

---

## 3. Priority Matrix

### Evaluation Criteria

- **Impact:** user value + security improvement + competitiveness
- **Implementation effort:** architecture fit + engineering cost

```
          High impact
              │
     P1       │      P0
   (planned)  │   (top priority)
              │
  ────────────┼────────────→ Low effort
              │
     P3       │      P2
 (long-term)  │   (start early)
              │
          Low impact
```

### P0: Top priority (high impact x low effort) — ✅ Completed

| ID | Feature | Status |
| --- | --- | --- |
| ~~S-1~~ | Clipboard auto-clear | ✅ 2026-02-20 |
| ~~S-2~~ | Master-password reprompt | ✅ 2026-02-18 |
| ~~V-4~~ | Entry expiration | ✅ 2026-02-20 |
| ~~V-3~~ | Duplicate detection | ✅ 2026-02-20 |
| ~~N-3~~ | Password-change reminders | ✅ 2026-02-20 |

### P1: Planned implementation (high impact x medium/high effort) — ✅ Completed

| ID | Feature | Status |
| --- | --- | --- |
| ~~V-1~~ | Folders / hierarchy | ✅ 2026-02-18 |
| ~~V-2~~ | Entry history | ✅ 2026-02-18 |
| ~~X-1~~ | TOTP autofill (extension) | ✅ 2026-01 |
| ~~C-1~~ | Send (temporary sharing) | ✅ 2026-02-19 |
| ~~X-5~~ | ~~New-login detect & save~~ | ✅ 2026-02-28 |
| ~~N-1~~ | ~~Email notification foundation~~ | ✅ 2026-02-23 |
| ~~N-4~~ | ~~Emergency-access notification (email)~~ | ✅ 2026-02-23 |
| ~~B-1~~ | ~~SCIM provisioning~~ | ✅ 2026-02-27 |

### P2: Start early (medium impact x low/medium effort)

| ID | Feature | Rationale |
| --- | --- | --- |
| ~~S-5~~ | ~~Session management~~ | ✅ 2026-02-23 |
| S-6 | Login notifications | Built on top of N-1 email foundation |
| ~~E-2~~ | ~~Bank account type~~ | ✅ 2026-02-28 |
| ~~E-3~~ | ~~Software license type~~ | ✅ 2026-02-28 |
| ~~X-3~~ | ~~Context menu~~ | ✅ 2026-02-28 |
| ~~X-4~~ | ~~Extension keyboard shortcuts~~ | ✅ 2026-02-28 |
| C-2 | Granular sharing permissions | Extend existing RBAC |
| B-3 | SIEM integration | Expose audit logs via REST |
| B-4 | Security policies | Add team policy tables/settings |
| P-2 | CLI tool | Developer-focused differentiation |
| V-6 | Nested tags | Hierarchy via `/` style path representation |
| U-4 | Secure note templates | Mostly schema/template additions |
| N-2 | In-app notification center | Generic notification UX beyond Watchtower |
| ~~E-4~~ | ~~Custom field: BOOLEAN~~ | ✅ 2026-02-28 |
| ~~E-5~~ | ~~Custom field: DATE, MONTH_YEAR~~ | ✅ 2026-02-28 |
| E-6 | Secure note Markdown | Editor integration |

### P3: Mid/long-term (low impact or high effort)

| ID | Feature | Rationale |
| --- | --- | --- |
| S-4 | Passkey vault unlock | Affects key-derivation design |
| P-1 | Mobile app | Very high effort, likely dedicated team |
| P-3 | Offline access | Service Worker + IndexedDB + complex sync design |
| P-4 | Desktop app | Electron/Tauri, can be partially substituted by web |
| E-1 | SSH keys + SSH Agent | New entry type + native process integration |
| D-1 | SSH Agent integration | Depends on desktop/CLI direction |
| D-2 | Secrets management | Depends on CLI + API maturity |
| B-2 | Directory sync | SCIM foundation in place; can build on top |
| V-5 | Multiple vaults | Significant key-management redesign |
| U-1 | Email aliases | Requires mail infra integration |
| U-3 | Travel Mode | Niche feature |

---

## 4. Recommended Roadmap

### Phase 1: Security foundation (P0) — ✅ Completed

```
Goal: Reach baseline security parity with competitors
Completed: 2026-02-20
```

1. ~~**S-1** Clipboard auto-clear~~ ✅
2. ~~**S-2** Master-password reprompt flag~~ ✅
3. ~~**V-3** Duplicate detection (Watchtower extension)~~ ✅
4. ~~**V-4** Entry expiration + **N-3** change reminders~~ ✅

### Phase 2: UX + extension improvements (early P1) — ✅ Completed

```
Goal: Significantly improve day-to-day usability
Completed: 2026-02-28
```

5. ~~**V-1** Folders / hierarchy~~ ✅
6. ~~**V-2** Entry history~~ ✅
7. ~~**X-1** TOTP autofill (extension)~~ ✅
8. ~~**X-5** New-login detection~~ ✅
9. ~~**X-3** Context menu~~ ✅
10. ~~**X-4** Extension keyboard shortcuts~~ ✅

### Phase 3: Notifications + sharing (late P1) — ✅ Completed

```
Goal: Establish notification foundation and strengthen collaboration
Completed: 2026-02-23
```

11. ~~**N-1** Email notification foundation~~ ✅
12. ~~**N-4** Emergency-access request notifications~~ ✅
13. ~~**C-1** Send (temporary sharing)~~ ✅

### Phase 4: Enterprise readiness (P1 + P2) — Partially complete

```
Goal: Add controls needed for enterprise use
Completed: B-1 SCIM, S-5 Session management
```

1. ~~**B-1** SCIM provisioning~~ ✅
2. **B-4** Security policies
3. **B-3** SIEM integration
4. ~~**S-5** Session management~~ ✅

### Phase 5: Platform expansion (P2 + P3)

```
Goal: Multi-platform expansion
```

1. **P-2** CLI tool
2. **E-1** SSH key management
3. **P-1** Mobile apps (iOS / Android)
4. **P-3** Offline access

---

## 5. Competitor Summary (Current)

Feature-category coverage:

| Product | Supported categories (/11) | Strengths |
| --- | --- | --- |
| 1Password | 11/11 | Entry-type breadth (22+), SSH Agent, Travel Mode, Secrets |
| Bitwarden | 10/11 | OSS, Send, self-hosting, SCIM |
| LastPass | 8/11 | Continuous dark-web + SaaS monitoring |
| Dashlane | 8/11 | Built-in VPN, Confidential SSO, phishing detection |
| KeePassXC | 7/11 | Fully local, SSH Agent, Auto-Type |
| Proton Pass | 8/11 | Email aliases, Swiss jurisdiction, ecosystem |
| NordPass | 7/11 | XChaCha20, email masking, offline mode |
| **passwd-sso** | **10/11** | E2E encryption, PQC-ready, self-hosted, SAML SSO, Send, SCIM, tenant RLS, 7 entry types |

**passwd-sso differentiators:**

- ML-KEM hybrid PQC (emergency access) — rare among competitors
- Fully self-hosted + SAML 2.0 SSO — uncommon outside Bitwarden
- Multi-tenant isolation with FORCE ROW LEVEL SECURITY (28 tables)
- SCIM 2.0 provisioning (tenant-scoped, team-level group mapping)
- Coexistence of team vault + personal E2E vault
- Strong audit-log surface (36 action types)
- Send (temporary text/file sharing) parity with Bitwarden
- Strong vault management: folder hierarchy + entry history + duplicate detection
- Full extension feature set: autofill, TOTP, context menu, keyboard shortcuts, login detection & save
- Email notification infrastructure (Resend + SMTP) with full emergency-access notification coverage
- Concurrent session management (list/revoke with device detection)

**Largest gaps:**

- No mobile / desktop apps
- Enterprise controls (SIEM, policy engine) — SCIM and session management implemented
- Extension gaps: card/address autofill (X-2), TOTP QR capture (X-6)

**Improvements since previous report (2026-02-20):**

- ~~No SCIM~~ -> implemented (Users + Groups, tenant-scoped tokens, RFC 7644)
- Multi-tenant model with FORCE ROW LEVEL SECURITY on all 28 tenant-scoped tables
- Org-to-team rename completed (DB, API, UI, i18n)
- CI guard scripts for RLS bypass allowlist and nested auth detection
- Extension Group A completed: context menu, keyboard shortcuts, new-login detect & save
- Group B completed: session management, email notification infrastructure, emergency-access notifications
- Group C completed: Bank Account + Software License entry types, BOOLEAN/DATE/MONTH_YEAR custom fields, requireReprompt/expiresAt on all 7 entry types

---

## 6. Recommended Next Batch (Batch D)

Combine remaining Phase 2 scope with low-friction P2 items.

### Group A: Browser Extension Enhancements — ✅ Completed (2026-02-28)

| ID | Feature | Effort | Notes |
| --- | --- | --- | --- |
| ~~X-5~~ | ~~New-login detect & save~~ | Medium | ✅ Form submit capture + click-based detection |
| ~~X-3~~ | ~~Context menu (right-click)~~ | Low | ✅ Chrome `contextMenus` API |
| ~~X-4~~ | ~~Extension keyboard shortcuts~~ | Low | ✅ Chrome `commands` API |

### Group B: Session Management + Notification Foundation — ✅ Completed (2026-02-23)

| ID | Feature | Effort | Notes |
| --- | --- | --- | --- |
| ~~S-5~~ | ~~Concurrent session management~~ | Medium | ✅ Session list/revoke API + UI, device detection |
| ~~N-1~~ | ~~Email notification foundation~~ | Medium | ✅ Resend + SMTP dual-provider, bilingual templates |
| ~~N-4~~ | ~~Emergency-access notifications~~ | Low | ✅ 6 email types across all EA workflows |

### Group C: Entry Type Expansion — ✅ Completed (2026-02-28)

| ID | Feature | Effort | Notes |
| --- | --- | --- | --- |
| ~~E-2~~ | ~~Bank account~~ | Low | ✅ Enum + encrypted-blob structure + UI |
| ~~E-3~~ | ~~Software license~~ | Low | ✅ Same as above |
| ~~E-4~~ | ~~Custom field: BOOLEAN~~ | Low | ✅ Enum addition |
| ~~E-5~~ | ~~Custom field: DATE, MONTH_YEAR~~ | Low | ✅ Enum addition |

Also extended `requireReprompt` and `expiresAt` from LOGIN-only to all 7 entry types (personal + team vaults).

**All three groups completed:** ~~A~~ -> ~~B~~ -> ~~C~~

---

*Competitor information in this report reflects the state as of February 2026. Feature availability varies by product plan and deployment model.*
