// Shared query helpers for audit log API routes

import { AUDIT_ACTION_VALUES } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { CURSOR_ID_RE } from "@/lib/validations/common";
import { UUID_RE } from "@/lib/constants/app";
import { MS_PER_DAY } from "@/lib/constants/time";
import { AUDIT_LOG_MAX_RANGE_DAYS } from "@/lib/validations/common";
import { AUDIT_LOG_MAX_RANGE_MS } from "@/lib/validations/common.server";
import type { AuditAction } from "@prisma/client";

/** Pre-built set of all valid audit action strings for O(1) membership checks. */
export const VALID_ACTIONS: Set<string> = new Set(AUDIT_ACTION_VALUES);

/** Valid actor type values for audit log filtering. */
export const VALID_ACTOR_TYPES: (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE][] = Object.values(ACTOR_TYPE);

/** Parses actorType from search params. Returns the value if valid, undefined otherwise. */
export function parseActorType(searchParams: URLSearchParams): (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE] | undefined {
  const raw = searchParams.get("actorType");
  return VALID_ACTOR_TYPES.find((t) => t === raw);
}

/**
 * The instant range an audit-log download covers, from its `from` / `to`
 * parameters. A missing `from` means the AUDIT_LOG_MAX_RANGE_DAYS ending at `to`
 * (or now); a missing `to` means now. Null when neither is given (the caller
 * decides whether that is allowed). The error is the 400 body to answer with.
 */
export function resolveDownloadRange(
  from: string | null,
  to: string | null,
  now: Date = new Date(),
): { range: { gte: Date; lte: Date } | null } | { error: Record<string, string> } {
  if (!from && !to) return { range: null };
  const fromDate = from ? new Date(from) : undefined;
  const toDate = to ? new Date(to) : undefined;
  if ((fromDate && Number.isNaN(fromDate.getTime())) || (toDate && Number.isNaN(toDate.getTime()))) {
    return { error: { date: "Invalid date format" } };
  }
  const lte = toDate ?? now;
  const gte = fromDate ?? new Date(lte.getTime() - AUDIT_LOG_MAX_RANGE_DAYS * MS_PER_DAY);
  const diffMs = lte.getTime() - gte.getTime();
  if (diffMs < 0) return { error: { date: "'from' must be before 'to'" } };
  if (diffMs > AUDIT_LOG_MAX_RANGE_MS) {
    return { error: { range: `Maximum range is ${AUDIT_LOG_MAX_RANGE_DAYS} days` } };
  }
  return { range: { gte, lte } };
}

/** How many selected actions a download's audit row lists by name. */
const AUDIT_DOWNLOAD_MAX_RECORDED_ACTIONS = 50;

/**
 * The filters an audit-log download applied, for its AUDIT_LOG_DOWNLOAD row: the
 * date bounds the query used, the action list and the actor type. A filter not
 * applied leaves no key, so two downloads of different coverage never record
 * the same row. The action list is capped (the rest counted in
 * `actionsOmitted`) so it can never push the row past METADATA_MAX_BYTES, which
 * would replace every recorded filter with a truncation marker.
 */
export function auditDownloadFilterMetadata(applied: {
  from?: Date;
  to?: Date;
  actions: readonly string[];
  actorType?: string;
}): { from?: string; to?: string; actions?: string[]; actionsOmitted?: number; actorType?: string } {
  const omitted = applied.actions.length - AUDIT_DOWNLOAD_MAX_RECORDED_ACTIONS;
  return {
    ...(applied.from && { from: applied.from.toISOString() }),
    ...(applied.to && { to: applied.to.toISOString() }),
    ...(applied.actions.length > 0 && { actions: applied.actions.slice(0, AUDIT_DOWNLOAD_MAX_RECORDED_ACTIONS) }),
    ...(omitted > 0 && { actionsOmitted: omitted }),
    ...(applied.actorType && { actorType: applied.actorType }),
  };
}

/**
 * Parses the optional `userId` actor filter. Absent → no filter; anything but a
 * canonical uuid → `{ invalid: true }` (the caller answers 400).
 */
export function parseActorUserId(
  searchParams: URLSearchParams,
): { userId?: string } | { invalid: true } {
  const raw = searchParams.get("userId");
  if (raw === null) return {};
  if (!UUID_RE.test(raw)) return { invalid: true };
  return { userId: raw };
}

/**
 * Parse a comma-separated `actions` query parameter into an AuditAction array.
 * Returns `{ invalid: [...] }` if any action is not in validActions.
 * Returns `{ actions: null }` when the param is empty (no filter).
 */
export function parseActionsCsvParam(
  actionsParam: string | null,
  validActions: Set<string> = VALID_ACTIONS,
): { actions: AuditAction[] } | { invalid: string[] } {
  if (!actionsParam) return { actions: [] };
  const requested = actionsParam.split(",").map((a) => a.trim()).filter(Boolean);
  const invalid = requested.filter((a) => !validActions.has(a));
  if (invalid.length > 0) return { invalid };
  // Deduplicated: a repeated action selects nothing more, and the list is
  // recorded in the download's audit row.
  return { actions: [...new Set(requested)] as AuditAction[] };
}

export interface AuditLogParams {
  action: string | null;
  actions: string | null;
  from: string | null;
  to: string | null;
  cursor: string | null;
  limit: number;
}

/** Parses and validates common audit log query parameters from a URLSearchParams instance. */
export function parseAuditLogParams(searchParams: URLSearchParams): AuditLogParams {
  const action = searchParams.get("action");
  const actions = searchParams.get("actions");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const cursor = searchParams.get("cursor");
  const limitParam = searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 100);
  return { action, actions, from, to, cursor, limit };
}

/**
 * Builds a Prisma `createdAt` filter object from optional ISO date strings.
 * Returns `undefined` when neither value is provided or all dates are invalid.
 * Invalid date strings are silently ignored (lenient — list endpoints tolerate
 * bad input; download endpoints validate strictly and return 400).
 */
export function buildAuditLogDateFilter(
  from: string | null,
  to: string | null,
): Record<string, Date> | undefined {
  if (!from && !to) return undefined;
  const createdAt: Record<string, Date> = {};
  if (from) {
    const d = new Date(from);
    if (!Number.isNaN(d.getTime())) createdAt.gte = d;
  }
  if (to) {
    const d = new Date(to);
    if (!Number.isNaN(d.getTime())) createdAt.lte = d;
  }
  return createdAt.gte || createdAt.lte ? createdAt : undefined;
}

/**
 * Builds a Prisma `action` filter from parsed params, a valid-action set, and action groups.
 * Returns `undefined` when neither `actions` nor `action` is provided or matched.
 * Throws `{ actions: string[] }` (validation error shape) when an unknown action is requested.
 */
export function buildAuditLogActionFilter(
  params: Pick<AuditLogParams, "action" | "actions">,
  validActions: Set<string>,
  groups: Record<string, AuditAction[]>,
): AuditAction | { in: AuditAction[] } | undefined {
  const { action, actions } = params;

  if (actions) {
    const requested = actions.split(",").map((a) => a.trim()).filter(Boolean);
    const invalid = requested.filter((a) => !validActions.has(a));
    if (invalid.length > 0) {
      // Caller is expected to handle this by returning a validation error response
      throw { actions: invalid };
    }
    return { in: requested as AuditAction[] };
  }

  if (action) {
    if (groups[action]) {
      return { in: groups[action] };
    }
    if (validActions.has(action)) {
      return action as AuditAction;
    }
  }

  return undefined;
}

/** Returns true when cursor is null (absent) or matches UUID format. */
export function isValidCursorId(cursor: string | null | undefined): boolean {
  if (cursor == null) return true;
  return CURSOR_ID_RE.test(cursor);
}

/**
 * Slices a result set fetched with `take: limit + 1` and computes the next cursor.
 * The caller must pass `items` that may contain one extra element beyond `limit`.
 */
export function paginateResult<T extends { id: string }>(
  items: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const hasMore = items.length > limit;
  const sliced = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? sliced[sliced.length - 1].id : null;
  return { items: sliced, nextCursor };
}
