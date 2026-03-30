# Task: Unify Card Component Internal Structure

## Background

The settings UI reorganization (branch `refactor/settings-ui-reorganization`) established
a "1 page = 1 card" layout across personal settings and admin console. Every page now
renders a single card component inside a `SectionLayout` wrapper.

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
| Tabs inside Card | 1 | Tabs should be removed (sub-routes handle navigation now) |
| Button only (no Card) | 1 | Needs Card wrapper |
| Card > divide-y (no header) | 1 | Missing title/description |

Specific issues:
1. **No description**: service-account, mcp-client, access-request, sessions, team-rotate-key-button
2. **Manual h2/h3 instead of CardTitle**: service-account, mcp-client, access-request, cli-token, api-key-manager, team-policy-settings
3. **Multiple cards where one is expected**: tenant-webhook-card, team-webhook-card (have separate "create form" Card and "registered list" Card with no wrapping Card)
4. **Sub-card structure varies**: Some use Separator between sections, some use multiple Cards, some use nothing

## Current Page Locations

### Personal Settings (Vault context: `/dashboard/settings/`)
```
/dashboard/settings/account                          ← SessionsCard
/dashboard/settings/security/passkey                 ← PasskeyCredentialsCard
/dashboard/settings/security/travel-mode             ← TravelModeCard
/dashboard/settings/security/key-rotation            ← RotateKeyCard
/dashboard/settings/developer/cli-token              ← CliTokenCard
/dashboard/settings/developer/api-keys               ← ApiKeyManager
/dashboard/settings/developer/delegation             ← DelegationManager
```

### Admin > Tenant (`/admin/tenant/`)
```
/admin/tenant/members                                ← TenantMembersCard
/admin/tenant/teams                                  ← Teams list page (custom)
/admin/tenant/security/session-policy                ← TenantSessionPolicyCard
/admin/tenant/security/access-restriction            ← TenantAccessRestrictionCard
/admin/tenant/security/webhooks                      ← TenantWebhookCard
/admin/tenant/provisioning/scim                      ← ScimProvisioningCard
/admin/tenant/provisioning/directory-sync            ← DirectorySyncCard
/admin/tenant/machine-identity/service-accounts      ← ServiceAccountCard
/admin/tenant/machine-identity/mcp-clients           ← McpClientCard
/admin/tenant/machine-identity/access-requests       ← AccessRequestCard
/admin/tenant/audit-logs/logs                        ← TenantAuditLogCard (variant="logs")
/admin/tenant/audit-logs/breakglass                  ← TenantAuditLogCard (variant="breakglass")
```

### Admin > Team (`/admin/teams/[teamId]/`)
```
/admin/teams/[id]/general                            ← Custom (name/desc/delete)
/admin/teams/[id]/members/list                       ← Custom (member list)
/admin/teams/[id]/members/add                        ← Custom (add/invite)
/admin/teams/[id]/members/transfer                   ← Custom (ownership transfer)
/admin/teams/[id]/security/policy                    ← TeamPolicySettings
/admin/teams/[id]/security/key-rotation              ← TeamRotateKeyButton
/admin/teams/[id]/security/webhooks                  ← TeamWebhookCard
/admin/teams/[id]/audit-logs                         ← Team audit log page
```

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

## Additional Task: MCP Connections Page (Personal Settings)

Add a read-only "My MCP Connections" page to personal settings developer section:

```
/dashboard/settings/developer/connections            ← NEW: McpConnectionsCard
```

This page shows the current user's active MCP client connections (OAuth consents).
Users can see which MCP clients have been authorized and revoke individual connections.

### Implementation:
1. Create `src/components/settings/mcp-connections-card.tsx` — fetches user's active MCP access tokens, shows client name, scopes, last used, expiration
2. Create page at `src/app/[locale]/dashboard/settings/developer/connections/page.tsx`
3. Add nav item to the developer section tree nav in `src/app/[locale]/dashboard/settings/layout.tsx`
4. Add i18n keys for the card (Sessions namespace or new McpConnections namespace)
5. API: use existing `/api/vault/delegation` or create a new read-only endpoint for user's MCP token list

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

After all changes, every card in the admin console and personal settings should
visually follow this pattern:
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
