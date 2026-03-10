import NextAuth from "next-auth";
import type { Account } from "next-auth";
import { createCustomAdapter } from "@/lib/auth-adapter";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { extractTenantClaimValue } from "@/lib/tenant-claim";
import { tenantClaimStorage } from "@/lib/tenant-claim-storage";
import { findOrCreateSsoTenant } from "@/lib/tenant-management";
import { withBypassRls } from "@/lib/tenant-rls";
import { resolveUserTenantId, resolveUserTenantIdFromClient } from "@/lib/tenant-context";
import authConfig from "./auth.config";

function getAuthRouteBasePath(): string {
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${basePath}/api/auth`;
}

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

  const tenant = await withBypassRls(prisma, async () => {
    const found = await findOrCreateSsoTenant(tenantClaim);

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
          // emergencyAccessKeyPair/shareAccessLog have no userId column;
          // safe because bootstrap tenants are single-user by design.
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
  basePath: getAuthRouteBasePath(),
  adapter: createCustomAdapter(),
  session: {
    strategy: "database",
    // Session expires after 8 hours (workday)
    maxAge: 8 * 60 * 60,
    // Check session freshness every 30 seconds (required for idle timeout enforcement)
    updateAge: 30,
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

      // Reject nodemailer for SSO tenant users.
      // Magic Link is for individual (bootstrap tenant) users only.
      // Prevents bypassing SSO policy via direct API calls.
      // Note: WebAuthn sign-in uses a custom route (/api/auth/passkey/verify)
      // that has its own SSO tenant guard, bypassing Auth.js entirely.
      const provider = params.account?.provider;
      if (provider === "nodemailer") {
        // Nodemailer requires email by definition. Block null-email as a safeguard.
        if (!params.user?.email) return false;

        const existingUser = await withBypassRls(prisma, async () =>
          prisma.user.findUnique({
            where: { email: params.user.email! },
            select: {
              id: true,
              tenant: { select: { isBootstrap: true } },
            },
          }),
        );
        // Existing user in a non-bootstrap (SSO) tenant → reject
        if (existingUser?.tenant && !existingUser.tenant.isBootstrap) {
          return false;
        }
      }

      // Always verify user exists in DB — Auth.js may provide a pre-generated
      // id before the user row is actually inserted (new OAuth sign-in).
      let userId: string | null = null;
      const lookupEmail = params.user?.email;
      if (lookupEmail) {
        const existing = await withBypassRls(prisma, async () =>
          prisma.user.findUnique({
            where: { email: lookupEmail },
            select: { id: true },
          }),
        );
        userId = existing?.id ?? null;
      }

      // First-ever sign-in can reach this callback before user row is persisted.
      // Store the tenant claim so createUser can place the user directly
      // into the SSO tenant instead of creating a bootstrap tenant.
      if (!userId) {
        const claim = extractTenantClaimValue(
          params.account,
          (params.profile ?? null) as Record<string, unknown> | null,
        );
        const store = tenantClaimStorage.getStore();
        if (store && claim) {
          store.tenantClaim = claim;
        }
        return true;
      }

      const ok = await ensureTenantMembershipForSignIn(
        userId,
        params.account,
        (params.profile ?? null) as Record<string, unknown> | null,
      );
      return ok;
    },
    async session({ session, user }) {
      // Auth.js v5 database strategy passes raw adapter fields;
      // strip internal fields to prevent leaking sessionToken etc.
      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        },
        expires: session.expires,
      };
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
