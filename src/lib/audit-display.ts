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
import type { ActorType } from "@prisma/client";

export interface ActorDisplay {
  /** i18n key to render (e.g. "actorTypeAnonymous"), or null for real user (caller should render user info) */
  i18nKey: string | null;
  /** true if the userId is a sentinel and should not be resolved via users.findUnique */
  isSentinel: boolean;
}

/**
 * Classify an audit row's actor for display.
 *
 * - userId = ANONYMOUS_ACTOR_ID → "actorTypeAnonymous"
 * - userId = SYSTEM_ACTOR_ID → "actorTypeSystem"
 * - otherwise → null (caller renders user info), isSentinel = false
 *
 * The actorType parameter is accepted for forward-compat (future display
 * rules may branch on both); currently userId alone is authoritative.
 */
export function resolveActorDisplay(
  userId: string,
  actorType: ActorType,
): ActorDisplay {
  // actorType is currently informational; keep parameter so callers pass both
  // and future rules can diverge (e.g., MCP_AGENT display variant).
  void actorType;

  if (userId === ANONYMOUS_ACTOR_ID) {
    return { i18nKey: "actorTypeAnonymous", isSentinel: true };
  }
  if (userId === SYSTEM_ACTOR_ID) {
    return { i18nKey: "actorTypeSystem", isSentinel: true };
  }
  return { i18nKey: null, isSentinel: false };
}
