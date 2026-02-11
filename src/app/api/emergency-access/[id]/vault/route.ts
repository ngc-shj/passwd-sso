import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";

const vaultLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// GET /api/emergency-access/[id]/vault — Get ECDH data for vault access
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await vaultLimiter.check(`rl:ea_vault:${session.user.id}`))) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;

  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { id },
    include: {
      granteeKeyPair: true,
      owner: { select: { name: true, email: true } },
    },
  });

  if (!grant || grant.granteeId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Auto-activate if wait period has expired
  if (grant.status === "REQUESTED" && grant.waitExpiresAt && grant.waitExpiresAt <= new Date()) {
    await prisma.emergencyAccessGrant.update({
      where: { id },
      data: { status: "ACTIVATED", activatedAt: new Date() },
    });
    grant.status = "ACTIVATED";

    logAudit({
      scope: "PERSONAL",
      action: "EMERGENCY_ACCESS_ACTIVATE",
      userId: session.user.id,
      targetType: "EmergencyAccessGrant",
      targetId: id,
      metadata: { ownerId: grant.ownerId },
      ...extractRequestMeta(req),
    });
  }

  if (grant.status !== "ACTIVATED") {
    return NextResponse.json(
      { error: "Emergency access not yet activated" },
      { status: 403 }
    );
  }

  if (!grant.encryptedSecretKey || !grant.granteeKeyPair) {
    return NextResponse.json(
      { error: "Key escrow not completed" },
      { status: 400 }
    );
  }

  return NextResponse.json({
    grantId: grant.id,
    ownerId: grant.ownerId,
    granteeId: grant.granteeId,
    ownerEphemeralPublicKey: grant.ownerEphemeralPublicKey,
    encryptedSecretKey: grant.encryptedSecretKey,
    secretKeyIv: grant.secretKeyIv,
    secretKeyAuthTag: grant.secretKeyAuthTag,
    hkdfSalt: grant.hkdfSalt,
    wrapVersion: grant.wrapVersion,
    keyVersion: grant.keyVersion,
    keyAlgorithm: grant.keyAlgorithm,
    granteeKeyPair: {
      encryptedPrivateKey: grant.granteeKeyPair.encryptedPrivateKey,
      privateKeyIv: grant.granteeKeyPair.privateKeyIv,
      privateKeyAuthTag: grant.granteeKeyPair.privateKeyAuthTag,
    },
    owner: grant.owner,
  });
}
