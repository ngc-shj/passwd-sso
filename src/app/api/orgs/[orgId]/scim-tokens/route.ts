import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { generateScimToken } from "@/lib/scim/token-utils";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { z } from "zod";

type Params = { params: Promise<{ orgId: string }> };

const createTokenSchema = z.object({
  description: z.string().max(255).optional(),
  /** Expiry in days. null = never expires. Default = 365. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional().default(365),
});

// GET /api/orgs/[orgId]/scim-tokens — List SCIM tokens
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.SCIM_MANAGE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const tokens = await prisma.scimToken.findMany({
    where: { orgId },
    select: {
      id: true,
      description: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(tokens);
}

// POST /api/orgs/[orgId]/scim-tokens — Generate a new SCIM token
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { orgId } = await params;

  try {
    await requireOrgPermission(session.user.id, orgId, ORG_PERMISSION.SCIM_MANAGE);
  } catch (e) {
    if (e instanceof OrgAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Limit active (non-revoked, non-expired) tokens per org (max 10)
  const tokenCount = await prisma.scimToken.count({
    where: {
      orgId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (tokenCount >= 10) {
    return NextResponse.json(
      { error: API_ERROR.SCIM_TOKEN_LIMIT_EXCEEDED },
      { status: 409 },
    );
  }

  const plaintext = generateScimToken();
  const tokenHash = hashToken(plaintext);

  const expiresAt = parsed.data.expiresInDays
    ? new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  const token = await prisma.scimToken.create({
    data: {
      orgId,
      tokenHash,
      description: parsed.data.description ?? null,
      expiresAt,
      createdById: session.user.id,
    },
  });

  logAudit({
    scope: AUDIT_SCOPE.ORG,
    action: AUDIT_ACTION.SCIM_TOKEN_CREATE,
    userId: session.user.id,
    orgId,
    targetType: AUDIT_TARGET_TYPE.SCIM_TOKEN,
    targetId: token.id,
    metadata: { description: parsed.data.description, expiresInDays: parsed.data.expiresInDays },
    ...extractRequestMeta(req),
  });

  // Return plaintext only once
  return NextResponse.json(
    {
      id: token.id,
      token: plaintext,
      description: token.description,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    },
    { status: 201 },
  );
}
