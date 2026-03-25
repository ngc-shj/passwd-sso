export async function register() {
  // Validate environment variables at server startup.
  // Throws with a detailed error listing ALL invalid/missing vars.
  // Does NOT run during `next build` — only `next dev` and `next start`.
  await import("@/lib/env");

  // Initialize key provider and validate keys (Node.js runtime only)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Validate Redis config early — throws in production if REDIS_URL is missing.
    // This replaces the lazy validation that was previously in rate-limit.ts check().
    const { validateRedisConfig } = await import("@/lib/redis");
    validateRedisConfig();

    const { getKeyProvider } = await import("@/lib/key-provider");
    const provider = await getKeyProvider();
    await provider.validateKeys();
  }

  // Initialize Sentry for server-side error tracking (opt-in via SENTRY_DSN)
  if (process.env.SENTRY_DSN) {
    await import("../sentry.server.config");
  }
}

export async function onRequestError(
  ...args: Parameters<import("next/dist/server/instrumentation/types").InstrumentationOnRequestError>
) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  // Sanitize the error before sending to Sentry (consistent with withRequestLog)
  const { sanitizeErrorForSentry } = await import("@/lib/sentry-sanitize");
  const [err, request, context] = args;
  const sanitizedErr = err instanceof Error ? sanitizeErrorForSentry(err) : err;
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(sanitizedErr, request, context);
}
