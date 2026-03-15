# Plan: Unify Settings Page Display Format

## Context

The three settings pages (Personal, Tenant, Team) have inconsistent display patterns:
- Tab icons: Only some tabs have icons (e.g., Webhooks in Tenant, sub-tabs in Team Members)
- Tab descriptions: No tab-level descriptions exist; component-level descriptions are inconsistent
- Layout ordering: No clear fixed-info-first / dynamic-info-last pattern
- Active/inactive: ApiKeyManager has collapsible inactive section, but webhook cards show flat lists
- Team Settings header lacks description text

This plan unifies all three pages with consistent patterns.

---

## Step 1: Create shared TabDescription component

**New file: `src/components/settings/tab-description.tsx`**

A thin presentational component that renders a brief description at the top of each tab content area.
Props: `{ children: string }` (restricted to string for type safety — only i18n text is passed).

```tsx
export function TabDescription({ children }: { children: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-4 py-3">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
```

**New file: `src/components/settings/tab-description.test.tsx`**

Minimal smoke test: renders children inside a `<p>` tag.

---

## Step 2: Add i18n keys (en + ja)

### `messages/{en,ja}/Sessions.json`
- `tabAccountDesc` — "Manage your active sessions and sign-in devices."
- `tabSecurityDesc` — "Manage passkeys and travel mode to protect your vault."
- `tabDeveloperDesc` — "Generate CLI tokens and API keys for programmatic access."

### `messages/{en,ja}/Dashboard.json`
- `tenantTabMembersDesc` — "View and manage organization members, roles, and access."
- `tenantTabSecurityDesc` — "Configure session policies and access restrictions for the organization."
- `tenantTabProvisioningDesc` — "Set up SCIM provisioning and directory sync for automated user management."
- `tenantTabAuditLogDesc` — "Review organization activity and security events."
- `tenantTabWebhooksDesc` — "Configure webhook endpoints to receive real-time event notifications."

### `messages/{en,ja}/Team.json`
- `teamSettingsDescription` — "Manage your team configuration, members, and integrations."
- `tabGeneralDesc` — "Update team name, description, or delete the team."
- `tabMembersDesc` — "Manage team members, transfer ownership, or invite new members."
- `tabPolicyDesc` — "Set password requirements and security policies for the team."
- `tabWebhookDesc` — "Configure webhook endpoints to receive team event notifications."

### `messages/{en,ja}/TenantWebhook.json`
- `inactiveWebhooks` — "Inactive webhooks ({count})"

### `messages/{en,ja}/TeamWebhook.json`
- `inactiveWebhooks` — "Inactive webhooks ({count})"

---

## Step 3: Personal Settings page

**File: `src/app/[locale]/dashboard/settings/page.tsx`**

**Import additions**: `Monitor`, `Shield`, `Code` from lucide-react; `Separator` from `@/components/ui/separator`; `TabDescription` from `@/components/settings/tab-description`.

### 3a. Add icons to all tab triggers

| Tab | Icon | Title |
|-----|------|-------|
| account | `Monitor` | Account |
| security | `Shield` | Security |
| developer | `Code` | Developer |

Format: `<TabsTrigger><Icon className="h-4 w-4 mr-2" />{t("tabX")}</TabsTrigger>`

### 3b. Add TabDescription at top of each TabsContent

### 3c. Reorder Security tab: TravelModeCard (fixed toggle) first, then Separator, then PasskeyCredentialsCard (dynamic list)

### 3d. Add Separator between CliTokenCard and ApiKeyManager in Developer tab

---

## Step 4: Tenant Settings page

**File: `src/app/[locale]/dashboard/tenant/page.tsx`**

**Import additions**: `Users`, `Shield`, `ScrollText` from lucide-react; `TabDescription` from `@/components/settings/tab-description`.

### 4a. Add icons to all tab triggers

| Tab | Icon | Title |
|-----|------|-------|
| members | `Users` | Members |
| security | `Shield` | Security |
| provisioning | `Link2` | Provisioning |
| audit-log | `ScrollText` | Audit Log |
| webhooks | `Webhook` | Webhooks (already has icon) |

### 4b. Add TabDescription at top of each TabsContent

---

## Step 5: Tenant Webhook active/inactive separation

**File: `src/components/settings/tenant-webhook-card.tsx`**

Split webhooks into `activeWebhooks` and `inactiveWebhooks`:
1. Show active webhooks first
2. Add collapsible section for inactive webhooks (following ApiKeyManager's `KeyList` pattern — button + state toggle, not Radix Collapsible)
3. Collapsed by default with `ChevronDown` toggle + "Inactive webhooks ({count})" text
4. **Auto-expand** inactive section when `limitReached && inactiveWebhooks.length > 0` (so users can see and delete inactive webhooks to free slots)

**Test updates**: Update existing tests in `tenant-webhook-card.test.tsx`:
- Update Collapsible mock to be state-aware (respect `open` prop)
- Add test: inactive webhooks not visible on initial render
- Add test: clicking toggle reveals inactive webhooks
- Add test: all-active list shows no collapsible section

---

## Step 6: Team Settings page

**File: `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx`**

**Import additions**: `Webhook`, `Shield` from lucide-react; `TabDescription` from `@/components/settings/tab-description`.

### 6a. Add description to header Card (main return path only — error/loading paths excluded)

### 6b. Add icons to all main tab triggers

| Tab | Icon | Title |
|-----|------|-------|
| general | `Settings2` | General |
| members | `Users` | Members |
| policy | `Shield` | Policy |
| webhook | `Webhook` | Webhooks |

Sub-tabs in Members already have icons — no change needed.

### 6c. Add TabDescription at top of each TabsContent

---

## Step 7: Team Webhook active/inactive separation

**File: `src/components/team/team-webhook-card.tsx`**

Same changes as Step 5 (TenantWebhookCard):
1. Split into active/inactive
2. Collapsible inactive section
3. Collapsed by default
4. Auto-expand when limitReached && inactiveWebhooks.length > 0

**Test updates**: Same as Step 5 — update `team-webhook-card.test.tsx` with state-aware Collapsible mock and collapse behavior tests.

---

## Step 8: Verification

1. `npx vitest run` — all tests must pass
2. `npx next build` — production build must succeed

---

## Unified Patterns Summary

| Pattern | Implementation |
|---------|---------------|
| Header Card | Gradient card + icon + title + description (all 3 pages) |
| Tab trigger | `<Icon h-4 w-4 mr-2 />` + text (all tabs) |
| Tab description | `<TabDescription>` at top of each TabsContent |
| Content order | Fixed settings → Separator → Dynamic lists |
| Active/inactive | Active first → collapsible "Inactive ({count})" section; auto-expand when limit reached |
| Member search | `filterMembers` utility + Search icon input (already exists) |

## Files to Modify

1. `src/components/settings/tab-description.tsx` — **new**
2. `src/components/settings/tab-description.test.tsx` — **new**
3. `src/app/[locale]/dashboard/settings/page.tsx`
4. `src/app/[locale]/dashboard/tenant/page.tsx`
5. `src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx`
6. `src/components/settings/tenant-webhook-card.tsx`
7. `src/components/settings/tenant-webhook-card.test.tsx`
8. `src/components/team/team-webhook-card.tsx`
9. `src/components/team/team-webhook-card.test.tsx`
10. `messages/en/Sessions.json` + `messages/ja/Sessions.json`
11. `messages/en/Dashboard.json` + `messages/ja/Dashboard.json`
12. `messages/en/Team.json` + `messages/ja/Team.json`
13. `messages/en/TenantWebhook.json` + `messages/ja/TenantWebhook.json`
14. `messages/en/TeamWebhook.json` + `messages/ja/TeamWebhook.json`
