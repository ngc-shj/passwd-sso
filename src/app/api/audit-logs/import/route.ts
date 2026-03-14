import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { z } from "zod/v4";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { AUDIT_ACTION, AUDIT_SCOPE, IMPORT_FORMAT_VALUES } from "@/lib/constants";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";

const bodySchema = z.object({
  requestedCount: z.number().int().min(0),
  successCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  filename: z.string().trim().min(1).max(255).optional(),
  format: z.enum(IMPORT_FORMAT_VALUES).optional(),
  encrypted: z.boolean().optional(),
  teamId: z.string().uuid().optional(),
});

// POST /api/audit-logs/import — Record import summary audit event (personal or team)
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { requestedCount, successCount, failedCount, filename, format, encrypted, teamId } = parsed.data;

  // Verify team membership when logging team import
  if (teamId) {
    try {
      await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_CREATE);
    } catch (e) {
      if (e instanceof TeamAuthError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  }

  logAudit({
    scope: teamId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_IMPORT,
    userId: session.user.id,
    ...(teamId ? { teamId } : {}),
    metadata: {
      requestedCount,
      successCount,
      failedCount,
      ...(filename ? { filename } : {}),
      ...(format ? { format } : {}),
      ...(typeof encrypted === "boolean" ? { encrypted } : {}),
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
