import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { parseQuery } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { TEAM_PERMISSION } from "@/lib/constants";
import {
  REKEY_ENTRY_STATE,
  REKEY_HOLDERS_LISTED_MAX,
  REKEY_PAGE_LIMIT_DEFAULT,
  REKEY_PAGE_LIMIT_MAX,
  type RekeyEntryState,
} from "@/lib/constants/team/rotate-key";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { handleAuthError, notFound, rateLimited, unauthorized } from "@/lib/http/api-response";
import { teamRekeyReadLimiter } from "@/lib/security/rate-limiters";
import { displayIdentityOf, fetchUserDisplayMap } from "@/lib/audit/audit-user-lookup";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { isRekeyerHolder, normalizeTeamKeyVersion, teamKeyVersionHolders } from "@/lib/team/team-item-key";

type RouteContext = { params: Promise<{ teamId: string }> };

const rekeyPageQuerySchema = z.object({
  after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(REKEY_PAGE_LIMIT_MAX).default(REKEY_PAGE_LIMIT_DEFAULT),
});

// GET /api/teams/[teamId]/rekey?after=<entryId>&limit=<n>
// The re-key pass's work list (plan C2): entries whose ItemKey predates the
// team's current key version (trashed and archived included), one keyset page
// of their ids, how many are in each C1 state for the caller, and the history
// rows left under an old ItemKey.
async function handleGET(req: NextRequest, { params }: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const { teamId } = await params;

  try {
    await requireTeamPermission(userId, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const rl = await teamRekeyReadLimiter.check(`rl:team_rekey_read:${teamId}:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const query = parseQuery(req, rekeyPageQuerySchema);
  if (!query.ok) return query.response;
  const { after, limit } = query.data;

  const result = await withTeamTenantRls(teamId, async (_tenantId, tx) => {
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { teamKeyVersion: true } });
    if (!team) return null;
    const pendingWhere = { teamId, itemKeyTeamKeyVersion: { lt: team.teamKeyVersion } };

    const pendingCount = await tx.teamPasswordEntry.count({ where: pendingWhere });
    const page = await tx.teamPasswordEntry.findMany({
      where: { ...pendingWhere, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true },
      orderBy: { id: "asc" },
      take: limit,
    });

    // Pending entries per (normalised) team key version, each classified by
    // who holds that version.
    const byVersion = await tx.teamPasswordEntry.groupBy({
      by: ["teamKeyVersion"],
      where: pendingWhere,
      _count: { _all: true },
    });
    const pendingPerVersion = new Map<number, number>();
    for (const row of byVersion) {
      const v = normalizeTeamKeyVersion(row.teamKeyVersion);
      pendingPerVersion.set(v, (pendingPerVersion.get(v) ?? 0) + row._count._all);
    }
    const stateCounts: Record<RekeyEntryState, number> = {
      [REKEY_ENTRY_STATE.READY]: 0,
      [REKEY_ENTRY_STATE.NEEDS_REKEYER_HOLDER]: 0,
      [REKEY_ENTRY_STATE.HOLDER_CANNOT_REKEY]: 0,
      [REKEY_ENTRY_STATE.UNRECOVERABLE]: 0,
    };
    const rekeyersByVersion: Record<number, string[]> = {};
    for (const [version, count] of [...pendingPerVersion].sort(([a], [b]) => a - b)) {
      const holders = await teamKeyVersionHolders(tx, teamId, version);
      const rekeyers = holders.filter(isRekeyerHolder);
      let state: RekeyEntryState;
      if (holders.some((h) => h.userId === userId)) {
        state = REKEY_ENTRY_STATE.READY;
      } else if (rekeyers.length > 0) {
        state = REKEY_ENTRY_STATE.NEEDS_REKEYER_HOLDER;
        rekeyersByVersion[version] = rekeyers
          .map((h) => h.userId)
          .sort()
          .slice(0, REKEY_HOLDERS_LISTED_MAX);
      } else if (holders.length > 0) {
        state = REKEY_ENTRY_STATE.HOLDER_CANNOT_REKEY;
      } else {
        state = REKEY_ENTRY_STATE.UNRECOVERABLE;
      }
      stateCounts[state] += count;
    }

    // History rows not under their entry's current ItemKey (a NULL id never
    // matches): after a re-key, exactly the rows it retained; before one, the
    // rows the pass can re-key only by trial decryption or must retain.
    // Rotation leaves item_key_id unchanged, so a rotation alone moves no row
    // in or out of this count.
    const [retained] = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count
        FROM team_password_entry_histories h
        JOIN team_password_entries e ON e.id = h.entry_id
       WHERE e.team_id = ${teamId}::uuid
         AND h.item_key_id IS DISTINCT FROM e.item_key_id
    `;

    return {
      pendingCount,
      stateCounts,
      rekeyersByVersion,
      retainedHistoryCount: Number(retained?.count ?? 0),
      entryIds: page.map((e) => e.id),
    };
  });

  if (!result) {
    return notFound();
  }

  // Identity is hydrated after the team context closes (a holder who belongs
  // to another primary tenant has a users row RLS hides inside it).
  const users = await fetchUserDisplayMap(
    Object.values(result.rekeyersByVersion).flat(),
    BYPASS_GRANT.CROSS_TENANT_USER_LOOKUP,
  );
  const holders = Object.fromEntries(
    Object.entries(result.rekeyersByVersion).map(([version, ids]) => [
      version,
      ids.map((id) => displayIdentityOf(users, id)),
    ]),
  );

  return NextResponse.json({
    pendingCount: result.pendingCount,
    stateCounts: result.stateCounts,
    holders,
    retainedHistoryCount: result.retainedHistoryCount,
    entryIds: result.entryIds,
  });
}

export const GET = withRequestLog(handleGET);
