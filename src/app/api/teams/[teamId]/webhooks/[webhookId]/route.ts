import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
  AUDIT_SCOPE,
} from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";

type Params = { params: Promise<{ teamId: string; webhookId: string }> };

// DELETE /api/teams/[teamId]/webhooks/[webhookId] — Delete a webhook
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId, webhookId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
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
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.delete({ where: { id: webhookId } }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.WEBHOOK_DELETE,
    userId: session.user.id,
    teamId,
    metadata: { webhookId, url: webhook.url },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
