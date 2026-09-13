import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withBypassRls, withTenantRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

export async function resolveUserTenantIdFromClient(
  db: Pick<typeof prisma, "tenantMember">,
  userId: string,
): Promise<string | null> {
  const memberships = await db.tenantMember.findMany({
    where: { userId, deactivatedAt: null },
    select: { tenantId: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });

  if (memberships.length === 0) return null;
  if (memberships.length > 1) {
    throw new Error("MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED");
  }
  return memberships[0].tenantId;
}

export async function resolveUserTenantId(userId: string): Promise<string | null> {
  return withBypassRls(prisma, async (tx) =>
    resolveUserTenantIdFromClient(tx, userId),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}

/**
 * The tenant a user's records belong to, for callers that MUST NOT throw.
 *
 * Same adjudicator as `resolveUserTenantIdFromClient` — the active membership,
 * which is what every reader of those records scopes by — but total where that
 * one is strict: it throws `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` on a second
 * active membership, and on the paths this serves that turns a working
 * operation into a rolled-back 500 over a condition the operation does not care
 * about. Audit emits must never throw, and an escrow release must not be undone
 * by how its record is addressed.
 *
 * `User.tenantId` is the FALLBACK, not the source. It is a denormalized copy of
 * the same fact, and nothing writes the two together.
 *
 * THE PRODUCER, verified by reading the path rather than reasoning about it:
 * `auth.ts`'s tenant-claim handler. Its MIGRATION branch does move both (a
 * `user.update` alongside the membership write), but its NO-MEMBERSHIP branch
 * — reached when the user holds no active membership anywhere — writes only
 * `tenantMember.upsert` into the claimed tenant and leaves the column naming
 * whichever tenant last owned the row. `auth.ts`'s own comment already
 * distinguishes those two writers. So: a user deactivated or SCIM-deleted in
 * tenant B, then signing in through an IdP whose claim resolves to tenant A,
 * ends with the column on B and the only active membership on A.
 *
 * Two earlier versions of this comment were WRONG about this, in opposite
 * directions, and both were corrected only after review: the first named the
 * SCIM create path, whose cross-tenant arm is unreachable under its own
 * `withTenantRls`; the second concluded from that there was no producer at all.
 * The claim is recorded here with the path because the two failures cost three
 * review rounds between them.
 *
 * The fallback is still load-bearing, for the user whose memberships have ALL
 * been deactivated: they still have records to file, and the column is the last
 * tenant that owned them. Without it they would resolve null and their audit
 * rows would land in the system tenant instead.
 *
 * NOT for the sentinel actors — they have no `users` row at all (measured: no
 * seeder or migration creates one, and `users_not_system_tenant` CHECKs the
 * column against the sentinel tenant), so they return null here and reach
 * `SYSTEM_TENANT_ID` through `resolveTenantId`'s own coalesce. Stated because
 * the first version of this comment credited the fallback with that path, and a
 * maintainer who checks it, finds it structurally impossible, and concludes the
 * fallback is dead code would reroute every deactivated user's audit trail.
 *
 * Returns null only when the user row itself is absent.
 */
export async function resolveOwningTenantIdFromClient(
  db: Pick<typeof prisma, "user">,
  userId: string,
): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      tenantId: true,
      tenantMemberships: {
        where: { deactivatedAt: null },
        select: { tenantId: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  return user ? owningTenantOf(user.tenantId, user.tenantMemberships) : null;
}

/**
 * The owning-tenant rule itself, over a user's column and their ACTIVE
 * memberships oldest first. One function so that `resolveOwningTenantIdFromClient`
 * and the batch reader below cannot answer the same user differently.
 */
function owningTenantOf(column: string, activeMemberships: readonly { tenantId: string }[]): string {
  return activeMemberships[0]?.tenantId ?? column;
}

/**
 * Point `User.tenantId` at `tenantId`, and report the tenant it named before —
 * or null when it already named this one and nothing was written.
 *
 * Lives here rather than at its one call site because it is the only writer that
 * moves the column WITHOUT moving the rows the column scopes, and reading the
 * raw column is exactly what `check-owning-tenant-adjudicator` refuses outside
 * this file. That refusal is correct: everywhere else the question is "which
 * tenant owns this user", which the adjudicator answers. Here the question is
 * "what does the denormalized copy currently say", which only the copy answers.
 *
 * WHAT IT DELIBERATELY LEAVES BEHIND. The caller (`src/auth.ts`'s tenant-claim
 * handler, no-membership branch) has just joined the user to a tenant they hold
 * no data in. Realigning the column makes their `users` row visible to their own
 * requests again — under RLS it was not, which is what left vault unlock and
 * vault setup taking their not-found arms. Their `passwordEntry` / `tag` /
 * `folder` rows stay in the tenant that released them, so the vault reads as
 * EMPTY rather than as missing, and the caller reports how many rows that is.
 *
 * Moving those rows instead was considered and refused: the sibling
 * bootstrap-migration path moves three tables (`passwordEntryHistory`,
 * `emergencyAccessKeyPair`, `shareAccessLog`) by tenant id alone, which is sound
 * only because a bootstrap tenant has one member. The tenant releasing a user
 * here is a real multi-member one, so that path would move other members' rows.
 */
export async function realignOwningTenantColumn(
  db: Pick<typeof prisma, "user">,
  userId: string,
  tenantId: string,
): Promise<string | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { tenantId: true },
  });
  if (!user || user.tenantId === tenantId) return null;
  await db.user.update({ where: { id: userId }, data: { tenantId } });
  return user.tenantId;
}

/**
 * Counters for every model a realignment can strand — one per model the user
 * owns that is also tenant-scoped, so the row stays filed under the tenant that
 * released them while the user's requests scope by the new one.
 *
 * A MAP, not a fixed triple. The first version counted `passwordEntry` / `tag` /
 * `folder` and nothing else, so `{0,0,0}` read as "nothing stranded" for a user
 * whose passkeys, tokens and sessions were all still in the old tenant — and
 * `webAuthnCredential` has a user-visible consequence the "empty vault" framing
 * missed: `api/webauthn/credentials` lists under `withUserTenantRls` (the NEW
 * tenant) while `derivePasskeyState` counts under a bypass by userId alone, so
 * the user is told they have a passkey, sees none, and cannot manage them.
 *
 * The member set is DERIVED, not listed: `tenant-context.stranded-models.test.ts`
 * parses `prisma/schema.prisma` for every model declaring `tenantId` beside a
 * user column and fails when one is neither counted here nor named in that
 * test's exclusion map with a reason. A model added later shows up as a failing
 * test rather than as a silent zero.
 */
export const STRANDED_COUNTERS = {
  account: (tx, userId, tenantId) => tx.account.count({ where: { userId, tenantId } }),
  apiKey: (tx, userId, tenantId) => tx.apiKey.count({ where: { userId, tenantId } }),
  attachment: (tx, userId, tenantId) =>
    tx.attachment.count({ where: { createdById: userId, tenantId } }),
  delegationSession: (tx, userId, tenantId) =>
    tx.delegationSession.count({ where: { userId, tenantId } }),
  emergencyAccessGrant: (tx, userId, tenantId) =>
    tx.emergencyAccessGrant.count({ where: { ownerId: userId, tenantId } }),
  extensionBridgeCode: (tx, userId, tenantId) =>
    tx.extensionBridgeCode.count({ where: { userId, tenantId } }),
  extensionToken: (tx, userId, tenantId) =>
    tx.extensionToken.count({ where: { userId, tenantId } }),
  folder: (tx, userId, tenantId) => tx.folder.count({ where: { userId, tenantId } }),
  mcpAccessToken: (tx, userId, tenantId) =>
    tx.mcpAccessToken.count({ where: { userId, tenantId } }),
  mcpAuthorizationCode: (tx, userId, tenantId) =>
    tx.mcpAuthorizationCode.count({ where: { userId, tenantId } }),
  mcpRefreshToken: (tx, userId, tenantId) =>
    tx.mcpRefreshToken.count({ where: { userId, tenantId } }),
  mobileBridgeCode: (tx, userId, tenantId) =>
    tx.mobileBridgeCode.count({ where: { userId, tenantId } }),
  notification: (tx, userId, tenantId) =>
    tx.notification.count({ where: { userId, tenantId } }),
  passwordEntry: (tx, userId, tenantId) =>
    tx.passwordEntry.count({ where: { userId, tenantId } }),
  passwordShare: (tx, userId, tenantId) =>
    tx.passwordShare.count({ where: { createdById: userId, tenantId } }),
  session: (tx, userId, tenantId) => tx.session.count({ where: { userId, tenantId } }),
  tag: (tx, userId, tenantId) => tx.tag.count({ where: { userId, tenantId } }),
  teamMemberKey: (tx, userId, tenantId) =>
    tx.teamMemberKey.count({ where: { userId, tenantId } }),
  teamPasswordFavorite: (tx, userId, tenantId) =>
    tx.teamPasswordFavorite.count({ where: { userId, tenantId } }),
  vaultKey: (tx, userId, tenantId) => tx.vaultKey.count({ where: { userId, tenantId } }),
  webAuthnCredential: (tx, userId, tenantId) =>
    tx.webAuthnCredential.count({ where: { userId, tenantId } }),
} satisfies Record<
  string,
  (db: Prisma.TransactionClient, userId: string, tenantId: string) => Promise<number>
>;

/**
 * How many rows of each kind the user still owns under `tenantId`.
 *
 * Zero-valued keys are DROPPED. The audit row an operator reads should carry
 * what is stranded, not twenty-one zeroes with two numbers hidden among them —
 * and an empty object is then the honest encoding of "nothing left behind".
 */
export async function countStrandedRows(
  db: Prisma.TransactionClient,
  userId: string,
  tenantId: string,
): Promise<Record<string, number>> {
  const entries = Object.entries(STRANDED_COUNTERS);
  const counts = await Promise.all(entries.map(([, count]) => count(db, userId, tenantId)));
  return Object.fromEntries(
    entries.map(([model], i) => [model, counts[i]] as const).filter(([, n]) => n > 0),
  );
}

export async function resolveTeamTenantId(teamId: string): Promise<string | null> {
  return withBypassRls(prisma, async (tx) => {
    const team = await tx.team.findUnique({
      where: { id: teamId },
      select: { tenantId: true },
    });
    return team?.tenantId ?? null;
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}

export async function withUserTenantRls<T>(
  userId: string,
  fn: (tenantId: string) => Promise<T>,
): Promise<T>;
export async function withUserTenantRls<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T>;
export async function withUserTenantRls<T>(
  userId: string,
  fn: ((tenantId: string) => Promise<T>) | (() => Promise<T>),
): Promise<T> {
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    throw new Error("TENANT_NOT_RESOLVED");
  }
  // check-bypass-rls requires the (tx) callback form, but this thin wrapper
  // delegates to a caller-supplied fn(tenantId) that takes no client — fn's own
  // queries run inside this tenant tx via the ambient ALS/proxy. tx is therefore
  // structurally required yet genuinely unused here. Threading tx would change
  // the public withUserTenantRls contract (SC1 deferral, bypass-rls-tx plan).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withTenantRls(prisma, tenantId, (tx) => (fn as (tenantId: string) => Promise<T>)(tenantId));
}

export async function withTeamTenantRls<T>(
  teamId: string,
  fn: (tenantId: string) => Promise<T>,
): Promise<T>;
export async function withTeamTenantRls<T>(
  teamId: string,
  fn: () => Promise<T>,
): Promise<T>;
export async function withTeamTenantRls<T>(
  teamId: string,
  fn: ((tenantId: string) => Promise<T>) | (() => Promise<T>),
): Promise<T> {
  const tenantId = await resolveTeamTenantId(teamId);
  if (!tenantId) {
    throw new Error("TENANT_NOT_RESOLVED");
  }
  // See withUserTenantRls above: same fn(tenantId) delegation, tx unthreadable
  // without a public-contract change (SC1 deferral).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return withTenantRls(prisma, tenantId, (tx) => (fn as (tenantId: string) => Promise<T>)(tenantId));
}

/**
 * Which of these users already hold an ACTIVE membership in some OTHER tenant.
 *
 * For directory sync:
 * that path reactivates many memberships in one run, and the row it must not
 * step on is invisible inside the tenant context the sync runs in.
 *
 * MUST be called OUTSIDE a tenant context, because another tenant's membership is exactly what RLS hides inside one.
 * Returns both keys because the sync knows some users by id (already-mapped) and
 * others only by email (about to be mapped).
 */
export async function usersActiveInAnotherTenant(
  tenantId: string,
  userIds: readonly string[],
  emails: readonly string[],
): Promise<{ ids: Set<string>; emails: Set<string> }> {
  if (userIds.length === 0 && emails.length === 0) {
    return { ids: new Set(), emails: new Set() };
  }
  return withBypassRls(prisma, async (tx) => {
    const rows = await tx.tenantMember.findMany({
      where: {
        deactivatedAt: null,
        tenantId: { not: tenantId },
        OR: [
          ...(userIds.length > 0 ? [{ userId: { in: [...userIds] } }] : []),
          ...(emails.length > 0
            ? [{ user: { email: { in: [...emails], mode: "insensitive" as const } } }]
            : []),
        ],
      },
      select: { userId: true, user: { select: { email: true } } },
    });
    return {
      ids: new Set(rows.map((r) => r.userId)),
      emails: new Set(rows.map((r) => r.user.email?.toLowerCase()).filter((e): e is string => !!e)),
    };
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}

/** How an existing user stands toward the tenant that wants to attach them. */
export type ExistingUserResolution =
  | { kind: "owned"; userId: string }
  | { kind: "foreign"; userId: string; memberHere: boolean }
  | { kind: "ambiguous"; ownedHere: boolean };

/**
 * How each email that already names a user stands toward `tenantId`, keyed by
 * lower-cased email. An email naming no user is absent.
 *
 * For the producers that attach a membership WITHOUT the user authenticating:
 * SCIM POST and directory sync's create path. Their authority over an existing
 * user is ownership — the user's owning tenant, by the same rule as
 * `resolveOwningTenantIdFromClient` — and not merely "active nowhere else": a
 * user another tenant released is still not this tenant's to take, and attaching
 * then realigning them moved their tenancy on this tenant's say-so (round-5 S1).
 * Joining a new tenant is the user's own act, through that tenant's IdP (sign-in
 * row 4). `memberHere` marks a foreign user who already holds a membership row
 * in this tenant: a row the producer keeps in sync, but may not reactivate —
 * see `usersOwnedByAnotherTenant`.
 *
 * Matched case-insensitively, and every case variant counts: `users_email_key` is
 * case-sensitive and directory sync stores the provider's casing, so two rows can
 * share one mailbox. More than one match is `ambiguous` — never a guess (F1).
 */
export async function resolveExistingUsersForTenant(
  tenantId: string,
  emails: readonly string[],
): Promise<Map<string, ExistingUserResolution>> {
  if (emails.length === 0) return new Map();
  return withBypassRls(prisma, async (tx) => {
    const users = await tx.user.findMany({
      where: { email: { in: [...emails], mode: "insensitive" } },
      select: {
        id: true,
        email: true,
        tenantId: true,
        tenantMemberships: {
          where: { OR: [{ deactivatedAt: null }, { tenantId }] },
          select: { tenantId: true, deactivatedAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    const byEmail = new Map<string, typeof users>();
    for (const user of users) {
      if (!user.email) continue;
      const key = user.email.toLowerCase();
      byEmail.set(key, [...(byEmail.get(key) ?? []), user]);
    }
    const resolved = new Map<string, ExistingUserResolution>();
    for (const [email, matches] of byEmail) {
      if (matches.length > 1) {
        // `ownedHere` only when EVERY match is this tenant's: the ambiguity is
        // then this tenant's own data to resolve. With another tenant's user
        // among them, a producer must answer as it answers for that user alone,
        // or naming the case tells this tenant that such a user exists (round-7 R7-S2).
        const ownedHere = matches.every(
          (m) => owningTenantOf(m.tenantId, m.tenantMemberships.filter((tm) => tm.deactivatedAt === null)) === tenantId,
        );
        resolved.set(email, { kind: "ambiguous", ownedHere });
        continue;
      }
      const [user] = matches;
      const active = user.tenantMemberships.filter((m) => m.deactivatedAt === null);
      resolved.set(
        email,
        owningTenantOf(user.tenantId, active) === tenantId
          ? { kind: "owned", userId: user.id }
          : {
              kind: "foreign",
              userId: user.id,
              memberHere: user.tenantMemberships.some((m) => m.tenantId === tenantId),
            },
      );
    }
    return resolved;
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}

/**
 * Which of these users another tenant owns, by the rule `owningTenantOf` applies.
 *
 * For REACTIVATION by the producers that do not authenticate the user — SCIM PUT
 * and PATCH, and both of directory sync's reactivation arms. A membership row in
 * this tenant is not authority over the user: it is typically what is left after
 * the user left this tenant and joined another by signing in through its IdP.
 * Reactivating it, and then realigning the column, took the user back from the
 * tenant that owns them on this tenant's say-so — and the one-active-membership
 * guard does not stop it once that tenant has suspended them (round-6 R6-S2).
 * The way back is the user's own act, as for attachment: signing in through this
 * tenant's IdP moves the column here, after which this tenant owns them.
 *
 * MUST be called OUTSIDE a tenant context: another tenant's membership, and a
 * users row filed under it, are what RLS hides inside one. A user with no row is
 * absent from the result.
 */
export async function usersOwnedByAnotherTenant(
  tenantId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  return withBypassRls(prisma, async (tx) => {
    const users = await tx.user.findMany({
      where: { id: { in: [...userIds] } },
      select: {
        id: true,
        tenantId: true,
        tenantMemberships: {
          where: { deactivatedAt: null },
          select: { tenantId: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    return new Set(
      users.filter((u) => owningTenantOf(u.tenantId, u.tenantMemberships) !== tenantId).map((u) => u.id),
    );
  }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
}
