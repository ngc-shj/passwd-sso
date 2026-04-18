import { prisma } from "@/lib/prisma";
import { withBypassRls, withTenantRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

export async function resolveUserTenantIdFromClient(
  db: Pick<typeof prisma, "tenantMember">,
  userId: string,
): Promise<string | null> {
  const memberships = await db.tenantMember.findMany({
    where: { userId, deactivatedAt: null },
    select: { tenantId: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });

  if (memberships.length === 0) return null;
  if (memberships.length > 1) {
    throw new Error("MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED");
  }
  return memberships[0].tenantId;
}

export async function resolveUserTenantId(userId: string): Promise<string | null> {
  return withBypassRls(prisma, async () =>
    resolveUserTenantIdFromClient(prisma, userId),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}

export async function resolveTeamTenantId(teamId: string): Promise<string | null> {
  return withBypassRls(prisma, async () => {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { tenantId: true },
    });
    return team?.tenantId ?? null;
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}

export async function withUserTenantRls<T>(
  userId: string,
  fn: (tenantId: string) => Promise<T>,
): Promise<T>;
export async function withUserTenantRls<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T>;
export async function withUserTenantRls<T>(
  userId: string,
  fn: ((tenantId: string) => Promise<T>) | (() => Promise<T>),
): Promise<T> {
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    throw new Error("TENANT_NOT_RESOLVED");
  }
  return withTenantRls(prisma, tenantId, () => (fn as (tenantId: string) => Promise<T>)(tenantId));
}

export async function withTeamTenantRls<T>(
  teamId: string,
  fn: (tenantId: string) => Promise<T>,
): Promise<T>;
export async function withTeamTenantRls<T>(
  teamId: string,
  fn: () => Promise<T>,
): Promise<T>;
export async function withTeamTenantRls<T>(
  teamId: string,
  fn: ((tenantId: string) => Promise<T>) | (() => Promise<T>),
): Promise<T> {
  const tenantId = await resolveTeamTenantId(teamId);
  if (!tenantId) {
    throw new Error("TENANT_NOT_RESOLVED");
  }
  return withTenantRls(prisma, tenantId, () => (fn as (tenantId: string) => Promise<T>)(tenantId));
}
