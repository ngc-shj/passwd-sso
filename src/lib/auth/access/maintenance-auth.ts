/**
 * Shared authentication helpers for admin maintenance routes.
 *
 * These routes are bearer-token authenticated (ADMIN_API_TOKEN) and require
 * an `operatorId` body/query param identifying an active tenant admin.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { TENANT_ROLE } from "@/lib/constants/auth/tenant-role";

export interface MaintenanceOperator {
  tenantId: string;
  role: typeof TENANT_ROLE.OWNER | typeof TENANT_ROLE.ADMIN;
}

export interface MaintenanceOperatorOptions {
  // Restrict the membership lookup to a specific tenant. When omitted, any
  // active OWNER/ADMIN membership of the operator is accepted; multi-tenant
  // admins resolve deterministically via createdAt-asc ordering.
  tenantId?: string;
}

/**
 * Resolve `operatorId` to an active tenant OWNER/ADMIN membership.
 * Returns the membership on success, or a 400 NextResponse if the operator
 * is not an active admin.
 */
export async function requireMaintenanceOperator(
  operatorId: string,
  options: MaintenanceOperatorOptions = {},
): Promise<{ ok: true; operator: MaintenanceOperator } | { ok: false; response: NextResponse }> {
  const membership = await withBypassRls(
    prisma,
    async () =>
      prisma.tenantMember.findFirst({
        where: {
          userId: operatorId,
          ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
          role: { in: [TENANT_ROLE.OWNER, TENANT_ROLE.ADMIN] },
          deactivatedAt: null,
        },
        // Deterministic selection when the operator holds admin in multiple
        // tenants — pin to the oldest membership so audit attribution is stable.
        orderBy: { createdAt: "asc" },
        select: { tenantId: true, role: true },
      }),
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
  );
  if (!membership) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "operatorId is not an active tenant admin" },
        { status: 400 },
      ),
    };
  }
  // The role filter above guarantees membership.role is OWNER or ADMIN, but
  // the Prisma client types it as the broader TenantRole enum. Narrow at
  // runtime so the cast cannot mask a future schema/enum drift.
  if (membership.role !== TENANT_ROLE.OWNER && membership.role !== TENANT_ROLE.ADMIN) {
    throw new Error(
      `requireMaintenanceOperator invariant violated: unexpected role ${membership.role}`,
    );
  }
  return { ok: true, operator: { tenantId: membership.tenantId, role: membership.role } };
}
