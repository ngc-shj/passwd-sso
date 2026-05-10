# Plan Review: unify-settings-page-layout

Date: 2026-05-10
Review rounds: 3 (Round 3 closes with "No findings" from all three experts)

---

## Round 1 — Initial Review

### Functionality Findings

#### F-1 [Major] C4 cites wrong i18n parity enforcement script
Plan claimed `npm run check:env-docs` enforces i18n parity; actual gate is `src/i18n/messages-consistency.test.ts`. **Resolved** in Round 2 plan update.

#### F-2 [Major] C4 i18n namespace structure does not match the repo
Plan assumed single-file `messages/en.json` with dotted namespace; actual layout is per-namespace files `messages/{en,ja}/{Namespace}.json`. **Resolved** by C4 rewrite to "no new keys / caller owns label".

#### F-3 [Major] C6 / Phase 4 reference wrong Playwright spec directory
`tests/e2e/` does not exist; actual is `e2e/tests/`. **Resolved** in Round 2.

#### F-4 [Minor] "Why controlled" rationale overstates filter dependency
Plan claimed `showInactive` reused for filter logic; only used for chevron rotation + conditional render. **Resolved** by simplifying the rationale.

#### F-5 [Minor] Helper file location does not match migration target locations
Helper at `settings/account/`; targets at `settings/developer/` + `team/security/`. **Resolved** by relocating to `settings/shared/`.

#### F-6 [Minor] Phase 2/3 commit granularity trade-off undocumented
**Resolved** by adding bisect-granularity tradeoff documentation.

### Security Findings

#### F-7 [Minor] team-scim-token-manager mislabeled as team-scoped
Component operates on tenant-wide SCIM tokens. **Resolved** by acceptance-bullet clarification (residual mislabel in walkthrough flagged + fixed in Round 2 as F-16).

#### F-8 [Minor] base-webhook-card auto-expand-on-quota-saturation not enumerated
`base-webhook-card.tsx:234-238` `useEffect` auto-expands on quota saturation. **Resolved** by adding contract obligation under "Pre-existing auto-expand-on-quota-saturation behavior".

### Testing Findings

#### F-9 [Major] C5 / C1 forbidden patterns target nonexistent selectors
`getByRole({name: /show inactive/i})` and `aria-label="Show inactive..."` patterns do not exist in the codebase. **Resolved** by dropping the over-fitted patterns; keeping the legitimate ones (bespoke chevron + raw Collapsible).

#### F-10 [Major] Existing Collapsible mocks bypass `open` — migration would inherit false-positive
Render-through `vi.mock("@/components/ui/collapsible"...)` stubs in 3 test files mask collapse semantics. **Resolved** by adding C5 invariant: helper's own tests use real Radix; migrated cards remove the stub in Phase 4; the helper itself must NOT be mocked as render-through.

#### F-11 [Major] Helper unit-test coverage misses controlled-open and triggerLabel override
**Resolved** by expanding C5 to 6 cases including (e) controlled-open contract and (f) triggerLabel override.

#### F-12 [Minor] Locale parity check script reference incorrect
Same root cause as F-1; resolved together.

### Adjacent Findings

- Render-through mock implicitly drifts type from real shadcn typing (Security → Functionality)
- `mcp-client-card.test.tsx:357` uses i18n KEY name as selector — fragile but survives migration (Testing → Functionality)
- After migration, per-card Collapsible mocks become "mocking the helper's internal primitive" (Testing → Functionality)

---

## Round 2 — Incremental Review

### Functionality Findings

#### F-13 [Major] Round 1 i18n namespace mapping was wrong on three of seven cards
- `mcpInactive` lives in `MachineIdentity.json`, not `McpClient.json`
- `saInactive` lives in `MachineIdentity.json`, not `ServiceAccount.json`
- `scimInactiveTokens` lives in `Team.json`, not `ScimToken.json`
- `inactiveWebhooks` is dual-namespace (`TenantWebhook.json` + `TeamWebhook.json`)

**Resolved** by replacing C4 invariants with a verified mapping table:

| Card | Namespace | Key | Source file |
|------|-----------|-----|-------------|
| api-key-manager | ApiKey | inactiveKeys | ApiKey.json |
| operator-token-card | OperatorToken | inactiveTokens | OperatorToken.json |
| mcp-client-card | MachineIdentity | mcpInactive | MachineIdentity.json |
| service-account-card | MachineIdentity | saInactive | MachineIdentity.json |
| audit-delivery-target-card | AuditDeliveryTarget | inactiveTargets | AuditDeliveryTarget.json |
| team-scim-token-manager | Team | scimInactiveTokens | Team.json |
| base-webhook-card | dynamic via `i18nNamespace` prop | inactiveWebhooks | TenantWebhook.json + TeamWebhook.json |

#### F-14 [Minor] "on mount" wording for webhook auto-expand could mislead
**Resolved** by clarifying the useEffect must remain data-dependent, not a useState initializer.

#### F-15 [Minor] Stale references in Testing Strategy section
**Resolved** — updated path to `settings/shared/` and count to "6 cases (a)-(f)".

### Security Findings

#### F-16 [Minor] C1 consumer-flow walkthrough still labels team-scim-token-manager "(team-scoped)"
Round 1 F-7 fixed only the acceptance bullet; the walkthrough re-opened the same scope-confusion vector. **Resolved** by clarifying PATH vs SCOPE distinction explicitly.

### Testing Findings

#### F-17 [Minor] C5 case (d) `toBeVisible()` assertion is wrong vs. Radix internals
Radix `Collapsible` short-circuits via `isOpen && children`; closed-state children are not rendered at all. **Resolved** by changing assertion to `not.toBeInTheDocument()`.

#### F-18 [Major] service-account-card test will break after Phase 4 stub removal
Test reads `getByText("inactive-sa")` without a preceding click; works only because of the render-through stub. **Resolved** by adding per-test-file classification to C5 acceptance:
- Mechanical-only stub removal (test never reads inactive content)
- Stub removal + helper click already present
- Stub removal + new click-to-expand step required (service-account-card.test.tsx is in this bucket)
- Auto-expand-driven (base-webhook-card)
- Resolved-at-implementation-time (api-key-manager, audit-delivery-target-card, team-scim-token-manager)

#### F-19 [Minor] Phase 4 wording should distinguish mechanical-only vs change-required tests
**Resolved** together with F-18.

---

## Round 3 — Convergence Verification

All three experts returned **"No findings"**.

### Functionality

Verified:
- C4 namespace mapping table accurate against `ls messages/en/`.
- "On mount" clarification at the auto-expand subsection.
- Testing Strategy uses `settings/shared/` and "6 cases (a)-(f)".
- C5 per-test-file classification has 5 internally-consistent buckets with no contradictory double-listing.

### Security

Verified:
- C1 walkthrough now reads "PATH is under `team/security/` but operates on TENANT-scoped SCIM tokens" — explicit path/scope distinction.
- `mcpInactive` and `saInactive` pre-exist in `messages/en/MachineIdentity.json` (no new key additions).
- C5 helper-mock forbidden pattern unchanged.
- Auto-expand operational signal preserved (data-dependent useEffect retained).

### Testing

Verified:
- C5 case (d) uses `not.toBeInTheDocument()`.
- `service-account-card.test.tsx:459-484` confirmed to use `getByText("inactive-sa")` without preceding click — correctly placed in "click-to-expand-required" bucket.
- Phase 4 and C5 agree on per-file change shape; auto-expand carved out for base-webhook-card.

---

## Final State

All six contracts are **locked** in the plan's Go/No-Go gate:

| ID | Subject | Status |
|----|---------|--------|
| C1 | Shared inactive-items collapsible helper | locked |
| C2 | Search field placement policy (no new fields added) | locked |
| C3 | Separator placement policy (documented, not enforced) | locked |
| C4 | No new i18n keys; caller-supplied label | locked |
| C5 | Helper unit tests + migrated-card test selector strategy | locked |
| C6 | E2E (Playwright) compatibility | locked |

Plan ready for Phase 2 (implementation) when the user gives the go-ahead.

## Quality Warnings

*No findings failed the quality checks across any round.*
