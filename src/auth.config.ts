import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import Nodemailer from "next-auth/providers/nodemailer";
import { API_PATH } from "@/lib/constants";
import { isHttps } from "@/lib/url-helpers";
import { sendEmail } from "@/lib/email";
import { magicLinkEmail } from "@/lib/email/templates/magic-link";
import { authorizeWebAuthn } from "@/lib/webauthn-authorize";
import { createRateLimiter } from "@/lib/rate-limit";

// Rate limiters for magic link email (per-email address)
const magicLinkEmailLimiter = createRateLimiter({
  windowMs: 10 * 60_000,
  max: 3,
});

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");

const useSecureCookies = isHttps;

export default {
  providers: [
    // Only register providers whose credentials are fully configured.
    // Partial config (e.g. ID without SECRET) → broken OAuth at runtime;
    // missing issuer (JACKSON_URL) → Auth.js throws InvalidEndpoints.
    // Conditions mirror env.ts superRefine checks (L139-144).
    ...(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
      ? [
          Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
            // This app trusts Google as an IdP; allow linking by verified email.
            allowDangerousEmailAccountLinking: true,
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
        ]
      : []),
    ...(process.env.JACKSON_URL &&
    process.env.AUTH_JACKSON_ID &&
    process.env.AUTH_JACKSON_SECRET
      ? [
          {
            id: "saml-jackson" as const,
            name: process.env.SAML_PROVIDER_NAME ?? "SSO",
            type: "oidc" as const,
            issuer: process.env.JACKSON_URL,
            clientId: process.env.AUTH_JACKSON_ID ?? "dummy",
            clientSecret: process.env.AUTH_JACKSON_SECRET ?? "dummy",
            authorization: {
              params: {
                scope: "openid email profile",
              },
            },
            profile(profile: {
              sub: string;
              name?: string;
              email: string;
              picture?: string;
            }) {
              return {
                id: profile.sub,
                name: profile.name ?? profile.email,
                email: profile.email,
                image: profile.picture ?? null,
              };
            },
          },
        ]
      : []),
    // Magic Link (Email authentication)
    ...(process.env.EMAIL_PROVIDER
      ? [
          Nodemailer({
            server: process.env.SMTP_HOST
              ? {
                  host: process.env.SMTP_HOST,
                  port: Number(process.env.SMTP_PORT || 587),
                  auth: {
                    user: process.env.SMTP_USER || "",
                    pass: process.env.SMTP_PASS || "",
                  },
                }
              : "smtp://localhost:1025",
            from: process.env.EMAIL_FROM || "noreply@localhost",
            async sendVerificationRequest({ identifier: email, url }) {
              // Rate limit per email address (3 emails per 10 minutes)
              const rl = await magicLinkEmailLimiter.check(
                `magic-link:email:${email.toLowerCase()}`,
              );
              if (!rl.allowed) return; // silently drop — no user enumeration

              const { subject, html, text } = magicLinkEmail(url);
              await sendEmail({ to: email, subject, html, text });
            },
          }),
        ]
      : []),
    // WebAuthn (Passkey sign-in for individual users)
    ...(process.env.WEBAUTHN_RP_ID
      ? [
          Credentials({
            id: "webauthn",
            name: "Passkey",
            credentials: {
              credentialResponse: { type: "text" },
              challengeId: { type: "text" },
            },
            async authorize(credentials) {
              return authorizeWebAuthn(
                credentials as Record<string, unknown>,
              );
            },
          }),
        ]
      : []),
  ],

  cookies: {
    sessionToken: {
      name: useSecureCookies
        ? "__Secure-authjs.session-token"
        : "authjs.session-token",
      options: {
        path: `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/`,
        httpOnly: true,
        sameSite: "lax" as const,
        secure: useSecureCookies,
      },
    },
  },

  // Auth.js builds redirect URLs as `origin + pages.signIn`.
  // basePath must be included here because Next.js strips it from route handlers,
  // and withAuthBasePath restores it for Auth.js internal routing.
  pages: {
    signIn: `${basePath}/auth/signin`,
    error: `${basePath}/auth/error`,
  },

  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isProtected =
        nextUrl.pathname.startsWith("/dashboard") ||
        nextUrl.pathname.startsWith(API_PATH.PASSWORDS);

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
