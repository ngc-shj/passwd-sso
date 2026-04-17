/**
 * Shared rate limiter instances for routes that should share counter state.
 *
 * Per-route `createRateLimiter` calls produce independent in-memory counters.
 * Routes serving the same client (e.g., the v1 API key surface) should
 * share a single limiter so the per-minute cap applies across the surface,
 * not per individual endpoint.
 */

import { createRateLimiter } from "@/lib/rate-limit";
import { MS_PER_MINUTE } from "@/lib/constants/time";

/** Shared limiter for `/api/v1/*` API-key-authenticated routes (100 req/min). */
export const v1ApiKeyLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 100,
});
