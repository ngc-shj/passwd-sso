# Manual Test Plan: step-up client reauth — close the class

**R35 tier**: 2 (Critical) — change touches the session step-up (re-authentication)
lifecycle for every mutating-UI caller of a `requireRecentCurrentAuthMethod`-gated
route, including admin-IA pages (team member management, ownership transfer, team
deletion). A regression re-opens a UX dead-end on a stale session and (for the vault
permanent-delete flow) a purged-looking-but-still-alive secret.

**Boot signal (R32)**: not applicable — no new long-running runtime artifact.

**Branch**: `fix/step-up-client-policy-card`

## Pre-conditions

- Local dev stack up (`npm run docker:up`), migrations applied.
- A tenant admin/owner user with vault set up and at least one password entry.
- The step-up window is 15 minutes. To force a STALE window without waiting, run in
  the dev DB: `UPDATE sessions SET created_at = now() - interval '1 hour' WHERE session_token = '<token>';`
  (mirrors the E2E `makeSessionStale` helper). To restore: `... SET created_at = now() ...`.
- A test user WITHOUT a passkey (so the RecentSessionRequiredDialog / "sign in again"
  path shows) and, separately, a user WITH a PRF passkey (so the PasskeyReauthDialog path
  shows) — both reauth surfaces should be exercised.
- For team scenarios: a team with the admin as owner plus one other member.

## Scenarios

Each scenario: (1) with a FRESH session the mutation succeeds; (2) with a STALE session
the reauth prompt appears (NOT a generic error toast / silent reload); (3) after
completing reauth the original mutation replays and succeeds.

### A — Tenant security policy cards (8 cards, shared route)
- Steps: with a stale session, open Settings → Security, change any field on each policy
  card (session / passkey / token / lockout / access-restriction / password / delegation /
  retention) and click Save.
- Expected: the reauth prompt opens; no generic "save failed" toast; after reauth the
  save completes and the value persists.

### B — Developer / credential cards
- **api-key**: create (POST) and revoke (DELETE) each open reauth on a stale session.
- **mcp-client**: create (POST), edit (PUT), delete (DELETE) — all three.
- **service-account**: edit (PUT), delete (DELETE), revoke token (token DELETE).
- **scim-token**: create (POST) and revoke (DELETE).
- **access-request**: approve (POST) and deny (POST).
- Expected: each opens the reauth prompt on a stale session and replays on success.

### C — Admin IA pages (the R35 Tier-1 trigger)
- **members/list**: change a member's role (PUT) and remove a member (DELETE).
- **transfer-ownership**: transfer ownership to another member (PUT).
- **general/delete**: delete the team (DELETE).
- Expected: each mutation, on a stale session, opens the reauth prompt in the page (dialogs
  render in page JSX) and replays the correct mutation after reauth. Editing the team
  profile (PUT, NOT gated) does NOT prompt reauth.

### D — Webhooks (shared base component, tenant + team)
- Create (POST) and delete (DELETE) a tenant webhook AND a team webhook.
- Expected: all four (2 consumers × 2 methods) open reauth on a stale session.

### E — Vault permanent-delete / empty-trash / bulk-purge
- **permanent-delete** a single trashed entry, **empty-trash**, and **bulk-purge** selected
  trashed entries — personal AND team vault.
- Expected: each opens reauth on a stale session and purges after reauth.

## Adversarial scenarios (R35 Tier-2)

### ADV-1 — Permanent-delete phantom state (the F1 fix)
- Pre: stale session, one trashed personal entry visible.
- Steps: permanently delete it. When the reauth prompt appears, **cancel it** (or fail the
  passkey ceremony). Then reload the trash view.
- Expected: the entry is STILL VISIBLE (the optimistic removal was rolled back via reload
  before reauth opened) and STILL EXISTS server-side. It must NOT read as deleted while
  alive. Repeat for team vault. Repeat for empty-trash and bulk-purge (these never
  optimistically remove, so the row must simply remain).

### ADV-2 — Soft-delete stays frictionless
- Pre: stale session.
- Steps: move an entry to trash (soft-delete, NOT permanent) — personal and team.
- Expected: NO reauth prompt (soft-delete is not step-up-gated); the entry moves to trash
  normally. Only the `?permanent=true` path is gated.

### ADV-3 — Exempt / custom-recovery surfaces still recover
- **operator-token** issuance on a stale session: shows its bespoke stale-session flow
  (`OPERATOR_TOKEN_STALE_SESSION`), not a dead-end.
- **auto-extension connect** on a stale session: surfaces via the extension-connect error
  channel, not a silent failure.
- Expected: these exempted surfaces still give the user a recovery path (they are exempt
  from the standard dialog only because they own a custom one).

### ADV-4 — Reauth-replay targets the correct mutation
- Pre: stale session, a multi-mutation component (e.g. mcp-client-card with create/edit/
  delete, or admin members with role-change/remove).
- Steps: trigger DELETE, complete reauth.
- Expected: the DELETE (not create/edit) replays — the discriminated retry target must not
  replay the wrong mutation.

## Expected result (summary)
Every gated mutation, on a stale session, opens a reauth prompt and replays on success; no
gated mutation surfaces a generic error/silent reload; no permanent-delete leaves a
purged-looking-but-alive secret; ungated paths (soft-delete, profile edit) are unaffected.

## Rollback
Revert the branch. No migration, no persisted-state change — the change is client wiring +
comment markers + a CI guard, so rollback is a pure code revert with no data cleanup.
