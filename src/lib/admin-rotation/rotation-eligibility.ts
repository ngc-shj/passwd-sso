// A04-4 master-key rotation dual-approval — pure state-machine helpers.
// The DB CAS WHERE clauses in approve/execute/revoke routes are the
// load-bearing guards; these helpers are the early-reject + forensic-audit
// layer, sharing logic between API enforcement and (future) UI precompute.
//
// No route imports — these helpers must not depend on Next.js or Prisma to
// keep the dependency direction one-way (routes → helper). This is the same
// pattern as src/lib/vault/admin-reset-eligibility.ts.

export const APPROVE_ELIGIBILITY = {
  ELIGIBLE: "eligible",
  INITIATOR: "initiator",
  CROSS_TENANT: "cross_tenant",
  ALREADY_TERMINAL: "already_terminal",
} as const;
export type ApproveEligibility =
  (typeof APPROVE_ELIGIBILITY)[keyof typeof APPROVE_ELIGIBILITY];

export function computeApproveEligibility(args: {
  actorSubjectId: string;
  actorTenantId: string;
  initiatedById: string | null;
  rotationTenantId: string;
  approvedAt: Date | null;
  executedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  now: Date;
}): ApproveEligibility {
  if (args.actorTenantId !== args.rotationTenantId) {
    return APPROVE_ELIGIBILITY.CROSS_TENANT;
  }
  // initiatedById is nullable (initiator may have been deleted) — null means
  // the original initiator is gone; without an initiator identity there is no
  // self-approval to reject. Treat null as "any actor different from self" for
  // approval purposes.
  if (
    args.initiatedById !== null &&
    args.actorSubjectId === args.initiatedById
  ) {
    return APPROVE_ELIGIBILITY.INITIATOR;
  }
  if (
    args.approvedAt !== null ||
    args.executedAt !== null ||
    args.revokedAt !== null ||
    args.expiresAt.getTime() <= args.now.getTime()
  ) {
    return APPROVE_ELIGIBILITY.ALREADY_TERMINAL;
  }
  return APPROVE_ELIGIBILITY.ELIGIBLE;
}

export const EXECUTE_ELIGIBILITY = {
  ELIGIBLE: "eligible",
  NOT_APPROVED: "not_approved",
  ALREADY_TERMINAL: "already_terminal",
  CROSS_TENANT: "cross_tenant",
} as const;
export type ExecuteEligibility =
  (typeof EXECUTE_ELIGIBILITY)[keyof typeof EXECUTE_ELIGIBILITY];

export function computeExecuteEligibility(args: {
  actorTenantId: string;
  rotationTenantId: string;
  approvedAt: Date | null;
  executedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  now: Date;
}): ExecuteEligibility {
  if (args.actorTenantId !== args.rotationTenantId) {
    return EXECUTE_ELIGIBILITY.CROSS_TENANT;
  }
  if (args.approvedAt === null) {
    return EXECUTE_ELIGIBILITY.NOT_APPROVED;
  }
  if (
    args.executedAt !== null ||
    args.revokedAt !== null ||
    args.expiresAt.getTime() <= args.now.getTime()
  ) {
    return EXECUTE_ELIGIBILITY.ALREADY_TERMINAL;
  }
  return EXECUTE_ELIGIBILITY.ELIGIBLE;
}

export const REVOKE_ELIGIBILITY = {
  ELIGIBLE: "eligible",
  ALREADY_TERMINAL: "already_terminal",
  CROSS_TENANT: "cross_tenant",
} as const;
export type RevokeEligibility =
  (typeof REVOKE_ELIGIBILITY)[keyof typeof REVOKE_ELIGIBILITY];

export function computeRevokeEligibility(args: {
  actorTenantId: string;
  rotationTenantId: string;
  executedAt: Date | null;
  revokedAt: Date | null;
}): RevokeEligibility {
  if (args.actorTenantId !== args.rotationTenantId) {
    return REVOKE_ELIGIBILITY.CROSS_TENANT;
  }
  if (args.executedAt !== null || args.revokedAt !== null) {
    return REVOKE_ELIGIBILITY.ALREADY_TERMINAL;
  }
  return REVOKE_ELIGIBILITY.ELIGIBLE;
}
