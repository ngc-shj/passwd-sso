/**
 * Shared rate limiter instances for routes that should share counter state.
 *
 * Per-route `createRateLimiter` calls produce independent in-memory counters.
 * Routes serving the same client (e.g., the v1 API key surface) should
 * share a single limiter so the per-minute cap applies across the surface,
 * not per individual endpoint.
 */

import { createRateLimiter } from "@/lib/security/rate-limit";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { VAULT_ROTATE_ATTACHMENT_CEK_MAX } from "@/lib/validations/common";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

/** Shared limiter for `/api/v1/*` API-key-authenticated routes (100 req/min). */
export const v1ApiKeyLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: 100,
  failClosedOnRedisError: true,
});

/** Per-user limiter for `PUT /api/passwords/[id]/attachments/[id]/migrate`. */
export const migrateLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: VAULT_ROTATE_ATTACHMENT_CEK_MAX + 1000, // 5000 work + 1000 retry headroom
});
