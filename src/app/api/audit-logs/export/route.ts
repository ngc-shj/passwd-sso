import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAuditAsync, personalAuditBase, teamAuditBase } from "@/lib/audit";
import { requireTeamPermission } from "@/lib/team-auth";
import { assertPolicyAllowsExport, PolicyViolationError } from "@/lib/team-policy";
import { z } from "zod/v4";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { TEAM_PERMISSION, AUDIT_ACTION, EXPORT_FORMAT_VALUES } from "@/lib/constants";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { FILENAME_MAX_LENGTH } from "@/lib/validations/common";

const bodySchema = z.object({
  teamId: z.string().optional(),
  entryCount: z.number().int().min(0),
  format: z.enum(EXPORT_FORMAT_VALUES),
  filename: z.string().trim().min(1).max(FILENAME_MAX_LENGTH).optional(),
  encrypted: z.boolean().optional(),
  includeTeams: z.boolean().optional(),
});

// POST /api/audit-logs/export — Record export audit event
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const {
    teamId,
    entryCount,
    format,
    filename,
    encrypted,
    includeTeams,
  } = parsed.data;

  // Verify team membership when teamId is specified
  if (teamId) {
    try {
      await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
    } catch (e) {
      return handleAuthError(e);
    }

    // Check team policy allows export
    try {
      await assertPolicyAllowsExport(teamId);
    } catch (e) {
      if (e instanceof PolicyViolationError) {
        return errorResponse(API_ERROR.POLICY_EXPORT_DISABLED, 403);
      }
      throw e;
    }
  }

  await logAuditAsync({
    ...(teamId
      ? teamAuditBase(req, session.user.id, teamId)
      : personalAuditBase(req, session.user.id)),
    action: AUDIT_ACTION.ENTRY_EXPORT,
    metadata: {
      entryCount,
      format,
      ...(filename ? { filename } : {}),
      ...(typeof encrypted === "boolean" ? { encrypted } : {}),
      ...(typeof includeTeams === "boolean" ? { includeTeams } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
