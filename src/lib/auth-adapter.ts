import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter, AdapterSession } from "next-auth/adapters";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sessionMetaStorage } from "@/lib/session-meta";
import { withBypassRls } from "@/lib/tenant-rls";

/**
 * Custom Auth.js adapter that extends PrismaAdapter with:
 * - createSession: captures IP/UA from AsyncLocalStorage
 * - updateSession: updates lastActiveAt on session refresh
 */
export function createCustomAdapter(): Adapter {
  const base = PrismaAdapter(prisma);

  return {
    ...base,

    async createSession(
      session: { sessionToken: string; userId: string; expires: Date },
    ): Promise<AdapterSession> {
      const meta = sessionMetaStorage.getStore();
      const created = await withBypassRls(prisma, async () => {
        const user = await prisma.user.findUnique({
          where: { id: session.userId },
          select: { tenantId: true },
        });
        if (!user) {
          throw new Error("USER_NOT_FOUND");
        }

        return prisma.session.create({
          data: {
            sessionToken: session.sessionToken,
            userId: session.userId,
            tenantId: user.tenantId,
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
