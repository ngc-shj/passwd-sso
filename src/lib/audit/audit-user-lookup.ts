import { prisma } from "@/lib/prisma";
import { SENTINEL_ACTOR_IDS } from "@/lib/constants/app";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

export interface AuditUserInfo {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

/**
 * Build a userId → user-info map for audit log display.
 * Filters out sentinel UUIDs (ANONYMOUS/SYSTEM) before the DB lookup since
 * they never exist in the users table.
 *
 * Caller provides the RLS-bypass wrapper so this helper works both with
 * per-request prisma (default) and cross-tenant audit queries.
 */
export async function fetchAuditUserMap(
  userIds: Array<string | null | undefined>,
): Promise<Map<string, AuditUserInfo>> {
  return fetchUserDisplayMap(userIds, BYPASS_PURPOSE.AUDIT_WRITE);
}

/**
 * The same lookup, for a caller that is not writing an audit row.
 *
 * Extracted rather than copied when `/api/tenant/members` needed it: that route
 * read identity through a REQUIRED `user` relation inside `withTenantRls`. For a
 * member whose `users` row lives in another tenant — now an ordinary outcome of a
 * realignment — that relation comes back null (measured: Prisma does not throw),
 * and reading its name failed the whole member list rather than that one row. The bypass stays here, in the one file already declared for it, instead of
 * being opened at each caller.
 *
 * It hydrates identity for users the CALLER has already decided it may show. It
 * is not an authorization boundary and must not be handed an id set the caller
 * did not derive from rows it can see.
 */
export async function fetchUserDisplayMap(
  userIds: Array<string | null | undefined>,
  purpose: (typeof BYPASS_PURPOSE)[keyof typeof BYPASS_PURPOSE],
): Promise<Map<string, AuditUserInfo>> {
  const uniqueIds = [...new Set(userIds.filter((id): id is string => !!id && !SENTINEL_ACTOR_IDS.has(id)))];
  if (uniqueIds.length === 0) return new Map();
  const users = await withBypassRls(
    prisma,
    (tx) =>
      tx.user.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true, name: true, email: true, image: true },
      }),
    purpose,
  );
  return new Map(users.map((u) => [u.id, u]));
}

/**
 * The display identity for `userId` out of a `fetchUserDisplayMap` result, or a
 * placeholder carrying only the id when no row came back.
 *
 * The id is always known — it is the foreign key on the row being listed — so a
 * route that used to return a REQUIRED relation object keeps returning a non-null
 * object, and only the fields `User` already declares nullable go null.
 */
export function displayUserOf(
  users: ReadonlyMap<string, AuditUserInfo>,
  userId: string,
): AuditUserInfo {
  return users.get(userId) ?? { id: userId, name: null, email: null, image: null };
}

export type UserIdentity = Pick<AuditUserInfo, "id" | "name" | "email">;

/** `displayUserOf` narrowed to the `{ id, name, email }` shape the admin lists return. */
export function displayIdentityOf(
  users: ReadonlyMap<string, AuditUserInfo>,
  userId: string,
): UserIdentity {
  const { id, name, email } = displayUserOf(users, userId);
  return { id, name, email };
}

export interface UserContact {
  email: string | null;
  name: string | null;
  locale: string | null;
}

/**
 * Where to reach a user the caller has already decided to notify — email, name
 * and locale. Read under a bypass for the same reason as `fetchUserDisplayMap`:
 * the user may have left the tenant whose context the caller runs in, and that
 * context's RLS hides their row.
 */
export async function fetchUserContact(
  userId: string,
  purpose: (typeof BYPASS_PURPOSE)[keyof typeof BYPASS_PURPOSE],
): Promise<UserContact | null> {
  return withBypassRls(
    prisma,
    (tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true, locale: true },
      }),
    purpose,
  );
}
