# Plan: Add Tailscale SSO to Auth.js

## Context
We want to enable users to log in with Tailscale OIDC in our existing Auth.js flow. The repo already uses NextAuth with Google/OIDC providers. Tailscale exposes an OAuth2 endpoint that can be used as a standard OIDC provider.

## Objective
Add a Tailscale provider to `src/pages/api/auth/[...nextauth].ts`, update environment variables, and ensure the redirect URI works in dev and prod.

## High‑level approach
1. **Create Tailscale OAuth app** – Obtain client ID, client secret, and set redirect URL (`/api/auth/callback/tailscale`).
2. **Add provider** – Use the helper package `@tailscale/tsidp` if available; otherwise fall back to NextAuth’s generic OAuth provider.
3. **Configure environment variables** – Add `TAILSCALE_CLIENT_ID`, `TAILSCALE_CLIENT_SECRET`, `TAILSCALE_ISSUER_URL` (default `https://tailscale.com`).
4. **Update NextAuth config** – Append the new provider to the `providers` array.
5. **Test** – Run `npm run dev`, navigate to `/api/auth/signin`, click *Tailscale*, and verify successful login.

## Key files to modify
- `src/pages/api/auth/[...nextauth].ts` – add provider.
- `.env.local` – add Tailscale env vars.

## Reusable utilities
- Existing OIDC provider setup patterns (see GoogleProvider usage in the same file).
- Auth.js configuration for session and callbacks.

## Verification
- Run local dev server and verify the sign‑in page shows a Tailscale button.
- Confirm redirect works: after login, user is redirected to `/dashboard` (or configured callback).
- Check session contents: `session.user.email` should be populated.
- Run `npm test` to ensure no regressions.

## Next steps
Once this plan is approved, I’ll create a branch, implement the changes, run tests, and open a PR.
