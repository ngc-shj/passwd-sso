import { prisma } from "@/lib/prisma";
import { SENTINEL_ACTOR_IDS } from "@/lib/constants/app";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

export interface AuditUserInfo {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

/**
 * Build a userId → user-info map for audit log display.
 * Filters out sentinel UUIDs (ANONYMOUS/SYSTEM) before the DB lookup since
 * they never exist in the users table.
 *
 * Caller provides the RLS-bypass wrapper so this helper works both with
 * per-request prisma (default) and cross-tenant audit queries.
 */
export async function fetchAuditUserMap(
  userIds: Array<string | null | undefined>,
): Promise<Map<string, AuditUserInfo>> {
  const uniqueIds = [...new Set(userIds.filter((id): id is string => !!id && !SENTINEL_ACTOR_IDS.has(id)))];
  if (uniqueIds.length === 0) return new Map();
  const users = await withBypassRls(
    prisma,
    () =>
      prisma.user.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true, name: true, email: true, image: true },
      }),
    BYPASS_PURPOSE.AUDIT_WRITE,
  );
  return new Map(users.map((u) => [u.id, u]));
}
