/**
 * `team_members` row-state fragments shared by every SCIM Group reader
 * (scim-team-admission-approval-plan.md C2). Kept here, without `teamId` or
 * `role`, so every call site composes them with its own `where` rather than
 * copying the OR list.
 */
import type { Prisma } from "@prisma/client";

/**
 * A row the SCIM group membership model still counts: active, departed
 * (`deactivatedByTenant`, restored by a tenant return), or pending team
 * approval. A pending row is itself deactivated (C1 CHECK) and never also
 * `deactivatedByTenant` (CHECK: NOT (pending AND deactivatedByTenant)), so
 * the three branches do not overlap.
 */
export const SCIM_GROUP_ROW_STATE: Prisma.TeamMemberWhereInput = {
  OR: [
    { deactivatedAt: null },
    { deactivatedByTenant: true },
    { scimApprovalPending: true },
  ],
};

/**
 * `SCIM_GROUP_ROW_STATE` plus the guard against a cross-tenant guest and an
 * RLS-hidden `user` relation (today's `loadGroupMembers` filter): only users
 * with an ACTIVE membership in this tenant are reported in a SCIM Group
 * resource — a pending or departed row reports nobody until the tenant
 * membership itself is active again.
 */
export function scimGroupResponseMemberWhere(tenantId: string): Prisma.TeamMemberWhereInput {
  return {
    ...SCIM_GROUP_ROW_STATE,
    user: { tenantMemberships: { some: { tenantId, deactivatedAt: null } } },
  };
}
