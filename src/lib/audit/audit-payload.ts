/**
 * Building an audit outbox payload from audit parameters: the metadata bound, the
 * blocklist, the column widths. Pure, and in a module that never reaches the
 * application's Prisma singleton, so the offline operator CLI builds exactly the
 * payload the application does (round-7 F-R7-2). `audit.ts` re-exports these.
 */
import type { AuditAction, AuditScope, ActorType } from "@prisma/client";
import { METADATA_BLOCKLIST } from "@/lib/audit/audit-logger";
import { safeRecord } from "@/lib/safe-keys";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import {
  AUDIT_IP_MAX_LENGTH,
  METADATA_MAX_BYTES,
  TRUNCATED_REASON_MAX_BYTES,
  USER_AGENT_MAX_LENGTH,
} from "@/lib/validations/common.server";
import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox-in-tx";

/**
 * Reduce metadata to what may be stored: the original when it fits, a
 * `_truncated` marker when it does not, and an `_unserializable` marker when it
 * cannot be rendered at all.
 *
 * Total by construction rather than by catching: see `safeMetadata` below for
 * the boundary and for why per-step catching was not enough.
 *
 * Note it also changes `logAuditInTx`, deliberately. On that path an
 * unserializable metadata field used to roll the caller's BUSINESS transaction
 * back — the mutation failed because its audit record could not be rendered.
 * Now the transaction commits and the audit row carries the marker, which is the
 * right direction for the same reason the async path takes it, and is pinned by
 * its own case.
 */
const UNSERIALIZABLE_METADATA = { _unserializable: true, _reason: "stringify_failed" } as const;

/**
 * Cut `reason` to fit inside TRUNCATED_REASON_MAX_BYTES, for retention in the
 * `_truncated` marker below.
 *
 * Measured on the JSON-ESCAPED form, not the raw string: `JSON.stringify`
 * escapes quotes and control characters, which can expand a single character
 * up to sixfold, so a byte budget checked against the raw value could still
 * overflow once serialized.
 *
 * Cut at a Unicode CODE-POINT boundary, not a byte offset. `Array.from`
 * splits a string into code points (never splitting a surrogate pair), so
 * every prefix it produces is itself well-formed — a byte-offset cut through
 * a multi-byte UTF-8 sequence would instead yield U+FFFD, which EXPANDS the
 * output, the opposite of what a bound is for.
 */
function truncateReason(reason: string): string {
  const codePoints = Array.from(reason);
  let lo = 0;
  let hi = codePoints.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = codePoints.slice(0, mid).join("");
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= TRUNCATED_REASON_MAX_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return codePoints.slice(0, lo).join("");
}

function truncateMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const json = JSON.stringify(metadata);
  // `JSON.stringify` does not only THROW — it returns `undefined` when the value
  // reduces to nothing (a `toJSON()` that returns undefined, a function, a
  // symbol). TypeScript types the object overload as `string`, so the guard has
  // to be a runtime one; without it the `.length` below is a TypeError, which is
  // the same escape as a throw and is how the first version of this catch left
  // the contract broken.
  if (typeof json !== "string") return { ...UNSERIALIZABLE_METADATA };
  // Bytes, not UTF-16 code units: `.length` let non-ASCII metadata (default
  // locale is `ja`) store up to ~3x the intended budget into a column that
  // rejects nothing (CF17).
  const byteSize = Buffer.byteLength(json, "utf8");
  if (byteSize > METADATA_MAX_BYTES) {
    const marker: Record<string, unknown> = { _truncated: true, _originalSize: byteSize };
    // Retain `reason` — the field an operator's grep over truncated rows
    // depends on — but only when it is already a string. `reason` is
    // caller-influenced at several call sites (e.g. rotate-master-key's
    // approve/revoke, tenant/breakglass); coercing a hostile non-string shape
    // could itself throw, which safeMetadata's outer catch would turn into
    // losing `_truncated` and `_originalSize` along with it. Walking the
    // original object for anything beyond this one field is deliberately not
    // reintroduced — see the removed recursive walk this replaces.
    if (typeof metadata.reason === "string") {
      marker.reason = truncateReason(metadata.reason);
    }
    return marker;
  }

  // The PARSED value, not the original object. `sanitizeMetadata` walks it
  // recursively, and a cycle whose `toJSON()` returns something safe passes
  // stringify and then overflows that walk — so the acyclic round-trip is what
  // makes the sanitize step total. It also costs nothing semantically: whatever
  // stringify dropped was never going to reach the column.
  const parsed: unknown = JSON.parse(json);
  // CHECKED, not cast. `toJSON()` may return anything, so the round-trip can
  // yield a string, a number or an array — all outside this function's declared
  // return type, and casting them through was silent in both directions: the
  // outbox worker coerces a non-object to `null`, so the metadata vanished with
  // the event still delivered, and an array passed its `typeof === "object"`
  // check and reached the column as a JSON array the payload type does not
  // admit. A shape that cannot be stored as metadata is unserializable FOR THIS
  // PURPOSE, which is what the marker says.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...UNSERIALIZABLE_METADATA };
  }
  return parsed as Record<string, unknown>;
}

/**
 * The whole metadata transformation under ONE exception boundary.
 *
 * `buildOutboxPayload` is called BEFORE `logAuditAsync`'s try (and before the
 * bulk path's), so anything that throws in here reaches the caller AND skips the
 * dead-letter arm: no outbox row, no dead-letter line, nothing. On
 * `logAuditInTx` it also rolls the caller's business transaction back.
 *
 * Catching per-step was the first attempt and it closed one trigger of three:
 * `JSON.stringify` throwing on a BigInt or a cycle. It missed stringify
 * RETURNING undefined, and it missed `sanitizeMetadata` overflowing its own
 * recursion on a cycle that stringify had accepted. The boundary belongs around
 * the transformation, not around the call inside it that was noticed first.
 *
 * The event still goes out; only the metadata is replaced. The marker is a fixed
 * token rather than an error-derived one: the reachable failures are plain
 * TypeErrors and RangeErrors carrying no SQLSTATE, so a code would read
 * "unknown" every time — a field that cannot discriminate is worse than none.
 */
function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  try {
    const truncated = truncateMetadata(metadata);
    return (sanitizeMetadata(truncated) as Record<string, unknown> | null | undefined) ?? null;
  } catch {
    return { ...UNSERIALIZABLE_METADATA };
  }
}

export interface AuditLogParams {
  scope: AuditScope;
  action: AuditAction;
  /**
   * Actor ID of any `ActorType` (HUMAN / SERVICE_ACCOUNT / MCP_AGENT / SYSTEM / ANONYMOUS) — not strictly a user ID.
   * For HUMAN: real user UUID. For SYSTEM / ANONYMOUS: sentinel from `SENTINEL_ACTOR_IDS` (see `src/lib/constants/app.ts`).
   * For SERVICE_ACCOUNT / MCP_AGENT: the agent's representing user UUID when applicable.
   * MUST NOT be `NIL_UUID` — use `resolveAuditUserId(null, "system")` or `resolveAuditUserId(null, "anonymous")` instead.
   * TODO(actorId-rename): rename audit_logs.userId column to actor_id and this field to actorId. Tracked separately — out of scope for the 2026-04 cleanup PR.
   */
  userId: string;
  actorType?: ActorType;
  serviceAccountId?: string | null;
  tenantId?: string;
  teamId?: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Recursively sanitize metadata for external forwarding.
 * Removes any keys in METADATA_BLOCKLIST at any depth,
 * including inside nested objects and arrays.
 */
export function sanitizeMetadata(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeMetadata).filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const entries: [string, unknown][] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (!METADATA_BLOCKLIST.has(k)) {
        const sanitized = sanitizeMetadata(v);
        if (sanitized !== undefined) {
          entries.push([k, sanitized]);
        }
      }
    }
    if (entries.length === 0) return undefined;
    return safeRecord(entries);
  }
  return value;
}

// ─── AuditLogParams → AuditOutboxPayload mapping ─────────────────

export function buildOutboxPayload(params: AuditLogParams): AuditOutboxPayload {
  const sanitized = safeMetadata(params.metadata);
  const actorType = params.actorType ?? ACTOR_TYPE.HUMAN;
  return {
    scope: params.scope,
    action: params.action,
    userId: params.userId,
    actorType,
    serviceAccountId: params.serviceAccountId ?? null,
    teamId: params.teamId ?? null,
    targetType: params.targetType ?? null,
    targetId: params.targetId ?? null,
    metadata: sanitized ?? null,
    // Both bounded to their column widths. `ip` used to be passed through raw
    // while `userAgent` was sliced — an asymmetry with a sharp edge, because
    // `ip` is the narrower column (45 vs 512) and the one whose value comes
    // from a request header. An over-length value does not truncate at the
    // column, it raises 22001 in the outbox worker's insert; that error, unlike
    // 22P02, does not echo the offending value, so the row cycles through
    // max_attempts and the audit event behind it is lost with nothing to say
    // what it was. Truncating keeps the event.
    ip: params.ip?.slice(0, AUDIT_IP_MAX_LENGTH) ?? null,
    userAgent: params.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
  };
}
