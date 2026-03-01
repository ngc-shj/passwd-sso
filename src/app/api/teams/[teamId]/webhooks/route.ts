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
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
  encryptServerData,
} from "@/lib/crypto-server";
import { randomBytes } from "node:crypto";
import { z } from "zod";

type Params = { params: Promise<{ teamId: string }> };

const MAX_WEBHOOKS_PER_TEAM = 5;

const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.string().min(1)).min(1).max(50),
});

// GET /api/teams/[teamId]/webhooks — List team webhooks
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const webhooks = await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.findMany({
      where: { teamId },
      select: {
        id: true,
        url: true,
        events: true,
        isActive: true,
        failCount: true,
        lastDeliveredAt: true,
        lastFailedAt: true,
        lastError: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json({ webhooks });
}

// POST /api/teams/[teamId]/webhooks — Create a webhook
export async function POST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const body = await req.json();
  const parsed = createWebhookSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Check webhook count limit
  const existingCount = await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.count({ where: { teamId } }),
  );
  if (existingCount >= MAX_WEBHOOKS_PER_TEAM) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: { limit: `Maximum ${MAX_WEBHOOKS_PER_TEAM} webhooks per team` } },
      { status: 400 },
    );
  }

  // Generate HMAC secret and encrypt it
  const plainSecret = randomBytes(32).toString("hex");
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  const encrypted = encryptServerData(plainSecret, masterKey);

  // Resolve tenantId from team
  const team = await withTeamTenantRls(teamId, async () =>
    prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { tenantId: true },
    }),
  );

  const webhook = await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.create({
      data: {
        teamId,
        tenantId: team.tenantId,
        url: parsed.data.url,
        secretEncrypted: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        masterKeyVersion: version,
        events: parsed.data.events,
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.WEBHOOK_CREATE,
    userId: session.user.id,
    teamId,
    metadata: { webhookId: webhook.id, url: parsed.data.url },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(
    {
      webhook: {
        id: webhook.id,
        url: webhook.url,
        events: webhook.events,
        isActive: webhook.isActive,
        createdAt: webhook.createdAt,
      },
      secret: plainSecret,
    },
    { status: 201 },
  );
}
