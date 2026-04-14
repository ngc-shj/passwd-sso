import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";

type Params = { params: Promise<{ teamId: string; webhookId: string }> };

// DELETE /api/teams/[teamId]/webhooks/[webhookId] — Delete a webhook
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId, webhookId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const webhook = await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.findFirst({
      where: { id: webhookId, teamId },
      select: { id: true, url: true },
    }),
  );

  if (!webhook) {
    return notFound();
  }

  await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.delete({ where: { id: webhookId, teamId } }),
  );

  await logAuditAsync({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.WEBHOOK_DELETE,
    userId: session.user.id,
    teamId,
    metadata: { webhookId, url: webhook.url },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
