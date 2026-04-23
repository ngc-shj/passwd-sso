import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { upsertTeamPolicySchema } from "@/lib/validations";
import {
  requireTeamMember,
  requireTeamPermission,
  TeamAuthError,
} from "@/lib/auth/access/team-auth";
import { parseBody } from "@/lib/http/parse-body";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";
import { invalidateSessionTimeoutCacheForTenant } from "@/lib/auth/session/session-timeout";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

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
    /** @deprecated use sessionAbsoluteTimeoutMinutes */
    maxSessionDurationMinutes: policy?.maxSessionDurationMinutes ?? null,
    sessionIdleTimeoutMinutes: policy?.sessionIdleTimeoutMinutes ?? null,
    sessionAbsoluteTimeoutMinutes: policy?.sessionAbsoluteTimeoutMinutes ?? null,
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

  // Enforce `team value <= tenant value` for session timeouts.
  const teamTenant = await withBypassRls(prisma, async () =>
    prisma.team.findUnique({
      where: { id: teamId },
      select: {
        tenantId: true,
        tenant: {
          select: {
            sessionIdleTimeoutMinutes: true,
            sessionAbsoluteTimeoutMinutes: true,
          },
        },
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!teamTenant) return notFound();

  if (
    result.data.sessionIdleTimeoutMinutes != null &&
    result.data.sessionIdleTimeoutMinutes > teamTenant.tenant.sessionIdleTimeoutMinutes
  ) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
      message: `sessionIdleTimeoutMinutes exceeds tenant cap of ${teamTenant.tenant.sessionIdleTimeoutMinutes} minutes`,
    });
  }
  if (
    result.data.sessionAbsoluteTimeoutMinutes != null &&
    result.data.sessionAbsoluteTimeoutMinutes > teamTenant.tenant.sessionAbsoluteTimeoutMinutes
  ) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
      message: `sessionAbsoluteTimeoutMinutes exceeds tenant cap of ${teamTenant.tenant.sessionAbsoluteTimeoutMinutes} minutes`,
    });
  }

  const policy = await withTeamTenantRls(teamId, async (tenantId) =>
    prisma.teamPolicy.upsert({
      where: { teamId },
      create: {
        teamId,
        tenantId,
        ...result.data,
      },
      update: result.data,
    }),
  );

  // Bust the resolver cache so session-expiry enforcement picks up the change.
  invalidateSessionTimeoutCacheForTenant(teamTenant.tenantId);

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.POLICY_UPDATE,
    targetType: AUDIT_TARGET_TYPE.TEAM,
    targetId: teamId,
    metadata: result.data,
  });

  return NextResponse.json({
    minPasswordLength: policy.minPasswordLength,
    requireUppercase: policy.requireUppercase,
    requireLowercase: policy.requireLowercase,
    requireNumbers: policy.requireNumbers,
    requireSymbols: policy.requireSymbols,
    /** @deprecated use sessionAbsoluteTimeoutMinutes */
    maxSessionDurationMinutes: policy.maxSessionDurationMinutes,
    sessionIdleTimeoutMinutes: policy.sessionIdleTimeoutMinutes,
    sessionAbsoluteTimeoutMinutes: policy.sessionAbsoluteTimeoutMinutes,
    requireRepromptForAll: policy.requireRepromptForAll,
    allowExport: policy.allowExport,
    allowSharing: policy.allowSharing,
    requireSharePassword: policy.requireSharePassword,
  });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
