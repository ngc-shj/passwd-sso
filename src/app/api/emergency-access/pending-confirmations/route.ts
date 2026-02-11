import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";

// GET /api/emergency-access/pending-confirmations
// Returns ACCEPTED/STALE grants owned by the current user that need key escrow
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const grants = await prisma.emergencyAccessGrant.findMany({
    where: {
      ownerId: session.user.id,
      granteePublicKey: { not: null },
      OR: [
        // ACCEPTED: first-time escrow (no encryptedSecretKey yet)
        { status: "ACCEPTED", encryptedSecretKey: null },
        // STALE: re-escrow needed after keyVersion bump
        { status: "STALE" },
      ],
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
