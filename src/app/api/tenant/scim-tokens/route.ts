import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { generateScimToken } from "@/lib/scim/token-utils";
import { API_ERROR } from "@/lib/api-error-codes";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { z } from "zod";
import { SCIM_TOKEN_DESC_MAX_LENGTH } from "@/lib/validations";

export const runtime = "nodejs";

const createTokenSchema = z.object({
  description: z.string().max(SCIM_TOKEN_DESC_MAX_LENGTH).optional(),
  /** Expiry in days. null = never expires. Default = 365. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional().default(365),
});

// GET /api/tenant/scim-tokens — List SCIM tokens for the tenant
export async function GET(req: NextRequest) {
  void req;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.SCIM_MANAGE,
    );
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const tokens = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.scimToken.findMany({
      where: { tenantId: actor.tenantId },
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
    }),
  );

  return NextResponse.json(tokens);
}

// POST /api/tenant/scim-tokens — Generate a new SCIM token
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.SCIM_MANAGE,
    );
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
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

  // Limit active (non-revoked, non-expired) tokens per tenant (max 10)
  const tokenCount = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.scimToken.count({
      where: {
        tenantId: actor.tenantId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    }),
  );
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

  const token = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.scimToken.create({
      data: {
        tenantId: actor.tenantId,
        tokenHash,
        description: parsed.data.description ?? null,
        expiresAt,
        createdById: session.user.id,
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SCIM_TOKEN_CREATE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.SCIM_TOKEN,
    targetId: token.id,
    metadata: { description: parsed.data.description, expiresInDays: parsed.data.expiresInDays },
    ...extractRequestMeta(req),
  });

  // Return plaintext only once — no-store prevents caching of sensitive token
  return NextResponse.json(
    {
      id: token.id,
      token: plaintext,
      description: token.description,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
