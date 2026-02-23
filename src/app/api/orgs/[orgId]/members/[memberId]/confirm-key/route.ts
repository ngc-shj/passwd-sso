import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { orgMemberKeySchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION } from "@/lib/constants";

type Params = { params: Promise<{ orgId: string; memberId: string }> };

// POST /api/orgs/[orgId]/members/[memberId]/confirm-key
// Admin distributes the org key to a member by encrypting it with member's ECDH public key
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId, memberId } = await params;

  // Only OWNER/ADMIN can distribute keys (mapped to MEMBER_INVITE permission)
  try {
    await requireOrgPermission(
      session.user.id,
      orgId,
      ORG_PERMISSION.MEMBER_INVITE
    );
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  // Verify the org is E2E-enabled
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { e2eEnabled: true, orgKeyVersion: true },
  });

  if (!org?.e2eEnabled) {
    return NextResponse.json(
      { error: API_ERROR.FORBIDDEN },
      { status: 403 }
    );
  }

  // Verify target member exists and belongs to this org
  const targetMember = await prisma.orgMember.findUnique({
    where: { id: memberId },
    select: { orgId: true, userId: true, keyDistributed: true },
  });

  if (!targetMember || targetMember.orgId !== orgId) {
    return NextResponse.json(
      { error: API_ERROR.MEMBER_NOT_FOUND },
      { status: 404 }
    );
  }

  // Verify the target user has an ECDH public key (vault set up)
  const targetUser = await prisma.user.findUnique({
    where: { id: targetMember.userId },
    select: { ecdhPublicKey: true },
  });

  if (!targetUser?.ecdhPublicKey) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_NOT_READY },
      { status: 409 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = orgMemberKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;

  // Upsert to prevent race conditions (@@unique [orgId, userId, keyVersion])
  await prisma.$transaction([
    prisma.orgMemberKey.upsert({
      where: {
        orgId_userId_keyVersion: {
          orgId,
          userId: targetMember.userId,
          keyVersion: data.keyVersion,
        },
      },
      create: {
        orgId,
        userId: targetMember.userId,
        encryptedOrgKey: data.encryptedOrgKey,
        orgKeyIv: data.orgKeyIv,
        orgKeyAuthTag: data.orgKeyAuthTag,
        ephemeralPublicKey: data.ephemeralPublicKey,
        hkdfSalt: data.hkdfSalt,
        keyVersion: data.keyVersion,
      },
      update: {
        encryptedOrgKey: data.encryptedOrgKey,
        orgKeyIv: data.orgKeyIv,
        orgKeyAuthTag: data.orgKeyAuthTag,
        ephemeralPublicKey: data.ephemeralPublicKey,
        hkdfSalt: data.hkdfSalt,
      },
    }),
    prisma.orgMember.update({
      where: { id: memberId },
      data: { keyDistributed: true },
    }),
  ]);

  return NextResponse.json({ success: true });
}
