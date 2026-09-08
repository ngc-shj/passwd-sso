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
  return withBypassRls(prisma, async (tx) =>
    resolveUserTenantIdFromClient(tx, userId),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}

/**
 * The tenant a user's records belong to, for callers that MUST NOT throw.
 *
 * Same adjudicator as `resolveUserTenantIdFromClient` — the active membership,
 * which is what every reader of those records scopes by — but total where that
 * one is strict: it throws `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` on a second
 * active membership, and on the paths this serves that turns a working
 * operation into a rolled-back 500 over a condition the operation does not care
 * about. Audit emits must never throw, and an escrow release must not be undone
 * by how its record is addressed.
 *
 * `User.tenantId` is the FALLBACK, not the source. It is a denormalized copy of
 * the same fact, and nothing writes the two together.
 *
 * WHAT IS AND IS NOT MEASURED about how they come apart. The SCIM create path is
 * NOT a producer, though it reads like one: `api/scim/v2/Users` does reject a
 * user whose column names another tenant, but that arm is unreachable — the
 * lookup above it runs inside `withTenantRls`, so a user belonging to another
 * tenant is invisible and control reaches `user.create`, which dies on
 * `User.email @unique`. `directory-sync/engine.ts` has the same shape. The one
 * writer that moves the column (`auth.ts`'s SSO tenant claim) moves the
 * membership in the same transaction. On the development database the divergent
 * population is 0.
 *
 * So this is prophylaxis, not a live-incident fix, and it is worth saying which:
 * the value of one adjudicator is that writer and reader cannot disagree
 * REGARDLESS of how a divergence arises, and the class it closes contains
 * sign-in gates, passkey enforcement, session timeouts and the session-revocation
 * path. What it does NOT rest on is a reachable producer, because none was found.
 *
 * The fallback is still load-bearing, for the user whose memberships have ALL
 * been deactivated: they still have records to file, and the column is the last
 * tenant that owned them. Without it they would resolve null and their audit
 * rows would land in the system tenant instead.
 *
 * NOT for the sentinel actors — they have no `users` row at all (measured: no
 * seeder or migration creates one, and `users_not_system_tenant` CHECKs the
 * column against the sentinel tenant), so they return null here and reach
 * `SYSTEM_TENANT_ID` through `resolveTenantId`'s own coalesce. Stated because
 * the first version of this comment credited the fallback with that path, and a
 * maintainer who checks it, finds it structurally impossible, and concludes the
 * fallback is dead code would reroute every deactivated user's audit trail.
 *
 * Returns null only when the user row itself is absent.
 */
export async function resolveOwningTenantIdFromClient(
  db: Pick<typeof prisma, "user">,
  userId: string,
): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      tenantId: true,
      tenantMemberships: {
        where: { deactivatedAt: null },
        select: { tenantId: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  return user?.tenantMemberships[0]?.tenantId ?? user?.tenantId ?? null;
}

export async function resolveTeamTenantId(teamId: string): Promise<string | null> {
  return withBypassRls(prisma, async (tx) => {
    const team = await tx.team.findUnique({
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
  // check-bypass-rls requires the (tx) callback form, but this thin wrapper
  // delegates to a caller-supplied fn(tenantId) that takes no client — fn's own
  // queries run inside this tenant tx via the ambient ALS/proxy. tx is therefore
  // structurally required yet genuinely unused here. Threading tx would change
  // the public withUserTenantRls contract (SC1 deferral, bypass-rls-tx plan).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withTenantRls(prisma, tenantId, (tx) => (fn as (tenantId: string) => Promise<T>)(tenantId));
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
  // See withUserTenantRls above: same fn(tenantId) delegation, tx unthreadable
  // without a public-contract change (SC1 deferral).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withTenantRls(prisma, tenantId, (tx) => (fn as (tenantId: string) => Promise<T>)(tenantId));
}
