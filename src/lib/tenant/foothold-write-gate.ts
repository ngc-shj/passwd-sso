import type { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import type { TenantPermission } from "@/lib/auth/access/tenant-permissions";
import { holdsTenantAuthority } from "@/lib/tenant/creator-authority";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  UserAuthRevokedError,
  isSessionRowLive,
  lockUsersAuthArtifacts,
} from "@/lib/auth/session/user-auth-serialization";
import type { LockBudget } from "@/lib/team/team-key-rotation-lock";
import { lockTenantRows } from "@/lib/team/tenant-row-lock";
import type { LockedTenantRow } from "@/lib/team/tenant-row-lock";

/**
 * The first statement of a transaction that writes a member foothold (a row
 * carrying a stored creator): serialises the write with the actor's
 * departure, demotion and containment.
 *
 * The actor's tenant row (and every `alsoLock` user's) is locked FOR SHARE in
 * ONE call — a departure or demotion holds FOR UPDATE, so the write either
 * commits first or reads the committed state. The credential lock then orders
 * the write against containment revoking the session, and the session row is
 * re-read under it. `permission: null` requires only a present, active row.
 *
 * Callers take every other user's active state and role from the returned map.
 * MUST run inside an open transaction under the tenant's RLS context, before
 * the route's own advisoryXactLock (docs/archive/review/member-foothold-containment-plan.md C5).
 */
export async function lockFootholdWriter(
  tx: Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw" | "session">,
  req: NextRequest,
  params: {
    tenantId: string;
    actorId: string;
    permission: TenantPermission | null;
    alsoLock?: readonly string[];
    budget?: LockBudget;
  },
): Promise<Map<string, LockedTenantRow>> {
  const { tenantId, actorId, permission, alsoLock = [], budget } = params;
  const rows = await lockTenantRows(tx, tenantId, [actorId, ...alsoLock], "share", budget);
  const actor = rows.get(actorId);
  if (!holdsTenantAuthority(actor, permission)) {
    throw new TenantAuthError(API_ERROR.FORBIDDEN, 403);
  }

  await lockUsersAuthArtifacts(tx, [actorId], { bounded: true });
  if (!(await isSessionRowLive(tx, req, actorId))) {
    throw new UserAuthRevokedError("session");
  }
  return rows;
}
