# Manual Test Plan — unify-new-creation-ui

R35 Tier-1 artifact for the dialog-first creation refactor and token-mint API
error allow-list (C1-C6 in `unify-new-creation-ui-plan.md`).

## Pre-conditions

- Local dev DB and app running (`npm run dev`).
- Test accounts:
  - `<tenant-admin-email>` — tenant role with permission to manage operator
    tokens, MCP clients, service accounts, SCIM tokens, webhooks, audit
    delivery targets.
  - `<personal-user-email>` — any signed-in user (for API key + passkey flows).
- Both locales (`/ja/`, `/en/`).

## Foundation health

| Step | Action | Expected |
|---|---|---|
| 0.1 | `npm run lint` | Clean |
| 0.2 | `npx vitest run` | 10154 passed / 1 skipped / 0 failed |
| 0.3 | `npx next build` | Succeeds |
| 0.4 | `bash scripts/pre-pr.sh` | All gates pass (this artifact satisfies the manual-test gate) |

## 1. Admin teams page — primary CTA placement (C2)

| Step | Action | Expected |
|---|---|---|
| 1.1 | Sign in as `<tenant-admin-email>`, navigate to `/ja/admin/tenant/teams` | Card header shows title and description; create CTA is inside `CardContent` (NOT in header-right `action` slot) |
| 1.2 | Click "チームを作成" / "Create team" | TeamCreateDialog opens |
| 1.3 | Cancel without filling | Dialog closes, list view unchanged |
| 1.4 | Sign in as a non-admin user, navigate to same page | Create CTA is NOT rendered (the `<section>` block is gated on `isAdmin`) |

## 2. Token-mint cards — dialog-first creation (C1, C2, C3)

For each of the seven token-mint cards, verify the create flow opens a dialog,
the submit button is disabled until required fields are filled, the one-time
secret is shown after success, and closing the dialog clears the visible state.

| Card | Path | Required fields |
|---|---|---|
| API key | personal settings → API keys | name, scope (≥1) |
| SCIM token | team security → SCIM | (description optional, expiry default) |
| MCP client | tenant settings → MCP clients | name, redirect URI, scope (≥1) |
| Operator token | tenant settings → operator tokens | name, expiry |
| Service-account token | tenant settings → service accounts → token mint | name, scope (≥1), expiry |
| Access request approve | tenant settings → access requests → approve | (no form; direct action) |
| CLI token | personal settings → CLI token | (no form; direct action) |

For each (where applicable):
| Step | Action | Expected |
|---|---|---|
| 2.x.1 | Open the create dialog | Dialog opens; submit button disabled |
| 2.x.2 | Fill required fields | Submit enables |
| 2.x.3 | Submit | Toast `created`; dialog transitions to one-time-secret view |
| 2.x.4 | Copy secret, click OK | Dialog closes; secret no longer in DOM (verify via DevTools "Find" if needed) |

## 3. Recent-session messaging (C5) + token-mint allow-list (C6)

For one token-mint flow (e.g. API key creation):
| Step | Action | Expected |
|---|---|---|
| 3.1 | Sign in, wait > 15 minutes (or manually expire session via `prisma studio` setting `Session.createdAt` 16 minutes back) | Session aged past `STEP_UP_WINDOW_MS` |
| 3.2 | Open API key dialog, fill required fields, submit | Toast displays the recent-session re-authentication message (NOT a generic `createError` toast) |
| 3.3 | Sign out and sign back in (resets session age) | Retry the create — succeeds |

For an unrecognized error code path:
| Step | Action | Expected |
|---|---|---|
| 3.4 | Use browser DevTools to mock the response on `POST /api/api-keys` to return `{ error: "BOGUS_NOT_IN_ALLOWLIST" }` with status 500 | Toast shows the local-namespace `createError` (NOT `unknownError` from ApiErrors); confirms the allow-list helper rejects unknown codes |

## 4. Passkey nickname auto-name (C4)

| Step | Action | Expected |
|---|---|---|
| 4.1 | Sign in as `<personal-user-email>`, navigate to security settings → Passkeys | Register section shows the register button + a hint text (no nickname input field) |
| 4.2 | Click "Register" | Browser WebAuthn prompt appears |
| 4.3 | Complete platform authenticator registration | Passkey appears in the list with an auto-generated name (e.g. `Touch ID` or `Security Key (USB)`) |
| 4.4 | Click "Rename" on the new credential, set a custom name | Nickname updates; list refreshes |
| 4.5 | Sign out, sign in via the new passkey | Authentication succeeds |

## 5. Webhook + audit-delivery-target (out-of-scope for C6, in-scope for C1)

These cards adopt the same dialog-first pattern but are NOT token-mint surfaces.
Verify the dialog flow works and unrecognized API errors fall back to the local
`createFailed` toast (no allow-list helper involved).

| Step | Action | Expected |
|---|---|---|
| 5.1 | tenant settings → webhooks → "Add webhook" | Dialog opens |
| 5.2 | Enter `http://example.com/hook` (non-https), select an event, submit | Inline URL error `urlHttpsRequired`; submit does NOT fire |
| 5.3 | Enter `https://example.com/hook`, select event, submit | Toast `created`; secret reveal section appears in the dialog |
| 5.4 | Click OK | Dialog closes; secret cleared |

## 6. Locale parity

| Step | Action | Expected |
|---|---|---|
| 6.1 | Repeat any one of the above flows under `/en/` | All copy renders in English with no missing-key fallbacks (`registerHint`, `createTokenDescription`, etc.) |
| 6.2 | Same flow under `/ja/` | All copy renders in Japanese; no English residual strings |

## 7. Accessibility spot-check

| Step | Action | Expected |
|---|---|---|
| 7.1 | Open API key create dialog, navigate via Tab | Focus order: name input → scope checkboxes → expiry select → cancel button → submit button |
| 7.2 | Press Esc | Dialog closes |
| 7.3 | Run Lighthouse / axe DevTools on a settings page with the new dialogs | No new accessibility violations introduced |
