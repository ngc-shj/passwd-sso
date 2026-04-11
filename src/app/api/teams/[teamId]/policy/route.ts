import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { upsertTeamPolicySchema } from "@/lib/validations";
import {
  requireTeamMember,
  requireTeamPermission,
  TeamAuthError,
} from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string }> };

function handleTeamAuthError(e: unknown): NextResponse | null {
  if (e instanceof Error && e.message === "TENANT_NOT_RESOLVED") {
    return notFound();
  }
  if (e instanceof TeamAuthError) {
    return errorResponse(e.message, e.status);
  }
  return null;
}

// GET /api/teams/[teamId]/policy — Get team policy (defaults if none set)
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamMember(session.user.id, teamId, req);
  } catch (e) {
    const err = handleTeamAuthError(e);
    if (err) return err;
    throw e;
  }

  const policy = await withTeamTenantRls(teamId, async () =>
    prisma.teamPolicy.findUnique({ where: { teamId } }),
  );

  return NextResponse.json({
    minPasswordLength: policy?.minPasswordLength ?? 0,
    requireUppercase: policy?.requireUppercase ?? false,
    requireLowercase: policy?.requireLowercase ?? false,
    requireNumbers: policy?.requireNumbers ?? false,
    requireSymbols: policy?.requireSymbols ?? false,
    maxSessionDurationMinutes: policy?.maxSessionDurationMinutes ?? null,
    requireRepromptForAll: policy?.requireRepromptForAll ?? false,
    allowExport: policy?.allowExport ?? true,
    allowSharing: policy?.allowSharing ?? true,
    requireSharePassword: policy?.requireSharePassword ?? false,
  });
}

// PUT /api/teams/[teamId]/policy — Upsert team policy (OWNER/ADMIN only)
async function handlePUT(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    const err = handleTeamAuthError(e);
    if (err) return err;
    throw e;
  }

  const result = await parseBody(req, upsertTeamPolicySchema);
  if (!result.ok) return result.response;

  // Resolve tenantId from team
  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: { tenantId: true },
    }),
  );
  if (!team) {
    return errorResponse(API_ERROR.TEAM_NOT_FOUND, 404);
  }

  const policy = await withTeamTenantRls(teamId, async () =>
    prisma.teamPolicy.upsert({
      where: { teamId },
      create: {
        teamId,
        tenantId: team.tenantId,
        ...result.data,
      },
      update: result.data,
    }),
  );

  const meta = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.POLICY_UPDATE,
    userId: session.user.id,
    teamId,
    targetType: AUDIT_TARGET_TYPE.TEAM,
    targetId: teamId,
    metadata: result.data,
    ...meta,
  });

  return NextResponse.json({
    minPasswordLength: policy.minPasswordLength,
    requireUppercase: policy.requireUppercase,
    requireLowercase: policy.requireLowercase,
    requireNumbers: policy.requireNumbers,
    requireSymbols: policy.requireSymbols,
    maxSessionDurationMinutes: policy.maxSessionDurationMinutes,
    requireRepromptForAll: policy.requireRepromptForAll,
    allowExport: policy.allowExport,
    allowSharing: policy.allowSharing,
    requireSharePassword: policy.requireSharePassword,
  });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
