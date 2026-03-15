import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { assertOrigin } from "@/lib/csrf";
import { parseBody } from "@/lib/parse-body";
import {
  TENANT_PERMISSION,
  AUDIT_ACTION,
  AUDIT_SCOPE,
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
import { errorResponse, unauthorized } from "@/lib/api-response";
import { API_ERROR } from "@/lib/api-error-codes";

const MAX_WEBHOOKS_PER_TENANT = 5;

const createWebhookSchema = z.object({
  url: z.string().url().max(2048).refine(
    (u) => {
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== "https:") return false;
        const host = parsed.hostname.toLowerCase();
        if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return false;
        if (host === "0.0.0.0" || host.endsWith(".local") || host.endsWith(".internal")) return false;
        if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
        return true;
      } catch {
        return false;
      }
    },
    { message: "URL must use HTTPS and must not point to private/internal addresses" },
  ),
  events: z.array(
    z.enum(TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS as unknown as [string, ...string[]]),
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
    if (e instanceof TenantAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
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
    if (e instanceof TenantAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const result = await parseBody(req, createWebhookSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // Check webhook count limit
  const existingCount = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantWebhook.count({ where: { tenantId: actor.tenantId } }),
  );
  if (existingCount >= MAX_WEBHOOKS_PER_TENANT) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: { limit: `Maximum ${MAX_WEBHOOKS_PER_TENANT} webhooks per tenant` } },
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

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.TENANT_WEBHOOK_CREATE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    metadata: { webhookId: webhook.id, url: data.url },
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
    {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
