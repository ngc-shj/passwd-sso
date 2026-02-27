import NextAuth from "next-auth";
import type { Account } from "next-auth";
import { createCustomAdapter } from "@/lib/auth-adapter";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { extractTenantClaimValue, slugifyTenant } from "@/lib/tenant-claim";
import { withBypassRls } from "@/lib/tenant-rls";
import authConfig from "./auth.config";

export async function ensureTenantMembershipForSignIn(
  userId: string,
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): Promise<boolean> {
  const tenantClaim = extractTenantClaimValue(account, profile);
  if (!tenantClaim) {
    const memberships = await withBypassRls(prisma, async () =>
      prisma.tenantMember.findMany({
        where: { userId },
        select: { tenantId: true },
        take: 2,
      }),
    );
    return memberships.length === 1;
  }

  const tenantSlug = slugifyTenant(tenantClaim);
  if (!tenantSlug) {
    return false;
  }

  const tenant = await withBypassRls(prisma, async () => {
    let found = await prisma.tenant.findFirst({
      where: { OR: [{ id: tenantClaim }, { slug: tenantSlug }] },
      select: { id: true },
    });

    if (!found) {
      try {
        found = await prisma.tenant.create({
          data: {
            name: tenantClaim,
            slug: tenantSlug,
          },
          select: { id: true },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        ) {
          found = await prisma.tenant.findUnique({
            where: { slug: tenantSlug },
            select: { id: true },
          });
        } else {
          throw e;
        }
      }
    }

    if (!found) return null;

    const existingMemberships = await prisma.tenantMember.findMany({
      where: { userId },
      select: { tenantId: true },
      take: 2,
    });
    const existingMembership = existingMemberships[0] ?? null;

    // Single-tenant sign-in policy: reject cross-tenant login.
    if (existingMembership && existingMembership.tenantId !== found.id) {
      const isBootstrapTenant = existingMembership.tenantId.startsWith("tenant_usr_");
      // Allow one-time migration from bootstrap tenant to IdP tenant.
      if (isBootstrapTenant && existingMemberships.length === 1) {
        await prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: userId },
            data: { tenantId: found.id },
          });

          await tx.account.updateMany({
            where: { userId },
            data: { tenantId: found.id },
          });

          await tx.tenantMember.upsert({
            where: {
              tenantId_userId: {
                tenantId: found.id,
                userId,
              },
            },
            create: {
              tenantId: found.id,
              userId,
              role: "MEMBER",
            },
            update: {},
          });

          await tx.tenantMember.deleteMany({
            where: { userId, tenantId: existingMembership.tenantId },
          });

          const stillReferenced = await Promise.all([
            tx.user.count({ where: { tenantId: existingMembership.tenantId } }),
            tx.team.count({ where: { tenantId: existingMembership.tenantId } }),
            tx.tenantMember.count({ where: { tenantId: existingMembership.tenantId } }),
          ]);
          if (stillReferenced.every((n) => n === 0)) {
            await tx.tenant.delete({ where: { id: existingMembership.tenantId } });
          }
        });
      } else {
        return null;
      }
    }

    await prisma.tenantMember.upsert({
      where: {
        tenantId_userId: {
          tenantId: found.id,
          userId,
        },
      },
      create: {
        tenantId: found.id,
        userId,
        role: "MEMBER",
      },
      update: {},
    });

    return found;
  });

  return !!tenant;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: createCustomAdapter(),
  session: {
    strategy: "database",
    // Session expires after 8 hours (workday)
    maxAge: 8 * 60 * 60,
    // Extend session on activity within last 1 hour
    updateAge: 60 * 60,
  },
  ...authConfig,
  callbacks: {
    ...authConfig.callbacks,
    async signIn(params) {
      const baseSignIn = authConfig.callbacks?.signIn;
      if (baseSignIn) {
        const baseResult = await baseSignIn(params);
        if (!baseResult) return false;
      }

      if (!params.user?.id) return false;

      const ok = await ensureTenantMembershipForSignIn(
        params.user.id,
        params.account,
        (params.profile ?? null) as Record<string, unknown> | null,
      );
      return ok;
    },
    async session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      if (user.id) {
        logAudit({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.AUTH_LOGIN,
          userId: user.id,
        });
      }
    },
    async signOut(message) {
      if ("session" in message && message.session?.userId) {
        logAudit({
          scope: AUDIT_SCOPE.PERSONAL,
          action: AUDIT_ACTION.AUTH_LOGOUT,
          userId: message.session.userId,
        });
      }
    },
  },
});
