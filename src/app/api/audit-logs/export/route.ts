import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { z } from "zod/v4";
import { errorResponse, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE, EXPORT_FORMAT_VALUES } from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";

const bodySchema = z.object({
  teamId: z.string().optional(),
  entryCount: z.number().int().min(0),
  format: z.enum(EXPORT_FORMAT_VALUES),
  filename: z.string().trim().min(1).max(255).optional(),
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
      if (e instanceof TeamAuthError) {
        return errorResponse(e.message, e.status);
      }
      throw e;
    }
  }

  logAudit({
    scope: teamId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_EXPORT,
    userId: session.user.id,
    teamId: teamId ?? undefined,
    metadata: {
      entryCount,
      format,
      ...(filename ? { filename } : {}),
      ...(typeof encrypted === "boolean" ? { encrypted } : {}),
      ...(typeof includeTeams === "boolean" ? { includeTeams } : {}),
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
