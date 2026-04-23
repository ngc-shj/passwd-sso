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

/**
 * Resolve `operatorId` to an active tenant OWNER/ADMIN membership.
 * Returns the membership on success, or a 400 NextResponse if the operator
 * is not an active admin.
 */
export async function requireMaintenanceOperator(
  operatorId: string,
): Promise<{ ok: true; operator: MaintenanceOperator } | { ok: false; response: NextResponse }> {
  const membership = await withBypassRls(
    prisma,
    async () =>
      prisma.tenantMember.findFirst({
        where: {
          userId: operatorId,
          role: { in: [TENANT_ROLE.OWNER, TENANT_ROLE.ADMIN] },
          deactivatedAt: null,
        },
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
  return { ok: true, operator: membership as MaintenanceOperator };
}
