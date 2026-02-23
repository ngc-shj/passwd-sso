import NextAuth from "next-auth";
import { createCustomAdapter } from "@/lib/auth-adapter";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import authConfig from "./auth.config";

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
