/**
 * Whether a team webhook's creator still holds the authority to own it.
 *
 * Import-safe on purpose: the audit-outbox worker and the webhooks route both
 * call it, and team-auth.ts imports @/lib/prisma, which the worker must not
 * load eagerly. Keep this module free of server singletons.
 */

import { TEAM_PERMISSION } from "@/lib/constants";
import { hasTeamPermission } from "@/lib/auth/access/team-permissions";
import type { Prisma, TeamRole } from "@prisma/client";

/**
 * "legacy" — the webhook predates created_by_id (NULL), so no creator to check.
 * true / false — the creator has / has not current authority in the webhook's
 * team (an active membership whose role holds TEAM_UPDATE).
 */
export function webhookCreatorAuthorized(
  createdById: string | null,
  member: { role: TeamRole; deactivatedAt: Date | null } | null,
): "legacy" | boolean {
  if (createdById === null) return "legacy";
  return (
    member !== null &&
    member.deactivatedAt === null &&
    hasTeamPermission(member.role, TEAM_PERMISSION.TEAM_UPDATE)
  );
}

/**
 * The verdict per webhook id for one team's webhooks, from one read of their
 * creators' memberships. The worker skips `false`; the webhooks GET shows it as
 * paused — one lookup, so the two cannot disagree.
 */
export async function webhookCreatorVerdicts(
  tx: Pick<Prisma.TransactionClient, "teamMember">,
  teamId: string,
  webhooks: readonly { id: string; createdById: string | null }[],
): Promise<Map<string, "legacy" | boolean>> {
  const creatorIds = [
    ...new Set(webhooks.flatMap((w) => (w.createdById === null ? [] : [w.createdById]))),
  ];
  const members =
    creatorIds.length === 0
      ? []
      : await tx.teamMember.findMany({
          where: { teamId, userId: { in: creatorIds } },
          select: { userId: true, role: true, deactivatedAt: true },
        });
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));
  return new Map(
    webhooks.map((w) => [
      w.id,
      webhookCreatorAuthorized(
        w.createdById,
        w.createdById === null ? null : (memberByUserId.get(w.createdById) ?? null),
      ),
    ]),
  );
}
