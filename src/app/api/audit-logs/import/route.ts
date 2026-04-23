import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAuditAsync, personalAuditBase, teamAuditBase } from "@/lib/audit/audit";
import { z } from "zod/v4";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { AUDIT_ACTION, IMPORT_FORMAT_VALUES } from "@/lib/constants";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { TEAM_PERMISSION } from "@/lib/constants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { FILENAME_MAX_LENGTH } from "@/lib/validations/common";

const bodySchema = z.object({
  requestedCount: z.number().int().min(0),
  successCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  filename: z.string().trim().min(1).max(FILENAME_MAX_LENGTH).optional(),
  format: z.enum(IMPORT_FORMAT_VALUES).optional(),
  encrypted: z.boolean().optional(),
  teamId: z.string().uuid().optional(),
});

// POST /api/audit-logs/import — Record import summary audit event (personal or team)
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const parsed = await parseBody(req, bodySchema);
  if (!parsed.ok) return parsed.response;
  const { requestedCount, successCount, failedCount, filename, format, encrypted, teamId } = parsed.data;

  // Verify team membership when logging team import
  if (teamId) {
    try {
      await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_CREATE);
    } catch (e) {
      return handleAuthError(e);
    }
  }

  await logAuditAsync({
    ...(teamId
      ? teamAuditBase(req, session.user.id, teamId)
      : personalAuditBase(req, session.user.id)),
    action: AUDIT_ACTION.ENTRY_IMPORT,
    metadata: {
      requestedCount,
      successCount,
      failedCount,
      ...(filename ? { filename } : {}),
      ...(format ? { format } : {}),
      ...(typeof encrypted === "boolean" ? { encrypted } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
