# Task: Unify Card Component Internal Structure

## Background

The settings UI reorganization (branch `refactor/settings-ui-reorganization`) moved
all settings/admin pages to a new page-per-route structure with consistent `SectionLayout`.
However, the card components themselves have inconsistent internal structures inherited
from the original tabbed pages.

## Problem

18 card components used across personal settings, tenant admin, and team admin pages
have 6 different internal structure patterns:

| Pattern | Cards | Issue |
|---------|-------|-------|
| Card > CardHeader(Title+Desc) > CardContent | 8 | **Target pattern** — this is correct |
| Card > manual h2/h3 + p + content | 5 | Missing CardHeader/CardTitle/CardDescription |
| div > multiple Cards (create + list) | 2 | No single wrapping Card, no unified header |
| Tabs inside Card | 1 | Already split into sub-routes in the reorganization |
| Button only (no Card) | 1 | Needs Card wrapper |
| Card > divide-y (no header) | 1 | Missing title/description |

Specific issues:
1. **No description**: service-account, mcp-client, access-request, sessions, team-rotate-key-button
2. **Manual h2/h3 instead of CardTitle**: service-account, mcp-client, access-request, cli-token, api-key-manager, team-policy-settings
3. **Multiple cards where one is expected**: tenant-webhook-card, team-webhook-card (have separate "create form" Card and "registered list" Card with no wrapping Card)
4. **Sub-card structure varies**: Some use Separator between sections, some use multiple Cards, some use nothing

## Target Structure

Every card component should follow this pattern:

```tsx
<Card>
  <CardHeader>
    <CardTitle className="flex items-center gap-2">
      <SomeIcon className="h-5 w-5" />
      {t("title")}
    </CardTitle>
    <CardDescription>{t("description")}</CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    {/* Card-specific content */}
    {/* Use Separator between logical sections within a card */}
  </CardContent>
</Card>
```

For cards with "create form" + "list" sections (webhooks, API keys, etc.):

```tsx
<Card>
  <CardHeader>
    <CardTitle>...</CardTitle>
    <CardDescription>...</CardDescription>
  </CardHeader>
  <CardContent className="space-y-6">
    {/* Create/add section */}
    <section className="space-y-4">
      <h3 className="text-sm font-medium">...</h3>
      {/* form fields */}
    </section>
    <Separator />
    {/* List section */}
    <section className="space-y-4">
      <h3 className="text-sm font-medium">...</h3>
      {/* item list */}
    </section>
  </CardContent>
</Card>
```

## Cards to Modify

### Priority 1: Missing CardHeader pattern (use manual h2/h3)

| Component | File | Current | Change needed |
|-----------|------|---------|---------------|
| ServiceAccountCard | `src/components/settings/service-account-card.tsx` | Card.p-6 > h3 + text | Add CardHeader/Title/Desc, move content to CardContent |
| McpClientCard | `src/components/settings/mcp-client-card.tsx` | Card.p-6 > h3 + text | Same |
| AccessRequestCard | `src/components/settings/access-request-card.tsx` | Card.p-6 > h3 + text | Same |
| CliTokenCard | `src/components/settings/cli-token-card.tsx` | Card.p-6 > h2 + p | Same |
| ApiKeyManager | `src/components/settings/api-key-manager.tsx` | Card.p-6 > h2 + p | Same |

### Priority 2: Multiple cards → single card with Separator

| Component | File | Current | Change needed |
|-----------|------|---------|---------------|
| TenantWebhookCard | `src/components/settings/tenant-webhook-card.tsx` | div > Card(create) + Card(list) | Wrap in single Card with CardHeader, use Separator between sections |
| TeamWebhookCard | `src/components/team/team-webhook-card.tsx` | div > Card(create) + Card(list) | Same |

### Priority 3: Missing title/description

| Component | File | Current | Change needed |
|-----------|------|---------|---------------|
| SessionsCard | `src/components/sessions/sessions-card.tsx` | Card > divide-y rows | Add CardHeader with title "Active Sessions" + description |
| TeamRotateKeyButton | `src/components/team/team-rotate-key-button.tsx` | Button + AlertDialog | Wrap in Card with CardHeader (title "Key Rotation" + description) |
| TeamPolicySettings | `src/components/team/team-policy-settings.tsx` | Card > manual h2 + p | Convert h2/p to CardHeader/Title/Desc |

### Priority 4: Audit log card cleanup

| Component | File | Current | Change needed |
|-----------|------|---------|---------------|
| TenantAuditLogCard | `src/components/settings/tenant-audit-log-card.tsx` | Tabs with variant prop | The `variant="logs"` and `variant="breakglass"` paths should each render a single Card with proper CardHeader. Remove internal Tabs structure entirely (sub-routes handle navigation now). |

## i18n Keys to Add

Each card that gains a new title/description needs translation keys. Add to the
component's own namespace (not AdminConsole — these are reusable components):

| Component | Namespace | Keys needed |
|-----------|-----------|-------------|
| SessionsCard | Sessions | `cardTitle`, `cardDescription` |
| ServiceAccountCard | MachineIdentity | Verify existing keys or add `saCardTitle`, `saCardDescription` |
| McpClientCard | MachineIdentity | Verify or add `mcpCardTitle`, `mcpCardDescription` |
| AccessRequestCard | MachineIdentity | Verify or add `accessRequestCardTitle`, `accessRequestCardDescription` |
| TeamRotateKeyButton | Team | Wrapper card needs `rotateKeyCardTitle`, `rotateKeyCardDescription` |
| TeamPolicySettings | TeamPolicy | Verify existing `title`/`description` keys |

Check existing translation files before adding — some may already have unused keys.

## Constraints

- Do not change component props or external API
- Card components are used in both admin pages and potentially other contexts — keep them self-contained
- Run `npx vitest run` + `npx next build` after changes
- Each card should be a single commit for reviewability

## Verification

After all changes, every card in the admin console should visually follow this pattern:
```
┌─────────────────────────────────┐
│ 🔧 Card Title                   │
│ Card description text            │
├─────────────────────────────────┤
│                                 │
│ [Card-specific content]         │
│                                 │
│ ─────────── (Separator) ─────── │
│                                 │
│ [Additional section if needed]  │
│                                 │
└─────────────────────────────────┘
```
