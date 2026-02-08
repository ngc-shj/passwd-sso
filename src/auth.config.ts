import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

export default {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      authorization: {
        params: {
          // Restrict to specific domain (optional, omit for personal accounts)
          hd: process.env.GOOGLE_WORKSPACE_DOMAIN,
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
        },
      },
    }),
    // SAML Jackson acts as an OIDC provider bridging any SAML 2.0 IdP
    {
      id: "saml-jackson",
      name: process.env.SAML_PROVIDER_NAME ?? "SSO",
      type: "oidc",
      issuer: process.env.JACKSON_URL,
      clientId: process.env.AUTH_JACKSON_ID ?? "dummy",
      clientSecret: process.env.AUTH_JACKSON_SECRET ?? "dummy",
      authorization: {
        params: {
          scope: "openid email profile",
        },
      },
      profile(profile) {
        return {
          id: profile.sub,
          name: profile.name ?? profile.email,
          email: profile.email,
          image: profile.picture ?? null,
        };
      },
    },
  ],

  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },

  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isProtected =
        nextUrl.pathname.startsWith("/dashboard") ||
        nextUrl.pathname.startsWith("/api/passwords");

      if (isProtected) {
        return isLoggedIn;
      }

      // Redirect authenticated users away from public pages to dashboard
      if (isLoggedIn && nextUrl.pathname === "/") {
        return Response.redirect(new URL("/dashboard", nextUrl));
      }

      return true;
    },

    // Validate domain claim if GOOGLE_WORKSPACE_DOMAIN is set
    async signIn({ account, profile }) {
      if (account?.provider === "google") {
        const hd = (profile as { hd?: string })?.hd;
        const requiredDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;
        if (requiredDomain && hd !== requiredDomain) {
          return false;
        }
      }
      return true;
    },
  },
} satisfies NextAuthConfig;
