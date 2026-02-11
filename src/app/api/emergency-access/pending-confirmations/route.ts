import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

// GET /api/emergency-access/pending-confirmations
// Returns ACCEPTED grants owned by the current user that need key escrow
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const grants = await prisma.emergencyAccessGrant.findMany({
    where: {
      ownerId: session.user.id,
      status: "ACCEPTED",
      granteePublicKey: { not: null },
      encryptedSecretKey: null,
    },
    select: {
      id: true,
      granteeId: true,
      granteePublicKey: true,
      keyAlgorithm: true,
      grantee: { select: { name: true, email: true } },
    },
  });

  return NextResponse.json(grants);
}
