/**
 * Approve-eligibility classifier for admin vault reset rows.
 *
 * Centralizes the "who can approve this reset row?" logic so both the
 * GET history endpoint (rendering UI) and the POST approve endpoint
 * (enforcing the rejection) cannot drift apart.
 *
 * The three outcomes mirror the multi-layer defense:
 *   - "eligible": actor passes all gates (different identity than the
 *     initiator AND role strictly above the target's role)
 *   - "initiator": actor is the original initiator — FR4 self-approval block
 *   - "insufficient_role": actor's role is not strictly above the target's;
 *     covers both target-self (you can't be above yourself) and same-role
 *     peer admins (e.g., ADMIN attempting to approve another ADMIN's reset
 *     when only an OWNER could)
 */

import type { TenantRole } from "@prisma/client";
// Import from the pure hierarchy module — pulling from tenant-auth.ts
// would drag prisma/pg into client bundles that consume this helper
// (e.g., the history dialog).
import { isTenantRoleAbove } from "@/lib/auth/access/tenant-role-hierarchy";

export const APPROVE_ELIGIBILITY = {
  ELIGIBLE: "eligible",
  INITIATOR: "initiator",
  INSUFFICIENT_ROLE: "insufficient_role",
} as const;

export type ApproveEligibility =
  (typeof APPROVE_ELIGIBILITY)[keyof typeof APPROVE_ELIGIBILITY];

export function computeApproveEligibility(args: {
  actorId: string;
  actorRole: TenantRole;
  targetRole: TenantRole;
  initiatedById: string;
}): ApproveEligibility {
  if (args.actorId === args.initiatedById) return APPROVE_ELIGIBILITY.INITIATOR;
  if (!isTenantRoleAbove(args.actorRole, args.targetRole)) {
    return APPROVE_ELIGIBILITY.INSUFFICIENT_ROLE;
  }
  return APPROVE_ELIGIBILITY.ELIGIBLE;
}
