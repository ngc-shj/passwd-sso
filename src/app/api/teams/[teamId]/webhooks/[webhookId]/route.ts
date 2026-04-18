import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/team-auth";
import { logAuditAsync, teamAuditBase } from "@/lib/audit";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
} from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { handleAuthError, notFound, unauthorized } from "@/lib/api-response";

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
    return handleAuthError(e);
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
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.WEBHOOK_DELETE,
    metadata: { webhookId, url: webhook.url },
  });

  return NextResponse.json({ success: true });
}

export const DELETE = withRequestLog(handleDELETE);
