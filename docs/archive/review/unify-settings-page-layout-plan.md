# Plan: Unify Settings Page Layout

## Project Context

- Type: `web app`
- Test infrastructure: `unit + integration + E2E (Playwright)`
- Scope: tenant settings, team settings, and personal settings list-style cards under `src/components/settings/**`, `src/components/team/**`, and the dashboard / admin pages that compose them. Vault / passwords main UI is explicitly out of scope.
- Prior work this plan builds on: PR #456 (`unify-new-creation-ui`) merged 2026-05-10. #456 already locked C1 (dialog-first creation), C2 (primary CTA below description, left-aligned), C3 (one-time secret completion state), C4 (passkey nickname timing), C5 (recent-session messaging), C6 (token-mint allow-list). This plan does NOT re-open those contracts; it addresses the remaining axes of layout inconsistency.

## Objective

Continue the layout-unification effort begun by #456 by addressing the **three axes that #456 explicitly did not touch**:

1. **Inactive / revoked data display** — currently three implementation styles (custom `<button>` + `ChevronDown` + conditional render, shadcn `<Collapsible>`, and inline `<Badge>`-only) exist for the same conceptual UI element. Unify on a single helper component.
2. **Search / filter field policy** — most cards have no filter; `passkey-credentials-card` has client-side filter; `tenant-audit-log-card` has server-side filter. Define when a search field belongs and standardize its position.
3. **Section separator placement** — the user-proposed layout introduces a horizontal rule between primary action area and list area. Decide whether to adopt as a policy, and if so where it lives.

The goal is **convergent consistency, not template uniformity**. The user's proposed full template ("Title > Desc > Create > Separator > Search > Active list > Collapsible inactive list") is taken as a starting reference and evaluated; this plan recommends **a lighter Option C** (policy + a single shared helper) over the rigid template.

## Recommended Option: C (lightweight extraction + policy)

### Options considered

| Option | Description | Risk |
|--------|-------------|------|
| A | Force every settings card into the user-proposed full template | Over-prescribes — low-data screens (sessions, breakglass list, delegation policy) gain useless search fields; visually inflates short cards |
| B | Two patterns split by data-volume characteristics (low / high) | Adds a classification axis with no clear boundary; "is this a high-volume screen?" becomes a bikeshed; future screens land in the wrong bucket |
| C (recommended) | Reuse `SectionCardHeader` (already unified by #456 via C2) as the spine; extract ONE shared helper for the inactive-data collapse; document a written policy for search field and separator placement; migrate only the cards that already have inconsistent inactive-data UI | Lowest churn; aligns the actually-divergent code; leaves screen-level decisions where they belong |

### Why C beats A and B

- After #456, the **header (SectionCardHeader), the description text slot, the primary CTA position, and dialog-first creation** are all already standardized. The user-perceived inconsistency that remains is dominated by inactive-data collapse divergence (six cards, three implementations) — that is a code-deduplication problem, not a layout-template problem.
- A single template (Option A) imposes a search field on screens that have <10 rows on every realistic tenant (`sessions-card`, `delegation-manager`, `breakglass`, `tenant-password-policy-card`, `team-policy-settings`). Adding a search field there is dead UI.
- The two-pattern split (Option B) requires every new card to declare its bucket. That decision is invisible in code and decays — six months later we will be back to three patterns.
- Option C keeps `SectionCardHeader` as the spine that #456 already validated; extracts the one piece of code that has measurable divergence; and writes the policy for the policy-shaped questions (search, separator) instead of pretending a component can encode them.

### Note on the user-proposed template

The user proposed `Title > Desc > Create > Separator > Search > Active list > Collapsible inactive list`. After investigation, the post-#456 state already satisfies the first three slots (`SectionCardHeader` + description + primary CTA below description). The remaining slots are the ones this plan addresses. The Separator slot is treated as policy, not as a forced visual element — see C3.

## Requirements

### Functional

- All settings cards that currently display revoked / expired / inactive items in a collapsed section MUST use the same shared helper.
- The helper MUST preserve the existing keyboard-accessibility behavior (Enter / Space toggles, focus ring visible, `aria-expanded` reflects state, `aria-controls` references the collapsed region).
- The helper MUST keep the inactive-count visible (e.g. "Inactive (3)") even when collapsed, so administrators doing inventory / cleanup do not lose the signal that revoked items exist.
- Search field policy is documented and applied consistently. Adding a search field to a card NOT in the documented "search-eligible" list is an architectural deviation that requires plan amendment.
- Separator policy is documented. Cards MAY render a `<Separator />` between the primary CTA row and the list region; cards MAY also omit it. Either is acceptable as long as visual rhythm is preserved by `space-y-*` on `CardContent`.
- Existing CRUD behavior, permission checks, route contracts, and audit emission remain unchanged. No route-handler edits.
- Existing Playwright / vitest tests continue to pass; if a test asserted a specific `aria-label` on the legacy bespoke `ChevronDown` button, the helper preserves an equivalent accessible name (see Testing Strategy).

### Non-functional

- Diff-cost minimization: the helper is small (<80 lines), and migration touches ≤6 card files plus their tests.
- No new dependency. Use the existing shadcn `Collapsible` primitives (`@radix-ui/react-collapsible`) already in use by `operator-token-card`, `service-account-card`, `mcp-client-card`.
- Locale parity (en + ja) for the helper's default labels (Active / Inactive / count). i18n keys live in `messages/{en,ja}.json` under a new `settings.inactiveSection` namespace.

## Technical Approach

### Architecture

Introduce one new shared component:

- `src/components/settings/shared/inactive-items-section.tsx` (component) — new `shared/` sibling under `src/components/settings/`. 6 of 7 migrated cards live under `settings/developer/`, 1 under `team/security/`; placing the helper under `settings/shared/` keeps it discoverable for both groups without forcing a relocation of `team-scim-token-manager`.
- `src/components/settings/shared/inactive-items-section.test.tsx` (tests)

Component shape (signature contract — body NOT part of the plan):

```tsx
type InactiveItemsSectionProps = {
  triggerLabel: ReactNode;            // already-translated label, supplied by caller (e.g. t("inactiveKeys", { count }))
  open: boolean;                      // controlled — caller owns state
  onOpenChange: (open: boolean) => void;
  ariaControlsId?: string;            // optional, defaults to a generated id (useId)
  children: ReactNode;                // the inactive list — caller renders rows
};
```

Internally wraps shadcn `Collapsible` + `CollapsibleTrigger` + `CollapsibleContent`. Trigger is a `Button variant="ghost"` with `ChevronDown` rotated by `data-state="open"`. The component is **controlled** because every existing call site already owns the `showInactive` state in pre-existing code; making the helper controlled keeps a single source of truth and avoids state-mirroring bugs.

### i18n: caller owns the label

The helper does NOT add new i18n keys and does NOT call `useTranslations` itself. Each migrated card already has a per-feature translation key in its own namespace (`messages/{en,ja}/{Namespace}.json`) — `ApiKey.inactiveKeys`, `McpClient.mcpInactive`, `ServiceAccount.saInactive`, `ScimToken.scimInactiveTokens`, `AuditDeliveryTarget.inactiveTargets`, `Webhook.*` (TBD per file inspection at implementation time), `OperatorToken.*` (TBD). Each card passes its existing translated string as `triggerLabel` — preserving the existing user-facing wording verbatim and removing any need for new locale-parity work in this plan.

This deliberately drops the "settings.inactiveSection" namespace proposed in the initial draft. That namespace would have collided with the actual repo layout (per-feature flat JSON files, not a dotted single-file namespace) and would have created locale-parity work for translations that already exist in the per-card namespaces.

### Search field policy (written policy, not code)

A search field belongs in a card iff **all three** conditions hold:

1. The collection has no theoretical upper bound per tenant (e.g. audit logs, password entries, members in a 10k-employee tenant). Cards with policy-imposed limits (≤16 active passkeys per user, ≤8 operator tokens per tenant, ≤5 sessions) do NOT qualify.
2. The card already supports server-side query parameters. Adding a search field that filters client-side over a paginated list silently breaks (it only filters the current page).
3. The card has a primary discovery use case — admins look for a specific item by name / email / IP. Cards whose use case is "review every item in turn" (policy settings, breakglass list, recent sessions) do not benefit.

**Cards that pass all three after #456:** `tenant-audit-log-card` (already has it), `passkey-credentials-card` (already has client-side, will be re-evaluated in C2 — see below), and any future card matching the rule. **No card gains a new search field in this plan.**

**Special case — `passkey-credentials-card`:** It currently filters client-side. The 16-passkey policy limit means rule (1) fails. The plan's C2 documents the exception ("retained for personal-vault discoverability with mixed authenticator names") rather than removing it.

### Separator placement policy

A `<Separator />` between the primary CTA row and the list MAY be added when ALL of:

- The card has both a CTA and a non-trivial list (>3 active items typical).
- The card has any read-only context block (scope note, endpoint URL) above the CTA.
- The CTA row otherwise visually merges with the list (no `gap` / `space-y-*` rhythm).

Otherwise, vertical rhythm via `space-y-4` on `CardContent` is sufficient. **No card gains or loses a separator in this plan;** the policy is documented for future cards. Existing `<Separator />` usage (if any) is left as-is to minimize migration churn.

### List density / Badge-vs-Collapsible decision

Some cards (`sessions-card`, `passkey-credentials-card`) display every item including revoked / expired in a single list with a `<Badge>` showing status, instead of collapsing inactive. This plan does NOT force them into the Collapsible pattern. Rule:

- **Collapsible-and-extract** when the card distinguishes operationally between active and inactive lifetimes AND inactive items have ongoing audit value but no operational utility (API keys, operator tokens, MCP clients, service accounts, webhooks, audit delivery targets).
- **Inline Badge** when the card's primary user task is to recognize the user's own current vs prior context (sessions, passkeys), where the inactive item's continued visibility is a feature, not noise.

This rule is documented in `docs/archive/review/unify-settings-page-layout-plan.md` (this file) for future readers.

## Contracts

### C1. Shared inactive-items collapsible helper

- Subject: All cards that currently render a card-internal "show / hide inactive list" toggle MUST use `InactiveItemsSection`.
- Function/module signatures:
  - File: `src/components/settings/shared/inactive-items-section.tsx`
  - Export: `InactiveItemsSection` (named export).
  - Props (exact shape — see Architecture section):
    ```ts
    type InactiveItemsSectionProps = {
      triggerLabel: ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
      ariaControlsId?: string;
      children: ReactNode;
    };
    ```
  - The component is a thin wrapper over `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` from `@/components/ui/collapsible`. No additional state. No imperative ref. No internal `useTranslations` call.
- Invariants:
  - Trigger button's accessible name comes entirely from `triggerLabel` — no helper-injected text.
  - `aria-expanded` reflects `open`. `aria-controls` references the content region's id.
  - `data-state="open" | "closed"` is set on the trigger so the `ChevronDown` rotation class works.
  - The component does not own any state beyond what `Collapsible` already manages internally for `aria-controls` id generation.
  - The component does NOT render the items themselves; the `children` slot is where callers render their existing row markup.
  - The component MUST render `children` as a sibling of the trigger inside `<CollapsibleContent>`; it MUST NOT wrap children in additional `<ul>` / `<table>` / `<div role="list">` so callers' a11y semantics are preserved.
- Forbidden patterns (introduced after this plan lands; existing code is migrated to remove these):
  - `pattern: <button[^>]*onClick=\{[^}]*setShowInactive[^}]*\}[^>]*>[\s\S]*<ChevronDown — reason: bespoke chevron-button toggle replaced by InactiveItemsSection`
  - `pattern: <Collapsible[\s\S]*open=\{showInactive[\s\S]*<CollapsibleTrigger[\s\S]*<CollapsibleContent — reason: raw Collapsible inactive-list pattern replaced by InactiveItemsSection`
- Acceptance criteria:
  - 7 cards migrate to the helper (enumerated by `git grep -l "showInactive\|showInactiveSa\|showInactiveTokens" src/components/`):
    - `src/components/settings/developer/api-key-manager.tsx`
    - `src/components/settings/developer/operator-token-card.tsx`
    - `src/components/settings/developer/mcp-client-card.tsx`
    - `src/components/settings/developer/service-account-card.tsx`
    - `src/components/settings/developer/base-webhook-card.tsx`
    - `src/components/settings/developer/audit-delivery-target-card.tsx`
    - `src/components/team/security/team-scim-token-manager.tsx` — note: tenant-scoped despite path under `team/security/` (route is `POST /api/tenant/scim-tokens`). Relocation is out of scope for this plan; the migration treats this card identically to the `settings/developer/` cards.
  - Each migrated card's existing `showInactive` state and per-card translation key (`inactiveKeys` / `mcpInactive` / `saInactive` / `scimInactiveTokens` / `inactiveTargets` / webhook label / operator-token label) remain unchanged. Only the JSX block that renders the toggle button + its conditional content changes.
  - Each migrated card passes its existing translated string as `triggerLabel` — visible-text wording is byte-identical to the pre-migration UI.
  - `pre-pr.sh` passes (`vitest run`, `lint`, `next build`).
  - i18n parity is verified by the existing `src/i18n/messages-consistency.test.ts` (no new keys means no new parity risk).
  - No route changes. No props removed from any existing card's public API.
- Consumer-flow walkthrough (per migrated card):
  - `api-key-manager.tsx` reads `inactiveKeys.length` for `count`, owns `showInactive` state, and passes the existing `<KeyRow inactive>` rows as `children`. Removes the bespoke `<button onClick=...>` + `<ChevronDown>` JSX block (current lines ~380-404).
  - `operator-token-card.tsx` reads `inactiveTokens.length`, owns `showInactiveTokens` (or whatever the existing local state is named — preserved verbatim), passes the existing `<TokenRow>` rows as `children`. Replaces the existing `<Collapsible>` block (current lines ~371-389) with `<InactiveItemsSection>`.
  - `mcp-client-card.tsx` reads `inactiveClients.length`, owns its existing `showInactive` boolean, passes the existing client-row rendering as `children`. Replaces the `<Collapsible>` block.
  - `service-account-card.tsx` reads its `inactiveServiceAccounts.length` (or equivalent), owns `showInactiveSa`, passes existing rows as `children`. Replaces the `<Collapsible>` block.
  - `base-webhook-card.tsx` reads inactive-webhooks length, owns the toggle state, passes existing rows. Replaces the existing toggle markup (currently bespoke).
  - `audit-delivery-target-card.tsx` (verified path: `src/components/settings/developer/audit-delivery-target-card.tsx`) reads inactive-target length, owns its existing toggle state, passes existing rows. Replaces the existing toggle markup.
  - `team-scim-token-manager.tsx` reads inactive-token length, owns its existing `showInactive`-shaped state, passes existing rows. Replaces the existing toggle markup. Note: this card's PATH is under `src/components/team/security/` but it operates on TENANT-scoped SCIM tokens (route is `POST /api/tenant/scim-tokens`, namespace is `Team` — both authorities are tenant-level). Path-based "team-scoped" reading is incorrect; do not extend this card with team-scoped-only logic. The helper has no scope assumption, so the migration is mechanical. Component relocation to a tenant-scoped directory is out of scope for this plan.

### C2. Search field placement policy (no new search fields added)

- Subject: A written policy gates which cards may have a search field. No card gains a new search field as part of this plan.
- Function/module signatures: N/A (policy-only contract, no code surface).
- Invariants:
  - The plan documents the three-rule gate (no theoretical upper bound; server-side query already supported; primary discovery use case).
  - The plan explicitly grandfathers `passkey-credentials-card`'s client-side search as a documented exception.
  - The plan explicitly notes that `tenant-audit-log-card`'s search remains unchanged.
  - Future PRs that add a search field to a settings card must reference this plan's C2 in the PR body and either match the gate or document why the gate does not apply.
- Forbidden patterns: N/A (policy-only).
- Acceptance criteria:
  - No diff to any card's search-field code under this plan.
  - Plan's "Search field policy" section is the single point of reference future contributors cite.

### C3. Separator placement policy (documented, not enforced)

- Subject: A written policy describing when a `<Separator />` between CTA row and list is appropriate. This contract intentionally does NOT migrate any existing card.
- Function/module signatures: N/A (policy-only).
- Invariants:
  - Plan documents the three conditions (CTA + non-trivial list + read-only context above CTA + visual merge risk) under which a separator is appropriate.
  - Existing card layouts are not modified.
- Forbidden patterns: N/A.
- Acceptance criteria:
  - No diff under this plan.
  - Future cards adopting a separator cite C3.

### C4. No new i18n keys; caller-supplied label

- Subject: The helper does not introduce any new i18n keys. Each migrated card passes its existing per-namespace translated label as `triggerLabel`.
- Function/module signatures:
  - The helper accepts `triggerLabel: ReactNode` (required prop). No optional default. No internal `useTranslations` call.
- Invariants:
  - Zero new entries in `messages/en/**` or `messages/ja/**`.
  - Each migrated card continues to use its existing per-feature i18n namespace and its existing key (resolved at plan-time by reading `useTranslations(...)` declarations in each file and confirming key presence in `messages/en/<Namespace>.json`):

    | Card | `useTranslations(...)` namespace | Key | Source file |
    |------|----------------------------------|-----|-------------|
    | `api-key-manager.tsx` | `ApiKey` | `inactiveKeys` | `messages/{en,ja}/ApiKey.json` |
    | `operator-token-card.tsx` | `OperatorToken` | `inactiveTokens` | `messages/{en,ja}/OperatorToken.json` |
    | `mcp-client-card.tsx` | `MachineIdentity` | `mcpInactive` | `messages/{en,ja}/MachineIdentity.json` |
    | `service-account-card.tsx` | `MachineIdentity` | `saInactive` | `messages/{en,ja}/MachineIdentity.json` |
    | `audit-delivery-target-card.tsx` | `AuditDeliveryTarget` | `inactiveTargets` | `messages/{en,ja}/AuditDeliveryTarget.json` |
    | `team-scim-token-manager.tsx` | `Team` | `scimInactiveTokens` | `messages/{en,ja}/Team.json` |
    | `base-webhook-card.tsx` | dynamic via existing `i18nNamespace` prop (`TenantWebhook` or `TeamWebhook`) | `inactiveWebhooks` | `messages/{en,ja}/TenantWebhook.json` AND `messages/{en,ja}/TeamWebhook.json` (dual-namespace because the card is reused for both tenant and team scopes — `inactiveWebhooks` exists in both) |

  - Visible-text wording across all 7 cards remains byte-identical to the pre-migration UI in both en and ja.
- Forbidden patterns:
  - `pattern: useTranslations\(.*inactiveSection — reason: helper does not own a translation namespace`
  - `pattern: messages/(en|ja)/InactiveSection\.json — reason: no helper-specific namespace file is created`
- Acceptance criteria:
  - `git diff messages/` shows no additions under this plan's scope.
  - `npx vitest run src/i18n/messages-consistency.test.ts` continues to pass (no new parity risk).
  - Each migrated card's pre-migration trigger-label rendering is preserved verbatim, only relocated from the inline JSX block into the helper's `triggerLabel` prop.

### C5. Helper unit tests + migrated-card test selector strategy

- Subject: The helper has its own unit tests that exercise collapse semantics with the real Radix primitive. Migrated cards' tests continue to locate the trigger by visible text (the same strategy the existing tests already use).
- Function/module signatures: N/A (tests only).
- Invariants:
  - The helper has its own unit-test file covering 6 cases:
    - (a) Renders `triggerLabel` content as the trigger's accessible name verbatim (passed `<>Inactive (3)</>`, the trigger text reads "Inactive (3)").
    - (b) Clicking the trigger fires `onOpenChange(true)` when `open={false}`, and `onOpenChange(false)` when `open={true}`.
    - (c) `aria-expanded` reflects `open`; `aria-controls` references the content region's generated id.
    - (d) When `open={false}`, the children's child-marker element is `not.toBeInTheDocument()` (Radix `Collapsible` does NOT render `<CollapsibleContent>` children when closed — it short-circuits via `isOpen && children`, so `toBeVisible()` would throw on a null element; the correct assertion is `not.toBeInTheDocument()`). When `open={true}`, the marker IS in the document and visible. This concretely tests the controlled-open contract.
    - (e) Clicking the trigger when `open={false}` does NOT internally toggle visibility — the helper waits for the parent to re-render with `open={true}` before showing children. This guards against a future regression that turns the helper uncontrolled.
    - (f) The helper does NOT wrap `children` in an additional `<ul>`, `<ol>`, or any element with `role="list"` (assertion: query the rendered DOM for any list-role ancestor of a child marker that did not exist in the original `children` tree).
  - The helper's own tests MUST use the real `@/components/ui/collapsible` primitives (NO mock). Mocking the primitive in the helper's own test would defeat the test's purpose.
  - Migrated cards' existing tests continue to use `getByText(/<i18n-key-or-localized-text>/)` (the same strategy already in use, e.g. `mcp-client-card.test.tsx:357` uses `getByText(/mcpInactive/)`). They do NOT need to switch to a new selector style; the helper preserves the visible-text strategy.
  - Migrated cards MAY have a new "auto-expand on quota saturation" assertion if the pre-migration card had that behavior (per F-8: `base-webhook-card.tsx:234-238` has a `useEffect` that sets `open=true` when quota is saturated; the migration must preserve this and the test must keep covering it).
- Forbidden patterns:
  - `pattern: vi\.mock\(["']@/components/settings/shared/inactive-items-section["'] — reason: card tests MUST NOT stub the helper as a render-through component; doing so would mask the very collapse semantics the helper centralizes`
- Acceptance criteria:
  - `src/components/settings/shared/inactive-items-section.test.tsx` covers cases (a) through (f).
  - The 7 migrated cards' existing `*.test.tsx` files pass after Phase 4 changes. The expected change shape per file (verified against current test bodies at implementation time; this list is best-effort plan-time classification):
    - **Mechanical-only stub removal** — test body never reads inactive content, so removing the render-through `vi.mock("@/components/ui/collapsible", ...)` stub is sufficient. Examples: `operator-token-card.test.tsx`.
    - **Stub removal + helper click already present** — test already clicks the inactive trigger by visible text, so it works post-stub-removal. Example: `mcp-client-card.test.tsx` (uses `screen.getByText(/mcpInactive/)` then clicks).
    - **Stub removal + new click-to-expand step required** — test reads inactive content via `getByText(...)` without first clicking the trigger; the stub previously rendered children unconditionally. After stub removal, the test must add a click on the helper trigger before the existing assertion. Example: `service-account-card.test.tsx:459-484` (`getByText("inactive-sa")` requires a preceding click).
    - **No-op on mount + auto-expand path** — `base-webhook-card.test.tsx` and its factory `webhook-card-test-factory.tsx:777-819`: the auto-expand `useEffect` drives `open=true` so children render automatically — no explicit click needed; only stub removal applies.
    - **Resolved at implementation time** — `api-key-manager.test.tsx`, `audit-delivery-target-card.test.tsx`, `team-scim-token-manager.test.tsx`: classification confirmed by reading the test body during Phase 4. The implementer logs which bucket each lands in via the deviation log.
  - For `base-webhook-card.test.tsx` and its factory `src/components/__tests__/webhook-card-test-factory.tsx` (auto-expand assertion currently lives at lines ~777-819 of the factory): the existing test covering "when active webhooks fill the quota AND inactiveWebhooks.length > 0 → inactive section auto-expands" must continue to pass. After stub removal, the assertion shape changes from "inactive row is rendered (because stub render-through always shows it)" to "inactive row is in the document because the controlled `open=true` from the `useEffect` causes `<CollapsibleContent>` to render its children." Concretely: the test must keep the `useEffect`-trigger condition setup (active count = MAX_WEBHOOKS, inactive count > 0), and the assertion must verify `getByText(/<inactive-webhook-name>/)` resolves without an explicit click (the auto-expand drives the open-state).
- Consumer-flow walkthrough:
  - `inactive-items-section.test.tsx` mounts `<InactiveItemsSection triggerLabel="Inactive (3)" open={false} onOpenChange={mock}>...</InactiveItemsSection>`, asserts content is hidden, clicks the trigger, asserts `mock` was called with `true`, then re-renders with `open={true}` and asserts content is now visible.
  - Each migrated card's test reads the trigger by `getByText(/...inactive.../i)` (or the existing per-card selector — preserved verbatim where possible) and exercises toggle via the helper's surface.

### C6. E2E (Playwright) compatibility

- Subject: Existing Playwright specs that interact with inactive-toggle UI continue to work after the migration. The Playwright spec directory is `e2e/tests/`.
- Function/module signatures: N/A (E2E specs).
- Invariants:
  - Enumerate dependencies via:
    - `git grep -nE "[Ii]nactive|showInactive" e2e/tests/`
    - `git grep -nE "(api-key|operator-token|mcp-client|service-account|webhook|audit-delivery|scim-token)" e2e/tests/`
  - For each match in a settings-related spec, classify whether the locator depends on the trigger label. Visible-text locators (`getByText(/Inactive/i)` or locale-specific) survive because each card preserves its existing translation key.
- Forbidden patterns: N/A (no over-fitted aria-label patterns; the helper does not introduce any aria-label that would break specs).
- Acceptance criteria:
  - Plan-time enumeration recorded the candidate set: `e2e/tests/settings-api-keys.spec.ts` is the most likely consumer; other specs are checked at implementation time.
  - Affected specs (enumerated and confirmed during Phase 4) pass locally after the migration.
  - If a spec touches the migrated cards but does not interact with the inactive toggle, it is recorded as "no migration impact" in the deviation log without code changes.
- Consumer-flow walkthrough:
  - During Phase 4, run the two greps above and produce a table of (spec file, locator, dependency-on-helper). For each row, classify as "unaffected" (no inactive-toggle interaction) or "needs verification" (interacts with the toggle). The verification step runs the spec locally and reports pass/fail.

## Migration Order

### Phase 1 — Helper + tests (single commit)

- Add `src/components/settings/shared/inactive-items-section.tsx`.
- Add `src/components/settings/shared/inactive-items-section.test.tsx`.
- No new i18n keys (per C4 — caller owns the label).
- No card migrations yet. `pre-pr.sh` passes; helper is unused but compiled and tested.

### Phase 2 — Migrate the four "raw Collapsible" cards (single commit)

- `operator-token-card.tsx`
- `mcp-client-card.tsx`
- `service-account-card.tsx`
- `team-scim-token-manager.tsx`

These four already use shadcn `Collapsible` directly (verified by grep); the migration is mostly a JSX swap (replace `<Collapsible>...</CollapsibleTrigger>...<CollapsibleContent>` with `<InactiveItemsSection>`). Lower risk first.

### Phase 3 — Migrate the three "bespoke chevron button" cards (single commit)

- `api-key-manager.tsx`
- `base-webhook-card.tsx`
- `audit-delivery-target-card.tsx`

These had a hand-rolled `<button>` + `<ChevronDown>` toggle; migrating them is where the largest a11y consistency win lands. Slightly higher risk because the bespoke patterns may have subtle behavior (e.g. focus-restore on collapse) — verified test-side.

### Phase 4 — Test + E2E sweep + commit

- For each migrated card's `*.test.tsx`: replace any pre-existing `vi.mock("@/components/ui/collapsible", ...)` render-through stub. The migrated card now renders `<InactiveItemsSection>` instead of raw `<Collapsible>`; `vi.mock("@/components/settings/shared/inactive-items-section", ...)` is FORBIDDEN by C5 (would mask collapse semantics). The card's tests should let the helper run with its real internals (the helper's own unit tests in `inactive-items-section.test.tsx` cover collapse semantics with the real Radix primitive — single source of truth).
- Sweep `e2e/tests/` for inactive-toggle locators (per C6 invariants). Update any spec whose locator depends on the now-removed bespoke markup.
- Run `scripts/pre-pr.sh` end-to-end.

### Branching / commit strategy clarification

All four phases land as **separate commits on the single feature branch `refactor/unify-settings-page-layout`**, opened as **one PR** after Phase 4 completes (per memory `feedback_pr_cadence_aggregate`). "Single commit" in each phase header refers to the commit count per phase, not per PR.

**Bisect-granularity trade-off:** Phase 2 (4 cards) and Phase 3 (3 cards) each migrate multiple cards in a single commit. This trades bisect-granularity for review-cohesion: a regression introduced in Phase 3 lands `git bisect` on a 3-card commit and requires manual narrowing to identify the offending card. Accepted trade-off because (i) each card's migration is mechanical (JSX-only swap), (ii) Phase 1 helper tests cover the core collapse semantics so per-card regressions are most likely visible-text or aria-* drift detectable by the card's own test, (iii) splitting to one-commit-per-card would inflate the PR's commit count from 4 to 11 with no proportional review value. If a regression DOES occur and bisect needs finer granularity, the offending phase can be reverted as a unit and re-applied per-card.

### Pre-existing auto-expand-on-quota-saturation behavior (verified at plan-time)

`src/components/settings/developer/base-webhook-card.tsx` (lines ~234-238) contains a `useEffect` that sets the local `showInactive` state to `true` when active webhook count saturates `MAX_WEBHOOKS` AND `inactiveWebhooks.length > 0`. This is an admin operational signal — "quota is full; review revoked items first." The migration MUST preserve this behavior:

- The card's `useEffect` continues to call `setShowInactive(true)` under the same condition.
- The `<InactiveItemsSection open={showInactive} ...>` wrapper receives the auto-set `open=true` and expands.
- The migrated card's test (or its factory test) MUST include an assertion that exercises this code path, per C5. Without explicit coverage, a future test simplification could drop the regression coverage.

**Implementation note — "on mount" wording:** The acceptance bullet in C5 says the auto-expand fires "on mount", which is shorthand for "after the data fetch resolves AND the effect re-runs with `webhooks.length === MAX_WEBHOOKS`". Do NOT translate this to a `useState(initial)` initializer — the effect is data-dependent (active count comes from the fetched webhook list), so an initial-state shortcut would either be wrong (no data yet at mount) or require duplicating the saturation check at the initial-fetch handler. Keep the existing `useEffect` shape; only the wrapped JSX changes.

### Audit step (gate before Phase 1)

Before adding the helper, run the following greps from the repo root and reconcile any new matches against the C1 migration list:

```
git grep -l "showInactive\|showInactiveSa\|showInactiveTokens\|showRevoked\|showExpired" src/components/
git grep -ln "import.*Collapsible" src/components/settings src/components/team
git grep -ln "ChevronDown" src/components/settings src/components/team
```

If a new card matches and renders a card-internal active/inactive toggle with the C1 shape, add it to the migration list before starting Phase 1. If a match is unrelated (e.g. `section-nav.tsx`'s ChevronDown is for navigation, not for inactive-toggle), record the false positive in the deviation log and proceed.

Verified at plan-time: `section-nav.tsx` is navigation chevron; `operator-token-card.test.tsx` is the test file for an in-list card. Neither is a migration target.

### Out of scope for this plan

- `passkey-credentials-card` keeps its inline `<Badge>` pattern and its client-side search (documented in Search field policy and List density rule).
- `sessions-card` keeps its inline `<Badge>` pattern (documented in List density rule).
- No header-component refactor; `SectionCardHeader` remains the spine post-#456.
- No `SectionLayout` changes; SectionLayout is page-level and is correctly scoped.
- No new search field added to any card.
- No `<Separator />` added or removed.

## Testing Strategy

- Helper unit tests: `src/components/settings/shared/inactive-items-section.test.tsx` (6 cases (a)-(f) listed in C5).
- Migrated-card unit tests: assertion-only updates, no new test coverage required (existing tests were already covering the behavior; only the locator changes).
- Locale parity: `npm run check:env-docs` (existing pre-pr check) verifies en/ja shape parity for the new i18n keys.
- Lint / build: `npm run lint`, `npx next build`.
- Playwright: enumerate during implementation; update affected specs.
- Mandatory checks before commit: `npx vitest run` and `npx next build` per CLAUDE.md.

## Considerations & Constraints

- Per memory `feedback_subagent_findings_essence_filter`, the helper is intentionally minimal — controlled, no extra a11y scaffolding beyond what shadcn `Collapsible` already provides. Sub-agents may flag missing role attributes or focus-trap logic; those are speculative defensive scaffolding and should be downgraded unless a concrete a11y test fails.
- Per memory `feedback_e2e_aria_label_phantom_match`, when migrating, do NOT trust that `getByRole("button", { name: /inactive/i })` still resolves uniquely — also check assertion-side: any `expect(toggle).toHaveAttribute("aria-controls", ...)` that referenced the bespoke id MUST move to the helper's generated id.
- Per memory `feedback_no_internal_jargon_in_user_strings`, the helper's default label uses end-user language ("Inactive (3)" / "無効 (3)"), not internal terms ("Revoked", "Tombstoned").
- Per memory `feedback_ja_vault_translation`, the Japanese label uses 「無効」 (or 「失効済み」 if the card has a stronger lifecycle distinction); never カタカナ.
- This plan deliberately does NOT touch route handlers, audit emission, or permission checks. Sub-agents flagging those as missing should consider them out of scope.
- Per memory `feedback_pr_cadence_aggregate`, all four phases land on `refactor/unify-settings-page-layout` with one PR after Phase 4 completes. No per-phase PR.

## User Operation Scenarios

1. Tenant admin opens API Keys, sees the active list and an "Inactive (3)" trigger below it; clicks the trigger, the inactive list expands; clicks again, it collapses. Keyboard tab + Enter / Space toggles. Screen reader announces "Inactive 3, button, collapsed/expanded".
2. Tenant admin opens MCP Clients, sees the active client list. Inactive trigger looks identical to the API Keys card. Same gesture, same accessible name format, same chevron rotation.
3. Tenant admin opens Webhooks, sees the active webhook list. Same inactive trigger UI.
4. Tenant admin opens Operator Tokens. Same UI.
5. Tenant admin opens Service Accounts. Same UI.
6. Tenant admin opens Audit Delivery Targets. Same UI (assuming the card lives where the survey indicated; if not, the deviation log records the path resolution at implementation time).
7. Personal user opens Passkeys, sees every passkey including revoked, each with a status `<Badge>`. No inactive trigger — the rule explicitly preserves the badge pattern here.
8. Personal user opens Sessions, sees current and recent sessions inline with badges. No inactive trigger.
9. Tenant admin opens Audit Log, uses the existing search filter — unchanged from #456 state.

## Out-of-Scope (explicit)

- Header refactoring (`SectionCardHeader` redesign).
- `SectionLayout` page-level changes.
- New search fields on any card.
- Pagination / virtualization changes.
- Removing existing `<Separator />` instances.
- Vault / passwords main UI under `src/components/vault/**` and `src/components/passwords/**`.
- Route handler changes.
- i18n key reorganization beyond the new helper keys.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Shared inactive-items collapsible helper | locked |
| C2 | Search field placement policy (no new fields added) | locked |
| C3 | Separator placement policy (documented, not enforced) | locked |
| C4 | No new i18n keys; caller-supplied label | locked |
| C5 | Helper unit tests + migrated-card test selector strategy | locked |
| C6 | E2E (Playwright) compatibility | locked |

All six contracts are locked after Round 2. Round 1 review caught wrong i18n parity script, wrong namespace structure, wrong e2e path, and a test-mock false-positive class; Round 2 caught remaining i18n namespace mapping errors (3 of 7 cards), residual scope-mislabel, and a wrong assertion shape. All resolved.
