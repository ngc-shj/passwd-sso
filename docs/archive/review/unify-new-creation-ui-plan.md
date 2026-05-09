# Plan: Unify New Creation UI

## Project Context

- Type: `web app`
- Test infrastructure: `unit + integration`
- Scope: tenant settings, team settings, and personal settings creation flows

## Objective

Unify creation UX across the settings and admin surfaces by standardizing:

- whether "new/create/register" flows open in a dialog or render inline
- where the primary create button is placed
- how one-time secrets are revealed after creation
- when passkey nickname input should happen

## Requirements

### Functional

- New creation flows should use one standard interaction model.
- Primary create buttons should appear in one standard location.
- Create or register submit buttons inside dialogs should remain disabled until all required fields are filled.
- One-time secrets must still be shown safely and clearly.
- Recent-session-required failures for sensitive creation or approval actions should surface one consistent user-facing message.
- Existing CRUD behavior and permission checks must remain unchanged.
- Existing list views must remain intact.

### Non-functional

- Reduce visual inconsistency across tenant, team, and personal settings.
- Keep mobile layout readable.
- Avoid unnecessary header crowding.
- Minimize churn by reusing existing dialog patterns where possible.

## Technical Approach

### Recommended Standard

- Use `Dialog` as the default creation flow.
- Place the primary CTA below the card description, left-aligned.
- Reserve header-right actions for secondary or state-dependent actions only.
- Show one-time secrets inside the same dialog in a post-success completion state.
- Do not keep large inline creation forms permanently expanded in the card body.

### Rationale

- Settings pages are list-heavy, so hiding large creation forms improves scanability.
- Dialog-first creation reduces vertical noise and keeps users anchored in the list context.
- Existing better-aligned screens already follow this direction, so the change extends a pattern instead of inventing a new one.
- Secret-bearing flows naturally fit a dialog with a completion state.

### Header Strategy

`SectionCardHeader` currently assumes header-right `CardAction`. The safest first implementation is:

- keep `SectionCardHeader.action` for secondary actions
- render the primary CTA at the top of `CardContent`
- for dialog components that currently own their trigger internally, move trigger ownership to the parent card or add an explicit optional trigger API so the card controls CTA placement

This avoids broad header refactoring while still enforcing a consistent primary-action position.

## Contracts

### C1. Creation interaction model

- Subject: All in-scope "new/create/register" flows use dialog-first interaction unless explicitly exempted.
- Function/module signatures:
  - Existing component public props remain unchanged unless a dialog-open state must be lifted for composition.
  - Shared dialog extraction is allowed if it preserves current API behavior.
  - Internal dialog components may add optional trigger-related props when needed to let the parent card own the primary CTA placement.
- Invariants:
  - No always-open creation form remains in the card body for in-scope targets.
  - The list view remains accessible without first dismissing a form.
  - Create success returns the user to the same list context.
  - Dialog submit buttons remain disabled until all required fields are filled.
- Forbidden patterns:
  - `pattern: <section className="space-y-3">.*<h3 className="text-sm font-medium">.*(Create|Add|Register) — reason: flags inline creation sections that should move into dialogs`
- Acceptance criteria:
  - In-scope screens open a dialog for creation.
  - Creation cancellation leaves the list view unchanged.
  - Creation success refreshes or updates the list without navigation away from the page.
  - Create or register submit buttons do not become clickable while a required field is empty.

### C2. Primary CTA placement

- Subject: Primary create actions move to one standard placement.
- Function/module signatures:
  - No route-level API changes.
  - Card components may gain an internal shared "create action row" helper if useful.
  - Dialog components that currently render their own trigger button may be refactored to accept a caller-owned trigger while preserving the existing user-visible action and submit behavior.
- Invariants:
  - The main create CTA is shown below the card description, left-aligned, unless the card has required read-only context that must remain above it.
  - Header-right actions are secondary only.
  - Destructive bulk actions remain visually separated from the primary create action.
- Forbidden patterns:
  - `pattern: <SectionCardHeader[\s\S]*action=\{[\s\S]*<Button[^>]*>([\s\S]*Create|Add|Register) — reason: prevents primary creation CTA from staying in header-right`
  - `pattern: <div className="flex justify-end">[\s\S]*<.*Dialog — reason: prevents ad hoc body-right CTA placement`
- Acceptance criteria:
  - The primary create CTA is the first action block after the description, or after any required read-only context block such as a scope note or endpoint URL.
  - Screens with extra destructive actions keep them separate from the primary create action.

### C3. One-time secret completion state

- Subject: Secret-bearing flows share one post-create pattern.
- Function/module signatures:
  - Existing create APIs keep returning the same secret-bearing payloads unless a screen already requires a richer shape.
  - UI state machines may add a "form" and "complete" mode within the same dialog.
- Invariants:
  - Secrets are shown only after successful creation.
  - Secrets are shown in a completion state inside the same dialog.
  - Copy affordance and one-time warning remain present.
- Forbidden patterns:
  - `pattern: setNewToken\(.*\)[\s\S]*<section className="border rounded-md p-4 bg-muted/50 — reason: flags inline post-create secret blocks that should move into dialog completion state`
- Acceptance criteria:
  - API keys, SCIM tokens, operator tokens, webhook secrets, client secrets, and service-account tokens follow one reveal pattern.
  - Closing the dialog clears the one-time secret from visible UI state.
- Consumer-flow walkthrough:
  - API key manager (`src/components/settings/developer/api-key-manager.tsx`) reads the returned plaintext token and uses it only for immediate display and copy.
  - SCIM token manager (`src/components/team/security/team-scim-token-manager.tsx`) reads the returned token and uses it only for immediate display and copy alongside the endpoint URL.
  - Operator token card (`src/components/settings/developer/operator-token-card.tsx`) reads the returned plaintext token and exposes it only in a one-time reveal state.
  - Webhook creation (`src/components/settings/developer/base-webhook-card.tsx`) reads the returned secret and exposes it only in a one-time reveal state.
  - MCP client and service-account token creation (`src/components/settings/developer/mcp-client-card.tsx`, `src/components/settings/developer/service-account-card.tsx`) read the returned client credentials or token secret and expose them only in the one-time reveal state.

### C5. Recent-session-required messaging

- Subject: Sensitive create or approve flows that require a recent session surface one consistent re-authentication message.
- Function/module signatures:
  - Existing route error codes remain unchanged.
  - UI components may add `ApiErrors` translations or shared error-code mapping usage to avoid flow-specific fallback to generic failure toasts.
- Invariants:
  - `SESSION_STEP_UP_REQUIRED` and equivalent flow-specific stale-session codes are not shown as generic network or create-failed errors.
  - Sensitive settings screens use one shared user-facing message for recent-session failures.
  - Existing domain-specific validation and quota errors remain specific and are not collapsed into the recent-session message.
- Acceptance criteria:
  - API key creation, SCIM token creation, operator token creation, MCP client creation, service-account token creation, and JIT access-request approval all surface the same re-authentication guidance.
  - The message tells the user to re-authenticate within the last 15 minutes and retry.
- Consumer-flow walkthrough:
  - API key creation (`src/components/settings/developer/api-key-manager.tsx`) translates recent-session failures through `ApiErrors` instead of falling back to a generic create error.
  - SCIM token creation (`src/components/team/security/team-scim-token-manager.tsx`) translates recent-session failures through `ApiErrors` instead of a generic network error.
  - Operator token creation (`src/components/settings/developer/operator-token-card.tsx`) uses the same shared re-authentication guidance even though the route returns a flow-specific stale-session code.
  - MCP client creation (`src/components/settings/developer/mcp-client-card.tsx`) translates recent-session failures through `ApiErrors` while preserving field-level validation handling.
  - Service-account token creation (`src/components/settings/developer/service-account-card.tsx`) translates recent-session failures through `ApiErrors` while preserving token-limit and validation errors.
  - Access-request approval (`src/components/settings/developer/access-request-card.tsx`) translates recent-session failures through `ApiErrors` while preserving already-processed and invalid-scope handling.

### C4. Passkey nickname timing

- Subject: Passkey registration no longer requires nickname entry before registration.
- Function/module signatures:
  - Passkey registration continues to accept an optional nickname.
  - Default nickname generation remains available and unchanged in behavior.
- Invariants:
  - Registration can proceed without pre-filled nickname input.
  - A generated nickname is applied when no custom nickname is provided.
  - Rename remains possible after creation.
- Forbidden patterns:
  - `pattern: <Label>.*nickname.*</Label>[\s\S]*<Input[\s\S]*value=\{nickname\}[\s\S]*<Button[\s\S]*register — reason: flags pre-registration nickname-first UI that should be reconsidered`
- Acceptance criteria:
  - User can register a passkey immediately.
  - A generated nickname is applied when no custom nickname is provided.
  - Post-registration rename remains available.
- Consumer-flow walkthrough:
  - Passkey registration UI (`src/components/settings/security/passkey-credentials-card.tsx`) reads the generated or user-supplied nickname and passes it to registration verification.
  - Credential list rendering on the same screen reads the stored nickname and uses it as the primary label, falling back to a shortened ID when absent.
  - Rename flow on the same screen reads the persisted nickname and updates it via the existing patch endpoint.

## Migration Groups

### Phase 1: Low risk

- Breakglass
- Delegation access
- Team creation
- Directory sync
- MCP client
- Service account account-creation entrypoint

Reason:

- These already have dialog foundations or only need CTA placement cleanup.
- They require minimal API or validation changes.

### Phase 2: Medium risk

- Operator token
- API key
- SCIM

Reason:

- These move from inline creation to dialog creation.
- One-time secret reveal must move into a dialog completion state.

### Phase 3: Higher risk

- Tenant webhook
- Team webhook
- Audit delivery target

Reason:

- These currently contain denser inline forms.
- Shared components need to be preserved while moving to dialog-first creation.
- Event-selection or target-type-selection UI increases migration complexity.

### Phase 4: Separate UX subtask

- Passkey nickname timing

Reason:

- This is not just a layout change; it changes the registration flow itself.
- It should be reviewed independently from the broader consistency refactor.

## Testing Strategy

- Update affected component tests to reflect dialog-first creation and CTA placement changes.
- Verify that create dialogs open, close, validate, and refresh list state correctly.
- Verify that one-time secret completion states appear only after successful creation.
- Verify that closing the completion state clears visible secret-bearing UI state.
- Verify that recent-session-required failures surface the shared re-authentication message instead of a generic error.
- Update and run the concrete affected component tests:
  - `src/components/settings/developer/base-webhook-card.test.tsx`
  - `src/components/settings/account/tenant-audit-log-card.test.tsx`
  - `src/components/settings/developer/delegation-manager.test.tsx`
  - `src/components/settings/developer/directory-sync-card.test.tsx`
  - `src/components/settings/developer/mcp-client-card.test.tsx`
  - `src/components/settings/developer/service-account-card.test.tsx`
  - `src/components/settings/developer/operator-token-card.test.tsx`
  - `src/components/settings/developer/api-key-manager.test.tsx`
  - `src/components/team/security/team-scim-token-manager.test.tsx`
  - `src/components/settings/developer/access-request-card.test.tsx`
  - `src/components/team/management/team-create-dialog.test.tsx`
  - `src/components/settings/security/passkey-credentials-card.test.tsx` if C4 is included in scope
- Add or adjust assertions for:
  - parent-owned trigger placement
  - dialog open/close lifecycle
  - post-create completion states for one-time secrets
  - recent-session failure toast mapping for sensitive flows
  - existing list refresh behavior after successful creation
- Run the broader relevant checks already used by this repo for UI work:
  - `npx vitest run`
  - `npm run lint`
  - `npx next build`

## Considerations & Constraints

- Do not change route contracts unless required for dialog completion-state handling.
- Dense forms such as webhook and audit delivery creation should start with `Dialog`; only revisit `Sheet` if real usability issues appear during implementation.
- `SectionCardHeader` should not be broadly redesigned in the first pass if the same consistency goal can be achieved from `CardContent`.
- Destructive bulk actions such as `revokeAll` should remain separated from the primary create action.
- `BreakGlassDialog` currently owns its trigger internally, while `TeamCreateDialog` already accepts a caller-provided trigger; the implementation must converge these trigger-ownership patterns instead of adding one-off placement exceptions.
- Some screens include required read-only context above creation today, such as tenant-scope notes or endpoint URLs; those context blocks may remain above the CTA if they are necessary for correct use of the flow.
- Recent-session messaging unification applies to the six settings flows currently guarded by `requireRecentSession`: API keys, SCIM tokens, operator tokens, MCP clients, service-account tokens, and JIT access-request approval.
- Passkey nickname timing should not block the rest of the UI unification work.

## User Operation Scenarios

1. Tenant admin opens Webhooks, sees the description, clicks a left-aligned primary CTA, completes the dialog, copies the secret in the completion state, closes the dialog, and remains on the list.
2. Tenant admin opens SCIM, clicks create token, receives the token in a one-time completion state, copies it, and returns to the token list.
3. Personal user opens API Keys, clicks create, configures scopes and expiry in a dialog, copies the new key, and returns to the key list.
4. Personal user opens Passkeys, clicks register immediately, completes WebAuthn, and renames later if desired.
5. Admin opens Teams, sees the main create button in the same visual position used elsewhere, and creates a team from a dialog.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Creation interaction model | locked |
| C2 | Primary CTA placement | locked |
| C3 | One-time secret completion state | locked |
| C5 | Recent-session-required messaging | locked |
| C4 | Passkey nickname timing | pending |

Implementation should not start for the broad refactor until C1-C3 and C5 remain stable. C4 is intentionally left pending so passkey flow redesign can be handled as a separate UX-sensitive follow-up if desired.
