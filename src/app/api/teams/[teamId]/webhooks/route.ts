import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import {
  TEAM_PERMISSION,
  AUDIT_ACTION,
} from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
  encryptServerData,
} from "@/lib/crypto/crypto-server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS } from "@/lib/constants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";
import { MAX_WEBHOOKS, WEBHOOK_URL_MAX_LENGTH } from "@/lib/validations/common";
import { isSsrfSafeWebhookUrl, SSRF_URL_VALIDATION_MESSAGE } from "@/lib/url/url-validation";

type Params = { params: Promise<{ teamId: string }> };

const createWebhookSchema = z.object({
  url: z.string().url().max(WEBHOOK_URL_MAX_LENGTH).refine(
    isSsrfSafeWebhookUrl,
    { message: SSRF_URL_VALIDATION_MESSAGE },
  ),
  events: z.array(z.enum([...TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS] as [string, ...string[]])).min(1).max(TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS.length),
});

// GET /api/teams/[teamId]/webhooks — List team webhooks
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
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
async function handlePOST(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    return handleAuthError(e);
  }

  const result = await parseBody(req, createWebhookSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // Check webhook count limit
  const existingCount = await withTeamTenantRls(teamId, async () =>
    prisma.teamWebhook.count({ where: { teamId } }),
  );
  if (existingCount >= MAX_WEBHOOKS) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: { limit: `Maximum ${MAX_WEBHOOKS} webhooks per team` } },
      { status: 400 },
    );
  }

  // Generate HMAC secret and encrypt it
  const plainSecret = randomBytes(32).toString("hex");
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  const encrypted = encryptServerData(plainSecret, masterKey);

  const webhook = await withTeamTenantRls(teamId, async (tenantId) =>
    prisma.teamWebhook.create({
      data: {
        teamId,
        tenantId,
        url: data.url,
        secretEncrypted: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        masterKeyVersion: version,
        events: data.events,
      },
    }),
  );

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.WEBHOOK_CREATE,
    metadata: { webhookId: webhook.id, url: data.url },
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

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
