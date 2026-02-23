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

class TxValidationError extends Error {
  details: Record<string, unknown>;
  constructor(details: Record<string, unknown>) {
    super("TX_VALIDATION_ERROR");
    this.details = details;
  }
}

const encryptedFieldSchema = z.object({
  ciphertext: z.string().min(1).max(500_000),
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
  ).max(1000),
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
    select: { orgKeyVersion: true },
  });

  if (!org) {
    return NextResponse.json({ error: API_ERROR.ORG_NOT_FOUND }, { status: 404 });
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

  // Interactive transaction with optimistic lock on orgKeyVersion (S-17)
  // Member list verification is inside transaction to prevent TOCTOU (F-26)
  try {
    await prisma.$transaction(async (tx) => {
      // Re-verify orgKeyVersion hasn't changed since pre-read
      const currentOrg = await tx.organization.findUnique({
        where: { id: orgId },
        select: { orgKeyVersion: true },
      });
      if (!currentOrg || currentOrg.orgKeyVersion !== org.orgKeyVersion) {
        throw new Error("ORG_KEY_VERSION_CONFLICT");
      }

      // Verify all current members have a key in the payload (F-26: inside tx)
      const members = await tx.orgMember.findMany({
        where: { orgId },
        select: { userId: true },
      });
      const memberUserIds = new Set(members.map((m) => m.userId));
      for (const userId of memberUserIds) {
        if (!memberKeys.some((k) => k.userId === userId)) {
          throw new TxValidationError({ missingKeyFor: userId });
        }
      }
      // Reject extra memberKeys for non-members (F-18/S-22)
      for (const k of memberKeys) {
        if (!memberUserIds.has(k.userId)) {
          throw new TxValidationError({ unknownUserId: k.userId });
        }
      }

      // Verify submitted entries exactly match ALL org entries (including trash)
      const allEntries = await tx.orgPasswordEntry.findMany({
        where: { orgId },
        select: { id: true },
      });
      if (entries.length !== allEntries.length) {
        throw new Error("ENTRY_COUNT_MISMATCH");
      }
      const allEntryIdSet = new Set(allEntries.map((e) => e.id));
      const submittedEntryIdSet = new Set(entries.map((e) => e.id));
      if (
        submittedEntryIdSet.size !== entries.length ||
        submittedEntryIdSet.size !== allEntryIdSet.size
      ) {
        throw new Error("ENTRY_COUNT_MISMATCH");
      }
      for (const entryId of submittedEntryIdSet) {
        if (!allEntryIdSet.has(entryId)) {
          throw new Error("ENTRY_COUNT_MISMATCH");
        }
      }

      // Re-encrypt all entries with new key.
      // updateMany + orgId scope prevents out-of-org updates.
      // orgKeyVersion is NOT in where: entries restored from history may have
      // a stale version, but the ID set verification above guarantees completeness (F-29).
      await Promise.all(entries.map(async (entry) => {
        const result = await tx.orgPasswordEntry.updateMany({
          where: {
            id: entry.id,
            orgId,
          },
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
        });
        if (result.count !== 1) {
          throw new Error("ENTRY_COUNT_MISMATCH");
        }
      }));

      // Create new OrgMemberKey for each member (old keys kept for history)
      // No filter needed: member validation above guarantees exact 1:1 match
      await Promise.all(
        memberKeys.map((k) =>
            tx.orgMemberKey.create({
              data: {
                orgId,
                userId: k.userId,
                encryptedOrgKey: k.encryptedOrgKey,
                orgKeyIv: k.orgKeyIv,
                orgKeyAuthTag: k.orgKeyAuthTag,
                ephemeralPublicKey: k.ephemeralPublicKey,
                hkdfSalt: k.hkdfSalt,
                keyVersion: newOrgKeyVersion,
                wrapVersion: k.wrapVersion,
              },
            })
          )
      );

      // Bump org key version
      await tx.organization.update({
        where: { id: orgId },
        data: { orgKeyVersion: newOrgKeyVersion },
      });
    });
  } catch (e) {
    if (e instanceof Error && e.message === "ORG_KEY_VERSION_CONFLICT") {
      return NextResponse.json(
        { error: API_ERROR.ORG_KEY_VERSION_MISMATCH },
        { status: 409 }
      );
    }
    if (e instanceof Error && e.message === "ENTRY_COUNT_MISMATCH") {
      return NextResponse.json(
        { error: API_ERROR.ENTRY_COUNT_MISMATCH },
        { status: 400 }
      );
    }
    if (e instanceof TxValidationError) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: e.details },
        { status: 400 }
      );
    }
    throw e;
  }

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
