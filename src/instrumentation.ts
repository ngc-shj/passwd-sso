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

    // H4/#3: fail fast at boot if the session-token HMAC key cannot be resolved.
    // Since H4 the DB session lookup depends on this HMAC; without this check a
    // deployment with SHARE_MASTER_KEY_CURRENT_VERSION=2 and no V1 (and no
    // dedicated key) starts cleanly but breaks EVERY session lookup at runtime.
    const { validateSessionTokenHmacKey } = await import(
      "@/lib/auth/session/session-cache"
    );
    validateSessionTokenHmacKey();

    // Surface a likely reverse-proxy misconfiguration at boot (M2): production
    // with no trusted-proxy config means forwarded client IPs are dropped.
    const { warnOnProxyPosture } = await import("@/lib/security/proxy-posture");
    warnOnProxyPosture();
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
  const { sanitizeErrorForSentry } = await import("@/lib/security/sentry-sanitize");
  const [err, request, context] = args;
  const sanitizedErr = err instanceof Error ? sanitizeErrorForSentry(err) : err;
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(sanitizedErr, request, context);
}
