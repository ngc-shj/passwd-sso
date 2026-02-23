import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { orgMemberKeySchema } from "@/lib/validations";

type Params = { params: Promise<{ orgId: string }> };

const encryptedFieldSchema = z.object({
  ciphertext: z.string().min(1),
  iv: z.string().length(24),
  authTag: z.string().length(32),
});

const rotateKeySchema = z.object({
  newOrgKeyVersion: z.number().int().min(2),
  entries: z.array(
    z.object({
      id: z.string().min(1),
      encryptedBlob: encryptedFieldSchema,
      encryptedOverview: encryptedFieldSchema,
      aadVersion: z.number().int().min(1),
    })
  ),
  memberKeys: z.array(
    z.object({
      userId: z.string().min(1),
    }).merge(orgMemberKeySchema)
  ).min(1),
});

// POST /api/orgs/[orgId]/rotate-key — Rotate org encryption key
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.ORG_UPDATE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { e2eEnabled: true, orgKeyVersion: true },
  });

  if (!org) {
    return NextResponse.json({ error: API_ERROR.ORG_NOT_FOUND }, { status: 404 });
  }

  if (!org.e2eEnabled) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = rotateKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { newOrgKeyVersion, entries, memberKeys } = parsed.data;

  // Validate version increment
  if (newOrgKeyVersion !== org.orgKeyVersion + 1) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: { expected: org.orgKeyVersion + 1 } },
      { status: 409 }
    );
  }

  // Verify all current members have a key in the payload
  const members = await prisma.orgMember.findMany({
    where: { orgId },
    select: { userId: true },
  });

  const memberUserIds = new Set(members.map((m) => m.userId));
  for (const userId of memberUserIds) {
    if (!memberKeys.some((k) => k.userId === userId)) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { missingKeyFor: userId } },
        { status: 400 }
      );
    }
  }

  // Transaction: update all entries + create new OrgMemberKeys + bump orgKeyVersion
  await prisma.$transaction([
    // Re-encrypt all entries with new key
    ...entries.map((entry) =>
      prisma.orgPasswordEntry.update({
        where: { id: entry.id, orgId },
        data: {
          encryptedBlob: entry.encryptedBlob.ciphertext,
          blobIv: entry.encryptedBlob.iv,
          blobAuthTag: entry.encryptedBlob.authTag,
          encryptedOverview: entry.encryptedOverview.ciphertext,
          overviewIv: entry.encryptedOverview.iv,
          overviewAuthTag: entry.encryptedOverview.authTag,
          aadVersion: entry.aadVersion,
          orgKeyVersion: newOrgKeyVersion,
        },
      })
    ),

    // Create new OrgMemberKey for each member (old keys kept for history)
    ...memberKeys
      .filter((k) => memberUserIds.has(k.userId))
      .map((k) =>
        prisma.orgMemberKey.create({
          data: {
            orgId,
            userId: k.userId,
            encryptedOrgKey: k.encryptedOrgKey,
            orgKeyIv: k.orgKeyIv,
            orgKeyAuthTag: k.orgKeyAuthTag,
            ephemeralPublicKey: k.ephemeralPublicKey,
            hkdfSalt: k.hkdfSalt,
            keyVersion: newOrgKeyVersion,
          },
        })
      ),

    // Bump org key version
    prisma.organization.update({
      where: { id: orgId },
      data: { orgKeyVersion: newOrgKeyVersion },
    }),
  ]);

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.ORG_KEY_ROTATION,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.ORG_PASSWORD_ENTRY,
    targetId: orgId,
    metadata: {
      fromVersion: org.orgKeyVersion,
      toVersion: newOrgKeyVersion,
      entriesRotated: entries.length,
      membersUpdated: memberKeys.length,
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({
    success: true,
    orgKeyVersion: newOrgKeyVersion,
  });
}
