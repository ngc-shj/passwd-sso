import NextAuth from "next-auth";
import type { Account } from "next-auth";
import { createCustomAdapter } from "@/lib/auth-adapter";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { extractTenantClaimValue, slugifyTenant } from "@/lib/tenant-claim";
import { withBypassRls } from "@/lib/tenant-rls";
import { randomBytes } from "node:crypto";
import { resolveUserTenantId, resolveUserTenantIdFromClient } from "@/lib/tenant-context";
import authConfig from "./auth.config";

export async function ensureTenantMembershipForSignIn(
  userId: string,
  account?: Account | null,
  profile?: Record<string, unknown> | null,
): Promise<boolean> {
  const tenantClaim = extractTenantClaimValue(account, profile);
  if (!tenantClaim) {
    try {
      await resolveUserTenantId(userId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED"
      ) {
        return false;
      }
      throw error;
    }
    // Allow first-time sign-in without tenant claim.
    // Membership bootstrap is handled by the auth adapter createUser flow.
    return true;
  }

  const tenantSlug = slugifyTenant(tenantClaim);
  if (!tenantSlug) {
    return false;
  }

  const tenant = await withBypassRls(prisma, async () => {
    let found = await prisma.tenant.findUnique({
      where: { externalId: tenantClaim },
      select: { id: true },
    });

    if (!found) {
      try {
        found = await prisma.tenant.create({
          data: {
            externalId: tenantClaim,
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
            where: { externalId: tenantClaim },
            select: { id: true },
          });
          // P2002 on slug (not externalId) — retry with unique suffix
          if (!found) {
            const suffix = randomBytes(4).toString("hex");
            found = await prisma.tenant.create({
              data: {
                externalId: tenantClaim,
                name: tenantClaim,
                slug: `${tenantSlug}-${suffix}`,
              },
              select: { id: true },
            });
          }
        } else {
          throw e;
        }
      }
    }

    if (!found) return null;

    const existingTenantId = await resolveUserTenantIdFromClient(prisma, userId);

    // Single-tenant sign-in policy: reject cross-tenant login.
    if (existingTenantId && existingTenantId !== found.id) {
      const existingTenant = await prisma.tenant.findUnique({
        where: { id: existingTenantId },
        select: { isBootstrap: true },
      });
      const isBootstrapTenant = !!existingTenant?.isBootstrap;
      // Allow one-time migration from bootstrap tenant to IdP tenant.
      if (isBootstrapTenant) {
        await prisma.$transaction(async (tx) => {
          // Migrate user and account rows
          await tx.user.update({
            where: { id: userId },
            data: { tenantId: found.id },
          });

          await tx.account.updateMany({
            where: { userId },
            data: { tenantId: found.id },
          });

          // Migrate all tenant-scoped data tables
          await tx.passwordEntry.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.tag.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.folder.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.session.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.extensionToken.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.passwordEntryHistory.updateMany({
            where: { tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.vaultKey.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.auditLog.updateMany({
            where: { userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.emergencyAccessGrant.updateMany({
            where: { ownerId: userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.emergencyAccessKeyPair.updateMany({
            where: { tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.passwordShare.updateMany({
            where: { createdById: userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.shareAccessLog.updateMany({
            where: { tenantId: existingTenantId },
            data: { tenantId: found.id },
          });
          await tx.attachment.updateMany({
            where: { createdById: userId, tenantId: existingTenantId },
            data: { tenantId: found.id },
          });

          // Create membership in new tenant and remove old
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
            where: { userId, tenantId: existingTenantId },
          });
        });

        // Bootstrap migration complete — skip redundant upsert below
        return found;
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

      let userId = params.user?.id ?? null;
      if (!userId && params.user?.email) {
        const existing = await withBypassRls(prisma, async () =>
          prisma.user.findUnique({
            where: { email: params.user.email! },
            select: { id: true },
          }),
        );
        userId = existing?.id ?? null;
      }

      // First-ever sign-in can reach this callback before user row is persisted.
      // Allow auth flow to continue so createUser can provision bootstrap data.
      if (!userId) return true;

      const ok = await ensureTenantMembershipForSignIn(
        userId,
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
