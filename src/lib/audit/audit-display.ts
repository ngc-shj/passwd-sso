/**
 * Central display helper for audit_logs.userId values.
 *
 * Resolves sentinel UUIDs (ANONYMOUS_ACTOR_ID, SYSTEM_ACTOR_ID) to their
 * i18n key before UI / CSV export / SIEM payload formatting.
 *
 * For real users, callers are responsible for the users.findUnique lookup
 * (this helper intentionally does not issue DB queries — audit rendering
 * is often in bulk, and the caller batches the lookup).
 */

import {
  ANONYMOUS_ACTOR_ID,
  SYSTEM_ACTOR_ID,
} from "@/lib/constants/app";

/**
 * Resolve a sentinel userId to an i18n key.
 *
 * - userId = ANONYMOUS_ACTOR_ID → "actorTypeAnonymous"
 * - userId = SYSTEM_ACTOR_ID → "actorTypeSystem"
 * - otherwise → null (caller renders user info)
 */
export function resolveActorDisplay(userId: string): string | null {
  if (userId === ANONYMOUS_ACTOR_ID) return "actorTypeAnonymous";
  if (userId === SYSTEM_ACTOR_ID) return "actorTypeSystem";
  return null;
}
