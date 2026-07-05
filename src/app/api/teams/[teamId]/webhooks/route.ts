import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { advisoryXactLock } from "@/lib/tenant-rls";
import { requireTeamPermission } from "@/lib/auth/access/team-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { logAuditAsync, teamAuditBase } from "@/lib/audit/audit";
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
import {
  buildWebhookSecretAAD,
  WEBHOOK_SECRET_AAD_VERSION_CURRENT,
} from "@/lib/crypto/webhook-aad";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { TEAM_WEBHOOK_SUBSCRIBABLE_ACTIONS } from "@/lib/constants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized, validationError } from "@/lib/http/api-response";
import { MAX_WEBHOOKS, WEBHOOK_URL_MAX_LENGTH } from "@/lib/validations/common";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { isSsrfSafeWebhookUrl, SSRF_URL_VALIDATION_MESSAGE, maskUrlForDisplay } from "@/lib/url/url-validation";

type Params = { params: Promise<{ teamId: string }> };

// Sentinel thrown inside the locked transaction when the re-checked team
// webhook count is at the cap. Mapped to the MAX_WEBHOOKS validation error
// outside the tx.
class WebhookLimitError extends Error {}

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

  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;

  const result = await parseBody(req, createWebhookSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // Pre-allocate the webhook id so the AAD can bind to it BEFORE the row is
  // written (see C9 design — AAD includes webhookId). Crypto stays OUTSIDE the
  // locked tx below.
  const webhookId = randomUUID();
  const plainSecret = randomBytes(32).toString("hex");
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);

  // Serialize the cap check with the create under a per-team advisory lock so
  // two concurrent POSTs cannot both read count < MAX and both create, blowing
  // past MAX_WEBHOOKS (TOCTOU). The lock, count, and create fold into one team
  // tenant tx via the proxy; over-limit throws a sentinel mapped outside.
  let webhook;
  try {
    webhook = await withTeamTenantRls(teamId, async (tenantId) => {
      await advisoryXactLock(prisma, teamId);
      const existingCount = await prisma.teamWebhook.count({
        where: { teamId },
      });
      if (existingCount >= MAX_WEBHOOKS) {
        throw new WebhookLimitError();
      }
      const aad = buildWebhookSecretAAD({
        tableName: "TeamWebhook",
        version: WEBHOOK_SECRET_AAD_VERSION_CURRENT,
        webhookId,
        tenantId,
        teamId,
      });
      const encrypted = encryptServerData(plainSecret, masterKey, aad);
      return prisma.teamWebhook.create({
        data: {
          id: webhookId,
          teamId,
          tenantId,
          url: data.url,
          secretEncrypted: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretAuthTag: encrypted.authTag,
          masterKeyVersion: version,
          secretAadVersion: WEBHOOK_SECRET_AAD_VERSION_CURRENT,
          events: data.events,
        },
      });
    });
  } catch (e) {
    if (e instanceof WebhookLimitError) {
      return validationError({
        limit: `Maximum ${MAX_WEBHOOKS} webhooks per team`,
      });
    }
    throw e;
  }

  await logAuditAsync({
    ...teamAuditBase(req, session.user.id, teamId),
    action: AUDIT_ACTION.WEBHOOK_CREATE,
    metadata: { webhookId: webhook.id, url: maskUrlForDisplay(data.url) },
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
    { status: 201, headers: { ...NO_STORE_HEADERS } },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
