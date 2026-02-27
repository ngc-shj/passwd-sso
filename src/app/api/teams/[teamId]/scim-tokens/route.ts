import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { generateScimToken } from "@/lib/scim/token-utils";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { z } from "zod";
import { withTeamTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string }> };

const createTokenSchema = z.object({
  description: z.string().max(255).optional(),
  /** Expiry in days. null = never expires. Default = 365. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional().default(365),
});

function handleTeamTenantError(e: unknown): NextResponse | null {
  if (e instanceof Error && e.message === "TENANT_NOT_RESOLVED") {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (e instanceof TeamAuthError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  return null;
}

async function resolveTeamTenantId(teamId: string): Promise<string | null> {
  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { tenantId: true },
    }),
  );
  return team?.tenantId ?? null;
}

// GET /api/teams/[teamId]/scim-tokens — List SCIM tokens
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await withTeamTenantRls(teamId, async () =>
      requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.SCIM_MANAGE),
    );
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }

  let tokens;
  try {
    const tenantId = await resolveTeamTenantId(teamId);
    if (!tenantId) {
      return NextResponse.json(
        { error: API_ERROR.SCIM_TOKEN_INVALID },
        { status: 409 },
      );
    }

    tokens = await withTeamTenantRls(teamId, async () =>
      prisma.scimToken.findMany({
        where: { tenantId },
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
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }

  return NextResponse.json(tokens);
}

// POST /api/teams/[teamId]/scim-tokens — Generate a new SCIM token
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await withTeamTenantRls(teamId, async () =>
      requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.SCIM_MANAGE),
    );
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
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

  let tenantId: string;
  try {
    const resolvedTenantId = await resolveTeamTenantId(teamId);
    if (!resolvedTenantId) {
      return NextResponse.json(
        { error: API_ERROR.SCIM_TOKEN_INVALID },
        { status: 409 },
      );
    }
    tenantId = resolvedTenantId;
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }

  // Limit active (non-revoked, non-expired) tokens per tenant (max 10)
  let tokenCount;
  try {
    tokenCount = await withTeamTenantRls(teamId, async () =>
      prisma.scimToken.count({
        where: {
          tenantId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      }),
    );
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }
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

  let token;
  try {
    token = await withTeamTenantRls(teamId, async () =>
      prisma.scimToken.create({
        data: {
          teamId: teamId,
          tenantId,
          tokenHash,
          description: parsed.data.description ?? null,
          expiresAt,
          createdById: session.user.id,
        },
      }),
    );
  } catch (e) {
    const err = handleTeamTenantError(e);
    if (err) return err;
    throw e;
  }

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.SCIM_TOKEN_CREATE,
    userId: session.user.id,
    teamId: teamId,
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
