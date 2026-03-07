export async function register() {
  // Validate environment variables at server startup.
  // Throws with a detailed error listing ALL invalid/missing vars.
  // Does NOT run during `next build` — only `next dev` and `next start`.
  await import("@/lib/env");

  // Initialize Sentry for server-side error tracking (opt-in via SENTRY_DSN)
  if (process.env.SENTRY_DSN) {
    await import("../sentry.server.config");
  }
}

export async function onRequestError(
  ...args: Parameters<NonNullable<typeof import("next/server").NextConfig["onRequestError"]>>
) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...args);
}
