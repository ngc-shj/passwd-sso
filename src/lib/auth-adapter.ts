import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, AdapterSession, AdapterUser, AdapterAccount } from "next-auth/adapters";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sessionMetaStorage } from "@/lib/session-meta";
import { withBypassRls } from "@/lib/tenant-rls";
import { randomUUID } from "node:crypto";

/**
 * Custom Auth.js adapter that extends PrismaAdapter with:
 * - createSession: captures IP/UA from AsyncLocalStorage
 * - updateSession: updates lastActiveAt on session refresh
 */
export function createCustomAdapter(): Adapter {
  const base = PrismaAdapter(prisma);

  async function resolveTenantIdForUser(userId: string): Promise<string> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });
    if (!user) {
      throw new Error("USER_NOT_FOUND");
    }
    return user.tenantId;
  }

  return {
    ...base,

    async createUser(
      user: Omit<AdapterUser, "id">,
    ): Promise<AdapterUser> {
      const created = await withBypassRls(prisma, async () =>
        prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({
            data: {
              name: user.email ?? user.name ?? "User",
              slug: `bootstrap-${randomUUID().replace(/-/g, "").slice(0, 24)}`,
            },
            select: { id: true },
          });

          const createdUser = await tx.user.create({
            data: {
              name: user.name,
              email: user.email,
              image: user.image,
              emailVerified: user.emailVerified,
              tenantId: tenant.id,
            },
          });

          await tx.tenantMember.create({
            data: {
              tenantId: tenant.id,
              userId: createdUser.id,
              role: "OWNER",
            },
          });

          return createdUser;
        }),
      );
      if (!created.email) {
        throw new Error("USER_EMAIL_MISSING");
      }

      return {
        id: created.id,
        name: created.name,
        email: created.email,
        image: created.image,
        emailVerified: created.emailVerified,
      };
    },

    async linkAccount(
      account: AdapterAccount,
    ): Promise<void> {
      await withBypassRls(prisma, async () => {
        const tenantId = await resolveTenantIdForUser(account.userId);

        await prisma.account.create({
          data: {
            userId: account.userId,
            tenantId,
            type: account.type,
            provider: account.provider,
            providerAccountId: account.providerAccountId,
            refresh_token: account.refresh_token,
            access_token: account.access_token,
            expires_at: account.expires_at,
            token_type: account.token_type,
            scope: account.scope,
            id_token: account.id_token,
            session_state: account.session_state
              ? String(account.session_state)
              : null,
          },
        });
      });
    },

    async createSession(
      session: { sessionToken: string; userId: string; expires: Date },
    ): Promise<AdapterSession> {
      const meta = sessionMetaStorage.getStore();
      const created = await withBypassRls(prisma, async () => {
        const tenantId = await resolveTenantIdForUser(session.userId);

        return prisma.session.create({
          data: {
            sessionToken: session.sessionToken,
            userId: session.userId,
            tenantId,
            expires: session.expires,
            ipAddress: meta?.ip ?? null,
            userAgent: meta?.userAgent?.slice(0, 512) ?? null,
          },
        });
      });

      return {
        sessionToken: created.sessionToken,
        userId: created.userId,
        expires: created.expires,
      };
    },

    async updateSession(
      session: Partial<AdapterSession> & Pick<AdapterSession, "sessionToken">,
    ): Promise<AdapterSession | null | undefined> {
      try {
        const updated = await prisma.session.update({
          where: { sessionToken: session.sessionToken },
          data: {
            ...(session.expires ? { expires: session.expires } : {}),
            lastActiveAt: new Date(),
          },
        });

        return {
          sessionToken: updated.sessionToken,
          userId: updated.userId,
          expires: updated.expires,
        };
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2025"
        ) {
          return null;
        }
        throw err;
      }
    },
  };
}
