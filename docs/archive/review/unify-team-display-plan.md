# Plan: Unify Team Member Display

## Objective

Extract a shared `MemberInfo` component to unify the Avatar + Name + Email display pattern used across team settings and tenant settings pages, and fix the missing email display in the ownership transfer tab.

## Requirements

### Functional
- The ownership transfer tab must display member email addresses (currently missing)
- All member display locations must use a consistent layout: Avatar + Name + Email + optional extras (tenantName, "(you)" label)
- Existing behavior (actions, role badges, buttons) must remain unchanged
- No visual regression in any affected location — particularly, `TeamRoleBadge` positioning must remain as-is in each context

### Non-functional
- Reduce code duplication across 5+ repeated Avatar+Name+Email patterns
- Component must be reusable across both team and tenant contexts
- No new dependencies

## Technical Approach

### New Component: `MemberInfo`

Create `src/components/member-info.tsx` — a generic presentational component (not team-specific, since it is shared by team and tenant contexts).

**Must include `"use client"` directive** since it uses `useTranslations` hook.

**Scope:** `MemberInfo` renders ONLY the Avatar + text info block (the left portion of each member row). It does NOT include the outer row container, action buttons, or role badges that sit at the right end of the row. Those remain as siblings of `MemberInfo` in the parent flex container.

**Props:**
```typescript
interface MemberInfoProps {
  name: string | null;
  email: string | null;
  image: string | null;
  isCurrentUser?: boolean;       // shows "(you)" label
  nameExtra?: React.ReactNode;   // inline content NEXT TO the name (e.g., role/deactivated badges in tenant card)
  tenantName?: string | null;    // shows external tenant badge
  teamTenantName?: string | null; // compared with tenantName to decide visibility
  children?: React.ReactNode;    // slot for content BELOW the name/email (e.g., TeamRoleBadge in transfer tab)
}
```

**Renders (as a fragment with Avatar + info div):**
- `Avatar` (h-8 w-8) with `AvatarImage` + `AvatarFallback` (first char of name or email)
- `div.flex-1.min-w-0` containing:
  - Name row: `div.flex.items-center.gap-2` with `{name ?? email}` + optional "(you)" span + `nameExtra` (inline badges)
  - Email line: shown when `name` is present AND `email` is present (`name && email`). This is correct because when `name` is null, `email` is already displayed as the primary text via `name ?? email`
  - Children slot (rendered after email line, for items like TeamRoleBadge in transfer tab only)
  - Tenant name line (when `tenantName` is present AND differs from `teamTenantName`): amber-colored external org badge with Globe icon

**Translation namespace:** Uses `"Team"` namespace for the `"you"` label (existing key). When `isCurrentUser` is falsy (default), the translation is not called but the hook is still invoked (React hooks rules). This is safe as all consuming pages are within the next-intl provider context.

### Affected Locations

#### Team Settings (`src/app/[locale]/dashboard/teams/[teamId]/settings/page.tsx`)

1. **Member list tab** (lines 562-584): Replace Avatar+Name+Email+TenantName block → `<MemberInfo>` with `isCurrentUser` and `tenantName`/`teamTenantName` props. **`TeamRoleBadge` and role Select remain as siblings** outside `MemberInfo` (right side of the flex row). No children needed.

2. **Transfer ownership tab** (lines 658-666): Replace Avatar+Name block → `<MemberInfo>` with email now visible. **Pass `<TeamRoleBadge>` as children** — this matches current layout where the badge is below the name inside `flex-1 min-w-0`.

3. **Add member search results** (lines 749-759): Replace Avatar+Name+Email block → `<MemberInfo>`. No children needed.

#### Tenant Settings (`src/components/settings/tenant-members-card.tsx`)

4. **Tenant member list** (lines 196-223): Replace Avatar+Name+Email block → `<MemberInfo>`. **`isCurrentUser` is NOT passed** — the tenant member list does not currently show "(you)" label, and adding it is out of scope. **Role and deactivated badges are passed via `nameExtra` prop** to maintain the current inline layout (badges appear next to the name in a flex row). Note: tenant uses a different `initials()` function (multi-char initials) — the shared component will use single-char fallback for consistency with team settings.

#### Not Changed

- **Pending invitations** (team settings lines 836-846): Different data model (`Invitation`), no avatar, email-only — structurally different, not a good fit.

### Privacy Note

Email addresses are already returned by the API (`GET /api/teams/[teamId]/members`) and displayed in the member list tab. The transfer ownership tab renders the same data — adding email display introduces no new data exposure.

## Implementation Steps

1. Create `src/components/member-info.tsx` with the `MemberInfo` component (with `"use client"` directive)
2. Update team settings member list tab to use `MemberInfo` (TeamRoleBadge stays as sibling)
3. Update team settings transfer ownership tab to use `MemberInfo` (TeamRoleBadge as children; fixes the missing email)
4. Update team settings add member search results to use `MemberInfo`
5. Update tenant members card to use `MemberInfo` (no isCurrentUser; badges remain as siblings)
6. Clean up unused Avatar/AvatarImage/AvatarFallback imports from tenant-members-card.tsx if no longer directly used
7. Add unit tests for `MemberInfo` component covering prop variations (name/email null combinations, isCurrentUser, tenantName)
8. Run `npx vitest run` — all tests must pass
9. Run `npx next build` — production build must succeed

## Testing Strategy

- **New unit tests for `MemberInfo`**: Cover prop variations:
  - `name` present, `email` present → name displayed, email shown below
  - `name` null, `email` present → email displayed as primary text, no secondary email line
  - `name` present, `email` null → name displayed, no email line
  - `isCurrentUser=true` → "(you)" label appears
  - `tenantName` differs from `teamTenantName` → external org badge shown
  - `children` prop → rendered after email line
- Existing Vitest tests must pass (no functional change in behavior)
- Build verification: `npx next build` succeeds (catches SSR/type errors)

## Considerations & Constraints

- The `Globe` icon import moves to the new component
- The `useTranslations("Team")` hook is called inside the new component for the "(you)" label — the component must always be rendered within the next-intl provider context (guaranteed since all consuming pages are client components within the locale layout)
- The component is purely presentational — no state management or API calls
- Children slot is used ONLY in the transfer tab (for TeamRoleBadge); other locations keep badges as external siblings
- Tenant members card uses multi-char `initials()` function — the shared component uses single-char for consistency. This is an acceptable minor visual change.
- `TenantMembersCard` does NOT pass `isCurrentUser` — "(you)" label is not part of tenant member display
