// Shared query helpers for audit log API routes

import { AUDIT_ACTION_VALUES } from "@/lib/constants";
import { CURSOR_ID_RE } from "@/lib/validations/common";
import type { AuditAction } from "@prisma/client";

/** Pre-built set of all valid audit action strings for O(1) membership checks. */
export const VALID_ACTIONS: Set<string> = new Set(AUDIT_ACTION_VALUES);

/** Valid actor type values for audit log filtering. */
export const VALID_ACTOR_TYPES = ["HUMAN", "SERVICE_ACCOUNT", "MCP_AGENT", "SYSTEM"] as const;

/** Parses actorType from search params. Returns the value if valid, undefined otherwise. */
export function parseActorType(searchParams: URLSearchParams): (typeof VALID_ACTOR_TYPES)[number] | undefined {
  const raw = searchParams.get("actorType");
  return VALID_ACTOR_TYPES.find((t) => t === raw);
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
