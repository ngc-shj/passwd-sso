import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import authConfig from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
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
    async session({ session, user }) {
      session.user.id = user.id;
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      if (user.id) {
        logAudit({
          scope: "PERSONAL",
          action: "AUTH_LOGIN",
          userId: user.id,
        });
      }
    },
    async signOut(message) {
      if ("session" in message && message.session?.userId) {
        logAudit({
          scope: "PERSONAL",
          action: "AUTH_LOGOUT",
          userId: message.session.userId,
        });
      }
    },
  },
});
