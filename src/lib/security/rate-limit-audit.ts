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

import type { NextRequest, NextResponse } from "next/server";
import { ACTOR_TYPE, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";
import { ANONYMOUS_ACTOR_ID } from "@/lib/constants/app";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import { getLogger } from "@/lib/logger";
import { RATE_LIMIT_MAP_MAX_SIZE } from "@/lib/validations/common.server";
import { resolveUserTenantId } from "@/lib/tenant-context";
import {
  rateLimited,
  serviceUnavailable,
  oauthTemporarilyUnavailable,
} from "@/lib/http/api-response";
import type { RateLimiter, RateLimitResult } from "@/lib/security/rate-limit";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export type FailClosedEnvelope =
  | "canonical"
  | "oauth"
  | (() => NextResponse);

const THROTTLE_WINDOW_MS = 5 * MS_PER_MINUTE;
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

    // Tenant resolution: caller passes tenantId when known directly (e.g.,
    // resolved from a share record or already in scope). When tenantId is
    // null AND userId is present (post-auth route), resolve here via the
    // tenantMember table. Fire-and-forget context — DB latency does NOT
    // block the 503 hot path because callers `void` this helper.
    //
    // If tenantId remains null after this attempt (pre-auth route OR
    // resolution failure), fall back to the warn-log-only path (no
    // dead-letter row, no DB write).
    let tenantId = args.tenantId ?? null;
    if (tenantId == null && args.userId != null) {
      try {
        tenantId = await resolveUserTenantId(args.userId);
      } catch {
        tenantId = null; // resolution failed — fall back to warn-log
      }
    }

    if (tenantId == null) {
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
      ...tenantAuditBase(args.req, actorUserId, tenantId),
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

// ── Convenience wrapper: limiter check + 503/429 envelope ────────────

/**
 * Check the rate-limiter and translate the result to an early-return
 * `NextResponse` when the request should be blocked.
 *
 * Returns:
 * - `NextResponse` (503) when the limiter signals `redisErrored: true` —
 *   audit emission (post-auth) or warn log (pre-auth) is fired internally.
 * - `NextResponse` (429) when the limiter is over its `max` for the window.
 * - `null` when the caller should proceed.
 *
 * Usage:
 * ```ts
 * const blocked = await checkRateLimitOrFail({
 *   req, limiter: unlockLimiter, key: `rl:vault_unlock:${userId}`,
 *   scope: "vault.unlock", userId, tenantId: null,
 * });
 * if (blocked) return blocked;
 * ```
 *
 * The `envelope` arg selects the 503 body shape:
 * - `"canonical"` (default): `{ error: "SERVICE_UNAVAILABLE" }`
 * - `"oauth"`: `{ error: "temporarily_unavailable" }` (RFC 6749, used by `/api/mcp/*`)
 * - function: caller-provided factory for routes that preserve a bespoke
 *   shape (currently only `vault/delegation/check` returns
 *   `{ authorized: false, reason: "service_unavailable" }`).
 */
type CheckRateLimitOrFailArgs = {
  req: NextRequest;
  scope: string;
  userId: string | null;
  tenantId?: string | null;
  envelope?: FailClosedEnvelope;
  /**
   * 429 envelope override. Used by routes whose pre-existing 429 contract
   * differs from canonical `RATE_LIMIT_EXCEEDED` — e.g. OAuth/RFC 6749 routes
   * (`/api/mcp/*`) return `{error:"slow_down"|"rate_limit_exceeded"|...}`,
   * `vault/delegation/check` returns `{authorized:false,reason:"rate_limit"}`,
   * `mcp/revoke` returns `{error:"rate_limited"}`. When provided, called with
   * the limiter's `retryAfterMs` instead of the canonical `rateLimited()`.
   * The 503 path is governed by `envelope`, not this arg.
   */
  rateLimitedEnvelope?: (retryAfterMs?: number) => NextResponse;
} & (
  | { limiter: RateLimiter; key: string; result?: never }
  // Pre-computed result form, for callers that go through a wrapper like
  // `checkIpRateLimit` (which already calls `limiter.check` internally and
  // owns the IP-based key composition).
  | { result: RateLimitResult; limiter?: never; key?: never }
);

export async function checkRateLimitOrFail(
  args: CheckRateLimitOrFailArgs,
): Promise<NextResponse | null> {
  const rl =
    args.result !== undefined ? args.result : await args.limiter.check(args.key);

  if (rl.redisErrored) {
    void emitRateLimitFailClosed({
      req: args.req,
      scope: args.scope,
      userId: args.userId,
      tenantId: args.tenantId ?? null,
    });
    const envelope = args.envelope ?? "canonical";
    if (envelope === "oauth") return oauthTemporarilyUnavailable();
    if (typeof envelope === "function") return envelope();
    return serviceUnavailable();
  }

  if (!rl.allowed) {
    return args.rateLimitedEnvelope != null
      ? args.rateLimitedEnvelope(rl.retryAfterMs)
      : rateLimited(rl.retryAfterMs);
  }

  return null;
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
