/**
 * Whether a row's creator still holds the tenant authority to own it.
 *
 * Import-safe on purpose: the audit-outbox worker calls it, and
 * tenant-auth.ts imports @/lib/prisma, which the worker must not load
 * eagerly. Import permissions from tenant-permissions.ts, never tenant-auth.ts.
 */

import { hasTenantPermission } from "@/lib/auth/access/tenant-permissions";
import type { TenantPermission } from "@/lib/auth/access/tenant-permissions";
import { departedSince, readTenantRows } from "@/lib/team/tenant-departure-read";
import type { LockedTenantRow } from "@/lib/team/tenant-departure-read";
import type { Prisma, TenantRole } from "@prisma/client";

/**
 * Whether a tenant row is present, active and, unless `permission` is null,
 * holds that permission. Departure since a point in time is the caller's
 * check (`departedSince`).
 */
export function holdsTenantAuthority(
  row: LockedTenantRow | undefined,
  permission: TenantPermission | null,
): row is LockedTenantRow & { role: TenantRole } {
  return (
    row !== undefined &&
    row.hasRow &&
    row.deactivatedAt === null &&
    row.role !== null &&
    (permission === null || hasTenantPermission(row.role, permission))
  );
}

/** The creatorAuthorized a list answers for a creatorVerdicts entry: legacy rows answer null. */
export function creatorAuthorizedOf(verdict: "legacy" | boolean | undefined): boolean | null {
  if (verdict === "legacy") return null;
  return verdict === true;
}

/**
 * The verdict per row id, from one read of the creators' tenant rows.
 * "legacy" — the row predates created_by_id (NULL), so no creator to check.
 * true / false — the creator's tenant row is present and active, its role holds
 * `permission`, and they have not left the tenant (deactivation or departure
 * record) at or after the row's creation: a creator hard-deleted after creating
 * the row and re-created later does not revive it. Callers act only on `true`
 * or "legacy" and read a missing entry as false.
 */
export async function creatorVerdicts(
  tx: Pick<Prisma.TransactionClient, "tenantMember" | "tenantMemberDeparture">,
  tenantId: string,
  rows: readonly { id: string; createdById: string | null; createdAt: Date }[],
  permission: TenantPermission,
): Promise<Map<string, "legacy" | boolean>> {
  const creatorIds = [
    ...new Set(rows.flatMap((r) => (r.createdById === null ? [] : [r.createdById]))),
  ];
  const tenantRows = await readTenantRows(tx, tenantId, creatorIds);
  const verdicts = new Map<string, "legacy" | boolean>();
  for (const r of rows) {
    if (r.createdById === null) {
      verdicts.set(r.id, "legacy");
      continue;
    }
    const row = tenantRows.get(r.createdById);
    verdicts.set(r.id, holdsTenantAuthority(row, permission) && !departedSince(row, r.createdAt));
  }
  return verdicts;
}
