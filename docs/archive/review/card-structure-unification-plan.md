# Plan: Card Structure Unification

## Objective

Unify the internal structure of 11 card components across personal settings, tenant admin, and team admin pages to follow a consistent Card > CardHeader(CardTitle + CardDescription) > CardContent pattern. This ensures visual and structural consistency after the settings UI reorganization.

## Requirements

### Functional
- All card components must use shadcn Card/CardHeader/CardTitle/CardDescription/CardContent
- Each card must have an icon in the title, a title, and a description
- Cards with multiple sections (create form + list) use a single wrapping Card with Separator between sections
- No changes to component props or external API
- Components remain self-contained and reusable across contexts

### Non-functional
- All tests must pass (`npx vitest run`)
- Production build must succeed (`npx next build`)
- i18n keys must exist in both en and ja translation files

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
      <CardTitle>{t("cardTitle")}</CardTitle>
    </div>
    <CardDescription>{t("cardDescription")}</CardDescription>
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
      <CardTitle>{t("cardTitle")}</CardTitle>
    </div>
    <CardDescription>{t("cardDescription")}</CardDescription>
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

Add translation keys to **both** `messages/en/*.json` and `messages/ja/*.json` simultaneously (the `messages-consistency.test.ts` cross-locale alignment check will fail if keys are missing in either locale):

| Namespace file | Keys to add |
|---------------|-------------|
| MachineIdentity.json | `saCardTitle`, `saCardDescription`, `mcpCardTitle`, `mcpCardDescription`, `accessRequestCardTitle`, `accessRequestCardDescription` |

Keys that already exist and can be reused (no new keys needed):
- **Sessions**: `title`, `description` (already exist — reuse directly)
- **TeamPolicy**: `title`, `description` (already exist)
- **Team**: `rotateKeyTitle`, `rotateKeyDesc` (already exist, but see note: team-rotate-key-button is excluded from this plan)

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

### Step 4: Priority 3 — Missing title/description (2 files)

8. **sessions-card.tsx**: Currently a Fragment containing a bare Card with `divide-y`. Add CardHeader (reuse existing `title`/`description` i18n keys from Sessions namespace) and move session list into CardContent. Keep divide-y on the list container, not the Card.

~~9. **team-rotate-key-button.tsx**~~: **EXCLUDED** — The page file (`/src/app/[locale]/admin/teams/[teamId]/security/key-rotation/page.tsx`) already wraps this component in a Card with proper CardHeader. Adding another Card inside the component would create double-nesting.

9. **team-policy-settings.tsx**: Currently uses `<Card className="... p-4">` with manual `<h2>` and description. Convert to CardHeader/CardTitle/CardDescription + CardContent. Keep existing Separator usage inside CardContent.

### Step 5: Priority 4 — Audit log card cleanup (1 file)

10. **tenant-audit-log-card.tsx**: Currently a Tabs component. Remove the Tabs wrapper since sub-routes handle navigation. The component should accept a `variant` prop (`"logs"` or `"breakglass"`) and render a single Card with proper CardHeader for each variant. Explicitly:
    - Remove the `variant="all"` code path (dead code — no caller uses it)
    - Remove Tabs/TabsList/TabsContent/TabsTrigger imports
    - Remove unused i18n keys (`subTabTenantLogs`, `subTabBreakglass`) from translation files if no other component uses them

### Step 6: Update test mocks (5 test files)

Update `vi.mock("@/components/ui/card", ...)` in these test files to export `CardHeader`, `CardTitle`, `CardDescription`, `CardContent` as passthrough wrappers (matching the existing `Card` mock pattern). Add `@/components/ui/separator` mock where Separator is newly used.

| Test file | Affected by step |
|-----------|-----------------|
| `src/components/settings/service-account-card.test.tsx` | Step 2 |
| `src/components/settings/mcp-client-card.test.tsx` | Step 2 |
| `src/components/settings/access-request-card.test.tsx` | Step 2 |
| `src/components/settings/tenant-webhook-card.test.tsx` | Step 3 |
| `src/components/team/team-webhook-card.test.tsx` | Step 3 |

Reference pattern: `tenant-members-card.test.tsx` mock implementation.

## Testing Strategy

- Run `npx vitest run` after each priority group
- Run `npx next build` after all changes
- Visual verification: Every card should follow the target layout pattern
- No snapshot tests exist for these components, so structural changes are safe

## Considerations & Constraints

- **No prop changes**: Component external API must remain unchanged
- **Icon selection**: Use existing icons already imported in each component where possible; add appropriate lucide-react icons where needed
- **CardHeader spacing**: The standard CardHeader provides built-in padding; remove manual `p-6` from Card when adding CardHeader (CardHeader and CardContent provide their own padding)
- **Action buttons in headers**: For cards with action buttons next to the title (service-account, mcp-client, access-request), use a flex wrapper in CardHeader similar to directory-sync-card pattern
- **tenant-audit-log-card variant prop**: The `variant` prop must still be supported to switch between logs and breakglass views (but `variant="all"` is dead code and should be removed)
- **team-rotate-key-button excluded**: Already wrapped in Card at the page level — do not add another Card wrapper
- **Test mock updates mandatory**: All test files with `vi.mock("@/components/ui/card")` must be updated to include new Card sub-component exports

## User Operation Scenarios

1. **Admin viewing tenant settings**: Each card in `/dashboard/admin/tenant/*` pages should render with consistent icon+title+description headers
2. **Team admin viewing team settings**: Same consistency in `/dashboard/teams/[teamId]/settings/*` pages
3. **User viewing personal settings**: Sessions card and other personal settings cards follow the same pattern
4. **Key rotation flow**: Team rotate key button is now inside a Card, but the AlertDialog confirmation flow remains unchanged
5. **Webhook creation**: The merged single-Card webhook view still allows creating and viewing webhooks with clear visual separation
