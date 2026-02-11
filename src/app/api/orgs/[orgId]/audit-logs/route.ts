import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { unwrapOrgKey, decryptServerData } from "@/lib/crypto-server";
import { buildOrgEntryAAD } from "@/lib/crypto-aad";
import type { AuditAction } from "@prisma/client";

type Params = { params: Promise<{ orgId: string }> };

const VALID_ACTIONS: Set<string> = new Set([
  "AUTH_LOGIN",
  "AUTH_LOGOUT",
  "ENTRY_CREATE",
  "ENTRY_UPDATE",
  "ENTRY_DELETE",
  "ENTRY_RESTORE",
  "ENTRY_EXPORT",
  "ATTACHMENT_UPLOAD",
  "ATTACHMENT_DELETE",
  "ORG_MEMBER_INVITE",
  "ORG_MEMBER_REMOVE",
  "ORG_ROLE_UPDATE",
  "SHARE_CREATE",
  "SHARE_REVOKE",
]);

const ACTION_GROUPS: Record<string, AuditAction[]> = {
  "group:entry": ["ENTRY_CREATE", "ENTRY_UPDATE", "ENTRY_DELETE", "ENTRY_RESTORE"],
  "group:attachment": ["ATTACHMENT_UPLOAD", "ATTACHMENT_DELETE"],
  "group:org": ["ORG_MEMBER_INVITE", "ORG_MEMBER_REMOVE", "ORG_ROLE_UPDATE"],
  "group:share": ["SHARE_CREATE", "SHARE_REVOKE"],
};

// GET /api/orgs/[orgId]/audit-logs — Org audit logs (ADMIN/OWNER only)
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, "org:update");
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const actionsParam = searchParams.get("actions");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const cursor = searchParams.get("cursor");
  const limitParam = searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 100);

  const where: Record<string, unknown> = {
    orgId,
    scope: "ORG",
  };

  if (actionsParam) {
    const requested = actionsParam.split(",").map((a) => a.trim()).filter(Boolean);
    const invalid = requested.filter((a) => !VALID_ACTIONS.has(a as AuditAction));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { actions: invalid } },
        { status: 400 }
      );
    }
    where.action = { in: requested };
  } else if (action) {
    if (ACTION_GROUPS[action]) {
      where.action = { in: ACTION_GROUPS[action] };
    } else if (VALID_ACTIONS.has(action as AuditAction)) {
      where.action = action;
    }
  }

  if (from || to) {
    const createdAt: Record<string, Date> = {};
    if (from) createdAt.gte = new Date(from);
    if (to) createdAt.lte = new Date(to);
    where.createdAt = createdAt;
  }

  let logs;
  try {
    logs = await prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_CURSOR }, { status: 400 });
  }

  const hasMore = logs.length > limit;
  const items = hasMore ? logs.slice(0, limit) : logs;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  // Resolve entry names for OrgPasswordEntry targets
  const entryIds = [
    ...new Set(
      items
        .filter((l) => l.targetType === "OrgPasswordEntry" && l.targetId)
        .map((l) => l.targetId as string)
    ),
  ];

  const entryNames: Record<string, string> = {};

  if (entryIds.length > 0) {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
          encryptedOrgKey: true,
          orgKeyIv: true,
          orgKeyAuthTag: true,
        },
      });

      if (org) {
        const orgKey = unwrapOrgKey({
          ciphertext: org.encryptedOrgKey,
          iv: org.orgKeyIv,
          authTag: org.orgKeyAuthTag,
        });

        const entries = await prisma.orgPasswordEntry.findMany({
          where: { id: { in: entryIds } },
          select: {
            id: true,
            encryptedOverview: true,
            overviewIv: true,
            overviewAuthTag: true,
            aadVersion: true,
          },
        });

        for (const e of entries) {
          try {
            const aad =
              e.aadVersion >= 1
                ? Buffer.from(buildOrgEntryAAD(orgId, e.id, "overview"))
                : undefined;
            const overview = JSON.parse(
              decryptServerData(
                {
                  ciphertext: e.encryptedOverview,
                  iv: e.overviewIv,
                  authTag: e.overviewAuthTag,
                },
                orgKey,
                aad
              )
            );
            entryNames[e.id] = overview.title ?? e.id;
          } catch {
            // Decryption failed — skip this entry
          }
        }
      }
    } catch {
      // Non-critical: continue without entry names
    }
  }

  return NextResponse.json({
    items: items.map((log) => ({
      id: log.id,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata,
      ip: log.ip,
      userAgent: log.userAgent,
      createdAt: log.createdAt,
      user: log.user,
    })),
    nextCursor,
    entryNames,
  });
}
