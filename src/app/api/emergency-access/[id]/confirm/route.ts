import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { confirmEmergencyGrantSchema } from "@/lib/validations";
import { canTransition } from "@/lib/emergency-access-state";
import { SUPPORTED_KEY_ALGORITHMS } from "@/lib/crypto-emergency";
import { logAudit, extractRequestMeta } from "@/lib/audit";

// POST /api/emergency-access/[id]/confirm — Owner performs key escrow
export async function POST(
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

  if (!grant || grant.ownerId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!canTransition(grant.status, "IDLE")) {
    return NextResponse.json(
      { error: `Cannot confirm grant in ${grant.status} status` },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = confirmEmergencyGrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { ownerEphemeralPublicKey, encryptedSecretKey, secretKeyIv, secretKeyAuthTag, hkdfSalt, wrapVersion, keyVersion } = parsed.data;

  // Validate keyAlgorithm is compatible with wrapVersion
  const allowedAlgorithms = SUPPORTED_KEY_ALGORITHMS[wrapVersion];
  if (!allowedAlgorithms?.includes(grant.keyAlgorithm)) {
    return NextResponse.json(
      { error: `keyAlgorithm '${grant.keyAlgorithm}' is not compatible with wrapVersion ${wrapVersion}` },
      { status: 400 }
    );
  }

  await prisma.emergencyAccessGrant.update({
    where: { id },
    data: {
      status: "IDLE",
      ownerEphemeralPublicKey,
      encryptedSecretKey,
      secretKeyIv,
      secretKeyAuthTag,
      hkdfSalt,
      wrapVersion,
      keyVersion,
    },
  });

  logAudit({
    scope: "PERSONAL",
    action: "EMERGENCY_GRANT_CONFIRM",
    userId: session.user.id,
    targetType: "EmergencyAccessGrant",
    targetId: id,
    metadata: { granteeId: grant.granteeId, wrapVersion, keyVersion },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ status: "IDLE" });
}
