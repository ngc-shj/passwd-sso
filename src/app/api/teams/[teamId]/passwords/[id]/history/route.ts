import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamMember, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string; id: string }> };

// GET /api/teams/[teamId]/passwords/[id]/history - List team entry history
async function handleGET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, id } = await params;

  try {
    await requireTeamMember(session.user.id, teamId);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
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
      include: { changedBy: { select: { id: true, name: true, email: true } } },
    }),
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
      changedBy: h.changedBy,
    })),
  );
}

export const GET = withRequestLog(handleGET);
