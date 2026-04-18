import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/tenant-auth";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit";
import { assertOrigin } from "@/lib/csrf";
import { parseBody } from "@/lib/parse-body";
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
} from "@/lib/crypto-server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { withRequestLog } from "@/lib/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/api-response";
import { API_ERROR } from "@/lib/api-error-codes";
import { MAX_WEBHOOKS, WEBHOOK_URL_MAX_LENGTH } from "@/lib/validations/common";
import { isSsrfSafeWebhookUrl, SSRF_URL_VALIDATION_MESSAGE } from "@/lib/url-validation";

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

  const webhooks = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantWebhook.findMany({
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
  const originError = assertOrigin(req);
  if (originError) return originError;

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

  const result = await parseBody(req, createWebhookSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // Check webhook count limit
  const existingCount = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantWebhook.count({ where: { tenantId: actor.tenantId } }),
  );
  if (existingCount >= MAX_WEBHOOKS) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: { limit: `Maximum ${MAX_WEBHOOKS} webhooks per tenant` } },
      { status: 400 },
    );
  }

  // Generate HMAC secret and encrypt it
  const plainSecret = randomBytes(32).toString("hex");
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  const encrypted = encryptServerData(plainSecret, masterKey);

  const webhook = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantWebhook.create({
      data: {
        tenantId: actor.tenantId,
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
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.TENANT_WEBHOOK_CREATE,
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
    {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
