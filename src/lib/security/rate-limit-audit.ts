/**
 * Audit emission helper for the `failClosedOnRedisError: true` 503 path.
 *
 * Called by opt-in route handlers (see plan C4) when a rate limiter returns
 * `redisErrored: true`. Throttled by `(scope, userId ?? ipBucket)` per 5 min
 * to avoid audit storms during a sustained Redis outage. Fire-and-forget:
 * callers `void emitRateLimitFailClosed(...)` and never await; the helper
 * itself never throws (errors swallowed internally).
 *
 * For pre-auth routes where neither `userId` nor a resolvable `tenantId` is
 * available, this helper skips the audit emission entirely (would otherwise
 * dead-letter at `logAuditAsync` resolveTenantId step) and emits a single
 * throttled warn log instead. Operators monitor the warn log channel for
 * pre-auth fail-closed events.
 *
 * scope arg MUST match a restrictive regex to prevent log-injection and
 * throttle-key bypass via newline / tab / control-char injection.
 */

import type { NextRequest } from "next/server";
import { ACTOR_TYPE, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import { getLogger } from "@/lib/logger";
import { RATE_LIMIT_MAP_MAX_SIZE } from "@/lib/validations/common.server";

const THROTTLE_WINDOW_MS = 5 * 60 * 1000; // 5 min
const SCOPE_RE = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){0,2}$/;

/**
 * Throttle entry: { key → expiresAt }. LRU eviction is approximated via
 * iteration order (Maps preserve insertion order); on overflow we drop the
 * oldest entries first instead of the rate-limit.ts "clear-all" anti-pattern
 * (would defeat the throttle during a botnet attack).
 */
const throttle = new Map<string, number>();

function pruneAndAdd(key: string, now: number): void {
  // Drop expired entries first (cheap forward pass)
  for (const [k, expiresAt] of throttle) {
    if (expiresAt < now) {
      throttle.delete(k);
    } else {
      // Insertion-order is age-order; first non-expired entry means rest
      // are newer-or-equal. Stop the scan.
      break;
    }
  }
  // LRU eviction: drop the oldest entries (head of insertion order) until
  // we're back under cap. NEVER clear all — would defeat throttle for
  // legitimate users during a sustained botnet flood (see plan S4 / I3.2).
  while (throttle.size >= RATE_LIMIT_MAP_MAX_SIZE) {
    const oldest = throttle.keys().next();
    if (oldest.done) break;
    throttle.delete(oldest.value);
  }
  throttle.set(key, now + THROTTLE_WINDOW_MS);
}

function shouldEmit(key: string, now: number): boolean {
  const expiresAt = throttle.get(key);
  if (expiresAt != null && expiresAt > now) {
    // True LRU: bump insertion order so this recently-accessed entry survives
    // future eviction passes. Without this, a recently-active legitimate user
    // would still be evicted before a stale botnet IP that was added later.
    throttle.delete(key);
    throttle.set(key, expiresAt);
    return false;
  }
  pruneAndAdd(key, now);
  return true;
}

interface EmitArgs {
  req: NextRequest;
  /** Limiter scope (e.g. `vault.unlock`). MUST match SCOPE_RE. */
  scope: string;
  /** Authenticated user id, or null for pre-auth routes. */
  userId: string | null;
  /** Tenant id when resolvable, null/undefined otherwise (pre-auth → audit skipped). */
  tenantId: string | null | undefined;
}

/**
 * Emit one throttled `RATE_LIMIT_FAIL_CLOSED` audit row. Fire-and-forget.
 *
 * Pre-auth case (tenantId nullish): skip audit emission; write one throttled
 * warn log on the dedicated `rate-limit.fail_closed.pre_auth_skip` channel.
 */
export async function emitRateLimitFailClosed(args: EmitArgs): Promise<void> {
  try {
    if (!SCOPE_RE.test(args.scope)) {
      // Fail-safe: never throw on bad scope; log + drop emission.
      getLogger().warn(
        { scope: args.scope },
        "rate-limit.fail_closed.invalid_scope",
      );
      return;
    }

    const ip = extractClientIp(args.req);
    const ipBucket = ip != null ? rateLimitKeyFromIp(ip) : "unknown";
    const throttleKey = `rlfc:${args.scope}:${args.userId ?? `ip:${ipBucket}`}`;
    const now = Date.now();
    if (!shouldEmit(throttleKey, now)) {
      return;
    }

    // Pre-auth (no resolvable tenant) → skip audit emission, warn log only.
    if (args.tenantId == null) {
      getLogger().warn(
        { scope: args.scope, ipBucket },
        "rate-limit.fail_closed.pre_auth_skip",
      );
      return;
    }

    const actorUserId = args.userId ?? ANONYMOUS_ACTOR_ID;
    const actorType =
      args.userId != null ? ACTOR_TYPE.HUMAN : ACTOR_TYPE.ANONYMOUS;

    await logAuditAsync({
      ...tenantAuditBase(args.req, actorUserId, args.tenantId),
      scope: AUDIT_SCOPE.TENANT,
      actorType,
      action: AUDIT_ACTION.RATE_LIMIT_FAIL_CLOSED,
      targetType: AUDIT_TARGET_TYPE.RATE_LIMITER,
      targetId: args.scope,
      metadata: {
        scope: args.scope,
        ip: ip ?? "unknown",
        ipBucket,
      },
    });
  } catch (err) {
    // Never propagate — the 503 hot path MUST NOT block on audit failures.
    try {
      getLogger().error(
        { err, scope: args.scope },
        "rate-limit.fail_closed.emit_error",
      );
    } catch {
      // Even logger may fail under extreme pressure; swallow.
    }
  }
}

// ── Test-only exports ────────────────────────────────────────────────

/** Reset the in-process throttle map. Call in `beforeEach`. */
export function __resetThrottleForTests(): void {
  throttle.clear();
}

/** Inspect throttle map state (size + key presence) — test-only. */
export function __getThrottleStateForTests(): {
  size: number;
  has(key: string): boolean;
} {
  return {
    get size() {
      return throttle.size;
    },
    has(key: string) {
      return throttle.has(key);
    },
  };
}
