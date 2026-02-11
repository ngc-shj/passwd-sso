import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";

// GET /api/emergency-access/[id]/vault/entries — Fetch owner's encrypted entries
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { id },
  });

  if (!grant || grant.granteeId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (grant.status !== "ACTIVATED") {
    return NextResponse.json(
      { error: "Emergency access not activated" },
      { status: 403 }
    );
  }

  // Fetch all non-deleted entries for the owner
  const entries = await prisma.passwordEntry.findMany({
    where: {
      userId: grant.ownerId,
      deletedAt: null,
    },
    select: {
      id: true,
      encryptedBlob: true,
      blobIv: true,
      blobAuthTag: true,
      encryptedOverview: true,
      overviewIv: true,
      overviewAuthTag: true,
      keyVersion: true,
      aadVersion: true,
      entryType: true,
      isFavorite: true,
      isArchived: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  logAudit({
    scope: "PERSONAL",
    action: "EMERGENCY_VAULT_ACCESS",
    userId: session.user.id,
    targetType: "EmergencyAccessGrant",
    targetId: id,
    metadata: { ownerId: grant.ownerId, entryCount: entries.length },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(entries);
}
