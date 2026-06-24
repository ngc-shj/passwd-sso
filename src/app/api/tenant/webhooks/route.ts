import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { parseBody } from "@/lib/http/parse-body";
import {
  TENANT_PERMISSION,
  AUDIT_ACTION,
  TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS,
} from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
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
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized, validationError } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { assertQuotaAvailable, QuotaExceededError } from "@/lib/quota/resource-quotas";
import { MAX_WEBHOOKS, WEBHOOK_URL_MAX_LENGTH } from "@/lib/validations/common";
import { isSsrfSafeWebhookUrl, SSRF_URL_VALIDATION_MESSAGE, maskUrlForDisplay } from "@/lib/url/url-validation";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";

const createWebhookSchema = z.object({
  url: z.string().url().max(WEBHOOK_URL_MAX_LENGTH).refine(
    isSsrfSafeWebhookUrl,
    { message: SSRF_URL_VALIDATION_MESSAGE },
  ),
  events: z.array(
    z.enum([...TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS] as [string, ...string[]]),
  ).min(1).max(TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS.length),
});

// GET /api/tenant/webhooks — List tenant webhooks
async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.WEBHOOK_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }

  const webhooks = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.tenantWebhook.findMany({
      where: { tenantId: actor.tenantId },
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

// POST /api/tenant/webhooks — Create a tenant webhook
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.WEBHOOK_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }

  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;

  const result = await parseBody(req, createWebhookSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // C18 (OWASP A04-1): per-tenant quota gate covering tenant + team
  // webhooks combined. Existing MAX_WEBHOOKS check below is a tighter
  // tenant-webhook-only ceiling; both apply for defense in depth.
  try {
    await assertQuotaAvailable({ tenantId: actor.tenantId }, "webhooks", 1);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return errorResponse(API_ERROR.QUOTA_EXCEEDED, undefined, {
        resource: err.resource,
        current: err.current,
        max: err.max,
      });
    }
    throw err;
  }

  // Check webhook count limit
  const existingCount = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.tenantWebhook.count({ where: { tenantId: actor.tenantId } }),
  );
  if (existingCount >= MAX_WEBHOOKS) {
    return validationError({
      limit: `Maximum ${MAX_WEBHOOKS} webhooks per tenant`,
    });
  }

  // Pre-allocate the webhook id so the AAD can bind to it BEFORE the row is
  // written. Without this, AAD construction would have a chicken-and-egg
  // dependency on the create() call's returned id.
  const webhookId = randomUUID();
  const plainSecret = randomBytes(32).toString("hex");
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  const aad = buildWebhookSecretAAD({
    tableName: "TenantWebhook",
    version: WEBHOOK_SECRET_AAD_VERSION_CURRENT,
    webhookId,
    tenantId: actor.tenantId,
  });
  const encrypted = encryptServerData(plainSecret, masterKey, aad);

  const webhook = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.tenantWebhook.create({
      data: {
        id: webhookId,
        tenantId: actor.tenantId,
        url: data.url,
        secretEncrypted: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        masterKeyVersion: version,
        secretAadVersion: WEBHOOK_SECRET_AAD_VERSION_CURRENT,
        events: data.events,
      },
    }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.TENANT_WEBHOOK_CREATE,
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
    {
      status: 201,
      headers: { ...NO_STORE_HEADERS },
    },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
