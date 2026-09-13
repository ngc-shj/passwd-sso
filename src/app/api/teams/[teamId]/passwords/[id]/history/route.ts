import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamMember } from "@/lib/auth/access/team-auth";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { HISTORY_PAGE_SIZE } from "@/lib/validations/common.server";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { displayIdentityOf, fetchUserDisplayMap } from "@/lib/audit/audit-user-lookup";

type Params = { params: Promise<{ teamId: string; id: string }> };

// GET /api/teams/[teamId]/passwords/[id]/history - List team entry history
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamMember(session.user.id, teamId, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const entry = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntry.findUnique({
      where: { id },
      select: { teamId: true },
    }),
  );

  if (!entry || entry.teamId !== teamId) {
    return notFound();
  }

  const histories = await withTeamTenantRls(teamId, async () =>
    prisma.teamPasswordEntryHistory.findMany({
      where: { entryId: id },
      orderBy: { changedAt: "desc" },
      take: HISTORY_PAGE_SIZE,
      // The changer is hydrated below, outside the team's tenant context: a guest
      // from another primary tenant, or a member who has since left, has a users
      // row RLS hides there, and the REQUIRED relation comes back null — measured:
      // Prisma does not throw.
    }),
  );
  const changers = await fetchUserDisplayMap(
    histories.map((h) => h.changedById),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );

  return NextResponse.json(
    histories.map((h) => ({
      id: h.id,
      entryId: h.entryId,
      encryptedBlob: {
        ciphertext: h.encryptedBlob,
        iv: h.blobIv,
        authTag: h.blobAuthTag,
      },
      aadVersion: h.aadVersion,
      teamKeyVersion: h.teamKeyVersion,
      itemKeyVersion: h.itemKeyVersion,
      changedAt: h.changedAt,
      changedBy: displayIdentityOf(changers, h.changedById),
    })),
  );
}

export const GET = withRequestLog(handleGET);
