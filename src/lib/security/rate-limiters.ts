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
import {
  MAX_ATTACHMENTS_PER_ENTRY,
  TEAM_ROTATE_ENTRIES_MAX,
  VAULT_ROTATE_ATTACHMENT_CEK_MAX,
} from "@/lib/validations/common";
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

// Team re-key pass budgets, per (team, user) and 15-minute window. A pass
// covers at most TEAM_ROTATE_ENTRIES_MAX entries (rotation refuses a larger
// team), each with at most MAX_ATTACHMENTS_PER_ENTRY attachments, and retries
// a refused request at most once per entry (rekey-runner.ts retryOnce).
const TEAM_REKEY_WINDOW_MS = 15 * MS_PER_MINUTE;
const TEAM_ATTACHMENTS_MAX = TEAM_ROTATE_ENTRIES_MAX * MAX_ATTACHMENTS_PER_ENTRY;
/** One migrate per legacy attachment, plus one retry per entry. */
export const TEAM_ATTACHMENT_MIGRATE_LIMIT = TEAM_ATTACHMENTS_MAX + TEAM_ROTATE_ENTRIES_MAX;
/** One re-key POST per entry, plus one retry per entry. */
export const TEAM_ENTRY_REKEY_LIMIT = 2 * TEAM_ROTATE_ENTRIES_MAX;
/**
 * Entry reads: one before the first step, one after an upgrade, one after the
 * retry (3 per entry) and one after each migrated attachment; page reads: at
 * most one per entry (page limit 1).
 */
export const TEAM_REKEY_READ_LIMIT = 4 * TEAM_ROTATE_ENTRIES_MAX + TEAM_ATTACHMENTS_MAX;

/**
 * Per-(team, user) limiter for
 * `PUT /api/teams/[teamId]/passwords/[id]/attachments/[id]/migrate` — the
 * re-key pass migrates a team's legacy attachments one request each.
 */
export const teamAttachmentMigrateLimiter = createRateLimiter({
  windowMs: TEAM_REKEY_WINDOW_MS,
  max: TEAM_ATTACHMENT_MIGRATE_LIMIT,
});

/**
 * Per-(team, user) limiter for `POST /api/teams/[teamId]/passwords/[id]/rekey`
 * — the re-key pass re-keys a team's entries one request each.
 */
export const teamEntryRekeyLimiter = createRateLimiter({
  windowMs: TEAM_REKEY_WINDOW_MS,
  max: TEAM_ENTRY_REKEY_LIMIT,
});

/**
 * Per-(team, user) limiter for the re-key pass reads: `GET
 * /api/teams/[teamId]/rekey` and `GET /api/teams/[teamId]/passwords/[id]/rekey`.
 */
export const teamRekeyReadLimiter = createRateLimiter({
  windowMs: TEAM_REKEY_WINDOW_MS,
  max: TEAM_REKEY_READ_LIMIT,
});

/**
 * Consecutive failed team key rotations per (team, user), reset by a committed
 * one. The success limiter in rotate-key/route.ts releases its slot on a
 * refusal, so without this a failing rotation — each one holds the team row
 * FOR NO KEY UPDATE and reads every entry — could be repeated without bound.
 * Looser than the success limit: a refusal from a concurrent write is
 * expected, and the client rebuilds and retries.
 */
export const TEAM_ROTATE_KEY_FAILURE_LIMIT = 10;
export const teamRotateKeyFailureLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: TEAM_ROTATE_KEY_FAILURE_LIMIT,
});
