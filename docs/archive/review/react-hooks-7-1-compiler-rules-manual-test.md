# Manual Test Plan: react-hooks-7-1-compiler-rules

Tier: Tier-1 — a behaviour-preserving refactor across admin pages and dashboard components to satisfy `eslint-plugin-react-hooks` 7.1.1. No API, schema, or crypto change. The risk is a UI flow that silently stops doing something: a step-up retry that no longer replays, a reset that no longer clears, a spinner that never shows.

## Automation status

`npx vitest run` covers the component and hook logic, including the new `vault-lock-screen.render.test.tsx` (auto-unlock waits for the PRF check; an unmounted screen leaves the one-shot sign-in flag alone) and `use-client-snapshot.test.tsx`. The steps below cover what unit tests cannot: real step-up reauth round-trips, client navigation between teams, and SSR hydration.

## Pre-conditions

- `npm run docker:up` and `npm run dev`
- Signed in as a tenant admin who owns at least two teams (A and B), with a vault set up
- A registered passkey with PRF support, for S5
- A session older than the step-up window, so step-up-gated mutations return the reauth prompt (or shorten the window in tenant policy)

## Steps

### S1. Step-up retry replays the mutation (latest-ref retry)
1. With a stale session, open Admin → Teams → A → General → Delete and confirm deletion of a throwaway team.
2. Complete the inline reauth prompt.
3. Expected: the deletion runs once after reauth and the page navigates away. It must not stop silently after a successful reauth.
4. Repeat for: Members → change a role; Members → Transfer ownership; one tenant policy card save (e.g. password policy); Breakglass grant; Team rotate key.

### S2. Switching teams resets per-team state
1. Open Admin → Teams → A → General → Profile, then switch to team B through the sidebar without a full reload.
2. Expected: B's name and settings render. A's values never show under B, and no load error from A carries over. Repeat on Members → List and Transfer ownership.

### S3. Admin vault reset link
1. Trigger an admin vault reset for a member and open the emailed `/vault-reset/admin#token=…` link.
2. Expected: no hydration warning in the console. The token is stripped from the URL bar. The reset form is usable and submits.

### S4. Loading indicators on refetch
1. Dashboard → Share links: switch the status and type filters.
2. Settings → Developer → Access requests: switch the status filter.
3. Expected: each switch shows the loading state, then the filtered rows; stale rows are not shown as current.

### S5. Vault auto-unlock after passkey sign-in
1. Sign out, then sign in with the PRF passkey.
2. Expected: the vault unlocks without a second ceremony.
3. Sign in with a non-PRF passkey. Expected: the lock screen stays, with no error, and manual unlock works.

### S6. Delegation dialog
1. Settings → Developer → Create delegation; pick an MCP token.
2. Expected: the spinner shows while entries decrypt, then the entry list appears. Token expiry minutes refresh when the token select is reopened.

### S7. Unsaved-changes detection in entry forms
1. Edit a personal entry, change one field (repeat per field: title, username, password, URL, notes, tags, folder), then try to close the dialog.
2. Expected: the unsaved-changes guard fires. Reverting the field back clears it.
