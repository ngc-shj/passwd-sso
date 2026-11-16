import type { NextRequest } from "next/server";
import { getTeamMembership, requireTeamPermission, TeamAuthError } from "@/lib/auth/access/team-auth";
import { PolicyViolationError, withTeamIpRestriction } from "@/lib/team/team-policy";
import { TEAM_PERMISSION } from "@/lib/constants";

export const SHARE_LINK_MANAGER = {
  CREATOR: "creator",
  TEAM_ADMIN: "team_admin",
} as const;

export type ShareLinkManager = (typeof SHARE_LINK_MANAGER)[keyof typeof SHARE_LINK_MANAGER];

/**
 * Who may manage a share link: its creator, and for a team entry's link a team
 * OWNER/ADMIN (PASSWORD_DELETE) of that team (#995) — revoke takes either, the
 * access log only the creator. Personal shares and Sends are the creator's
 * only. Null for anyone else, which callers answer as not found.
 *
 * A team entry's link is held to the team's IP restriction for both: the
 * admin's through the permission check, the creator's directly. By default the
 * creator needs no membership, so one who has left the team can still revoke
 * their own link. With `requireMembership` a team link's creator is the creator
 * only while holding a live membership (getTeamMembership: a leftover counts as
 * none): the access log holds viewers' IP addresses and user agents, which a
 * departed member keeps no claim to.
 */
export async function shareLinkManagerOf(
  userId: string,
  share: { createdById: string; teamPasswordEntry: { teamId: string } | null },
  req: NextRequest,
  { requireMembership = false }: { requireMembership?: boolean } = {},
): Promise<ShareLinkManager | null> {
  const teamId = share.teamPasswordEntry?.teamId;
  if (share.createdById === userId) {
    if (!teamId) return SHARE_LINK_MANAGER.CREATOR;
    if (requireMembership && !(await getTeamMembership(userId, teamId))) return null;
    try {
      await withTeamIpRestriction(teamId, req, userId);
      return SHARE_LINK_MANAGER.CREATOR;
    } catch (e) {
      if (e instanceof PolicyViolationError) return null;
      throw e;
    }
  }
  if (!teamId) return null;
  try {
    await requireTeamPermission(userId, teamId, TEAM_PERMISSION.PASSWORD_DELETE, req);
    return SHARE_LINK_MANAGER.TEAM_ADMIN;
  } catch (e) {
    if (e instanceof TeamAuthError) return null;
    throw e;
  }
}
