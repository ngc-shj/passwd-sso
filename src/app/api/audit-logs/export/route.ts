import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { z } from "zod/v4";
import { API_ERROR } from "@/lib/api-error-codes";
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
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const result = bodySchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: API_ERROR.INVALID_BODY }, { status: 400 });
  }

  const {
    teamId,
    entryCount,
    format,
    filename,
    encrypted,
    includeTeams,
  } = result.data;

  // Verify team membership when teamId is specified
  if (teamId) {
    try {
      await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
    } catch (e) {
      if (e instanceof TeamAuthError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
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
