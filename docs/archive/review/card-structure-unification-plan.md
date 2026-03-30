# Plan: Card Structure Unification

## Objective

Unify the internal structure of card components across personal settings, tenant admin, and team admin pages to follow a consistent `Card > CardHeader(CardTitle + CardDescription) > CardContent` pattern. Also add a new MCP Connections page to the personal settings developer section.

**Guiding principle: "1 page = 1 card"** — Every page renders a single card component inside a `SectionLayout` wrapper. The card component owns the `<Card>` wrapper; pages just render `<CardComponent />`.

## Requirements

### Functional
- All card components must use shadcn Card/CardHeader/CardTitle/CardDescription/CardContent
- Each card must have an icon in the title, a title, and a description
- Cards with multiple sections (create form + list) use a single wrapping Card with Separator between sections
- No changes to component props or external API (except where the Card wrapper moves from page to component)
- Components remain self-contained and reusable across contexts
- New MCP Connections page: read-only list of authorized MCP clients with revoke capability

### Non-functional
- All tests must pass (`npx vitest run`)
- Production build must succeed (`npx next build`)
- i18n keys must exist in both en and ja translation files simultaneously (`messages-consistency.test.ts` enforces cross-locale alignment)

## Technical Approach

### Reference Pattern (from existing codebase)

Based on `travel-mode-card.tsx`, `directory-sync-card.tsx`, and `passkey-credentials-card.tsx`:

```tsx
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

<Card>
  <CardHeader>
    <div className="flex items-center gap-2">
      <SomeIcon className="h-5 w-5" />
      <CardTitle>{t("title")}</CardTitle>
    </div>
    <CardDescription>{t("description")}</CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    {/* content */}
  </CardContent>
</Card>
```

For multi-section cards (webhooks, API keys):
```tsx
<Card>
  <CardHeader>
    <div className="flex items-center gap-2">
      <Icon className="h-5 w-5" />
      <CardTitle>{t("title")}</CardTitle>
    </div>
    <CardDescription>{t("description")}</CardDescription>
  </CardHeader>
  <CardContent className="space-y-6">
    <section className="space-y-4">
      <h3 className="text-sm font-medium">{t("createSectionTitle")}</h3>
      {/* form fields */}
    </section>
    <Separator />
    <section className="space-y-4">
      <h3 className="text-sm font-medium">{t("listSectionTitle")}</h3>
      {/* item list */}
    </section>
  </CardContent>
</Card>
```

## Implementation Steps

### Step 1: Add missing i18n keys

Add translation keys to **both** `messages/en/*.json` and `messages/ja/*.json` simultaneously:

| Namespace file | Keys to add |
|---------------|-------------|
| MachineIdentity.json | `saCardTitle`, `saCardDescription`, `mcpCardTitle`, `mcpCardDescription`, `accessRequestCardTitle`, `accessRequestCardDescription` |
| McpConnections.json | New namespace: `title`, `description`, `clientName`, `scopes`, `lastUsed`, `expires`, `revoke`, `revokeConfirm`, `noConnections`, `noConnectionsDescription` |

Keys that already exist and can be reused (no new keys needed):
- **Sessions**: `title`, `description` (already exist — reuse directly)
- **TeamPolicy**: `title`, `description` (already exist)
- **Team**: `rotateKeyTitle`, `rotateKeyDesc` (already exist — reuse for card title/description)

### Step 2: Priority 1 — Missing CardHeader pattern (5 files)

These all currently use `<Card className="p-6 space-y-N">` with manual h2/h3 titles.

1. **service-account-card.tsx**: Replace `<Card className="p-6 space-y-4">` with Card>CardHeader>CardContent. Convert `<h3>` to CardTitle with icon. Add CardDescription. Move content to CardContent.

2. **mcp-client-card.tsx**: Same transformation. Convert `<h3>` flex header to CardHeader with CardTitle and action button.

3. **access-request-card.tsx**: Same transformation. Convert `<h3>` flex header (with Select filter and create button) to CardHeader.

4. **cli-token-card.tsx**: Replace `<Card className="p-6 space-y-4">` and manual `<h2>` section with CardHeader/CardTitle/CardDescription. Move remaining sections into CardContent.

5. **api-key-manager.tsx**: Replace `<Card className="p-6 space-y-6">` and manual `<h2>` section. Convert border-t section dividers to Separator. Move content into CardContent.

### Step 3: Priority 2 — Multiple cards → single card (2 files)

6. **tenant-webhook-card.tsx**: Replace outer `<div className="space-y-4">` wrapping two Cards with a single Card. Add CardHeader with title/description. Merge the two Card contents into a single CardContent with Separator between create form and list sections.

7. **team-webhook-card.tsx**: Same transformation as tenant-webhook-card.

### Step 4: Priority 3 — Missing title/description (3 files)

8. **sessions-card.tsx**: Currently a Fragment containing a bare Card with `divide-y`. Add CardHeader (reuse existing `title`/`description` i18n keys from Sessions namespace) and move session list into CardContent. Keep divide-y on the list container, not the Card.

9. **team-rotate-key-button.tsx**: Currently just a Button + AlertDialog with no Card wrapper. The page (`key-rotation/page.tsx`) currently has inline Card JSX wrapping this component. Move the Card wrapper INTO the component (CardHeader with icon + `rotateKeyTitle`/`rotateKeyDesc` i18n keys + CardContent with the button). Update the page to just render `<TeamRotateKeyButton teamId={teamId} />` without any Card wrapper.

10. **team-policy-settings.tsx**: Currently uses `<Card className="... p-4">` with manual `<h2>` and description. Convert to CardHeader/CardTitle/CardDescription + CardContent. Keep existing Separator usage inside CardContent.

### Step 5: Priority 4 — Audit log card cleanup (1 file)

11. **tenant-audit-log-card.tsx**: Currently a Tabs component. Remove the Tabs wrapper since sub-routes handle navigation. The component should accept a `variant` prop (`"logs"` or `"breakglass"`) and render a single Card with proper CardHeader for each variant. Explicitly:
    - Remove the `variant="all"` code path (dead code — no caller uses it)
    - Remove Tabs/TabsList/TabsContent/TabsTrigger imports
    - Remove unused i18n keys (`subTabTenantLogs`, `subTabBreakglass`) from translation files if no other component uses them

### Step 6: New — MCP Connections page

12. **mcp-connections-card.tsx** (NEW): Create `src/components/settings/mcp-connections-card.tsx`:
    - Fetches user's active MCP client connections (OAuth consents)
    - Shows client name, authorized scopes, last used, expiration
    - Allows revoking individual connections
    - Follows target Card pattern with CardHeader/CardTitle/CardDescription/CardContent
    - API: Use existing `/api/vault/delegation` endpoint or create a new read-only endpoint for user's MCP token list

13. **connections/page.tsx** (NEW): Create `src/app/[locale]/dashboard/settings/developer/connections/page.tsx` rendering `<McpConnectionsCard />`

14. **settings/layout.tsx**: Add nav item for "Connections" to the developer section tree nav

### Step 7: Update test mocks (5 test files)

Update `vi.mock("@/components/ui/card", ...)` in these test files to export `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` as passthrough wrappers (matching the existing `Card` mock pattern). Add `@/components/ui/separator` mock where Separator is newly used.

| Test file | Affected by step |
|-----------|-----------------|
| `src/components/settings/service-account-card.test.tsx` | Step 2 |
| `src/components/settings/mcp-client-card.test.tsx` | Step 2 |
| `src/components/settings/access-request-card.test.tsx` | Step 2 |
| `src/components/settings/tenant-webhook-card.test.tsx` | Step 3 |
| `src/components/team/team-webhook-card.test.tsx` | Step 3 |

Reference pattern: `tenant-members-card.test.tsx` mock implementation.

### Step 8: Update page files with inline Card wrappers

For pages that currently wrap card components in inline Card JSX, remove the page-level Card and ensure the component itself provides the Card. Files to check:

| Page file | Component | Action |
|-----------|-----------|--------|
| `src/app/[locale]/admin/teams/[teamId]/security/key-rotation/page.tsx` | TeamRotateKeyButton | Remove inline Card wrapper (moved to component in Step 4) |
| `src/app/[locale]/admin/tenant/security/webhooks/page.tsx` | TenantWebhookCard | Remove page-level Card wrapper if exists (component provides Card in Step 3) |
| `src/app/[locale]/admin/teams/[teamId]/security/webhooks/page.tsx` | TeamWebhookCard | Same |

## Testing Strategy

- Run `npx vitest run` after each priority group
- Run `npx next build` after all changes
- Visual verification: Every card should follow the target layout pattern
- No snapshot tests exist for these components, so structural changes are safe

## Considerations & Constraints

- **"1 page = 1 card" principle**: Card component owns `<Card>` wrapper; pages just render `<CardComponent />`
- **Icon selection**: Use existing icons already imported in each component where possible; add appropriate lucide-react icons where needed
- **CardHeader spacing**: The standard CardHeader provides built-in padding; remove manual `p-6` from Card when adding CardHeader (CardHeader and CardContent provide their own padding)
- **Action buttons in headers**: For cards with action buttons next to the title (service-account, mcp-client, access-request), use a flex wrapper in CardHeader similar to directory-sync-card pattern
- **tenant-audit-log-card variant prop**: The `variant` prop must still be supported to switch between logs and breakglass views (but `variant="all"` is dead code and should be removed)
- **Test mock updates mandatory**: All test files with `vi.mock("@/components/ui/card")` must be updated to include new Card sub-component exports
- **MCP Connections API**: Investigate whether `/api/vault/delegation` provides sufficient data or if a new endpoint is needed

## User Operation Scenarios

1. **Admin viewing tenant settings**: Each card in `/admin/tenant/*` pages renders with consistent icon+title+description headers
2. **Team admin viewing team settings**: Same consistency in `/admin/teams/[teamId]/*` pages
3. **User viewing personal settings**: Every sub-route (account, security/*, developer/*) renders a single self-contained card
4. **Key rotation flow**: TeamRotateKeyButton now owns its Card wrapper; AlertDialog confirmation flow unchanged
5. **Webhook creation**: The merged single-Card webhook view allows creating and viewing webhooks with clear Separator between sections
6. **MCP Connections**: User navigates to Developer > Connections, sees authorized MCP clients, and can revoke connections
