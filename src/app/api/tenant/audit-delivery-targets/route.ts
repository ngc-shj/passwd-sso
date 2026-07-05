import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { parseBody } from "@/lib/http/parse-body";
import {
  TENANT_PERMISSION,
  AUDIT_ACTION,
} from "@/lib/constants";
import { withTenantRls, advisoryXactLock } from "@/lib/tenant-rls";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
  encryptServerData,
  decryptServerData,
} from "@/lib/crypto/crypto-server";
import { AuditDeliveryTargetKind } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withRequestLog } from "@/lib/http/with-request-log";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { handleAuthError, unauthorized, validationError } from "@/lib/http/api-response";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import {
  MAX_AUDIT_DELIVERY_TARGETS,
  WEBHOOK_URL_MAX_LENGTH,
  AUDIT_DELIVERY_SECRET_MAX,
  AUDIT_DELIVERY_TOKEN_MAX,
  AUDIT_DELIVERY_REGION_MAX,
  AUDIT_DELIVERY_AWS_CREDENTIAL_MAX,
} from "@/lib/validations/common";

import { isSsrfSafeWebhookUrl as ssrfSafeUrl, SSRF_URL_VALIDATION_MESSAGE as ssrfMessage, maskUrlForDisplay } from "@/lib/url/url-validation";

// Sentinel thrown inside the locked transaction when the re-checked audit
// delivery target count is at the cap. Mapped to the MAX_AUDIT_DELIVERY_TARGETS
// validation error outside the tx.
class AuditDeliveryTargetLimitError extends Error {}

const createDeliveryTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(AuditDeliveryTargetKind.WEBHOOK),
    url: z.string().url().max(WEBHOOK_URL_MAX_LENGTH).refine(ssrfSafeUrl, { message: ssrfMessage }),
    secret: z.string().min(1).max(AUDIT_DELIVERY_SECRET_MAX),
  }),
  z.object({
    kind: z.literal(AuditDeliveryTargetKind.SIEM_HEC),
    url: z.string().url().max(WEBHOOK_URL_MAX_LENGTH).refine(ssrfSafeUrl, { message: ssrfMessage }),
    token: z.string().min(1).max(AUDIT_DELIVERY_TOKEN_MAX),
  }),
  z.object({
    kind: z.literal(AuditDeliveryTargetKind.S3_OBJECT),
    endpoint: z.string().url().max(WEBHOOK_URL_MAX_LENGTH).refine(ssrfSafeUrl, { message: ssrfMessage }),
    region: z.string().min(1).max(AUDIT_DELIVERY_REGION_MAX),
    accessKeyId: z.string().min(1).max(AUDIT_DELIVERY_AWS_CREDENTIAL_MAX),
    secretAccessKey: z.string().min(1).max(AUDIT_DELIVERY_AWS_CREDENTIAL_MAX),
  }),
]);

// GET /api/tenant/audit-delivery-targets — List audit delivery targets
async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }

  const rows = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.auditDeliveryTarget.findMany({
      where: { tenantId: actor.tenantId },
      select: {
        id: true,
        kind: true,
        isActive: true,
        failCount: true,
        lastError: true,
        lastDeliveredAt: true,
        createdAt: true,
        configEncrypted: true,
        configIv: true,
        configAuthTag: true,
        masterKeyVersion: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  // Extract endpoint URL from the encrypted config so the list view can show
  // it. Secrets (webhook secret, HEC token, S3 access keys) are NEVER included
  // in the response — only the URL/endpoint, which is destination metadata
  // and was already user-supplied at create time.
  const targets = rows.map((row) => {
    let endpoint: string | null = null;
    try {
      const masterKey = getMasterKeyByVersion(row.masterKeyVersion);
      const aad = Buffer.concat([
        Buffer.from(row.id.replace(/-/g, ""), "hex"),
        Buffer.from(actor.tenantId.replace(/-/g, ""), "hex"),
      ]);
      const configJson = decryptServerData(
        {
          ciphertext: row.configEncrypted,
          iv: row.configIv,
          authTag: row.configAuthTag,
        },
        masterKey,
        aad,
      );
      const config = JSON.parse(configJson) as { url?: string; endpoint?: string };
      const raw = config.url ?? config.endpoint ?? null;
      endpoint = raw ? maskUrlForDisplay(raw) : null;
    } catch {
      // Decrypt failure (missing master key version, AAD mismatch, corruption)
      // — keep the row visible without the endpoint rather than 500-ing the
      // whole list. The worker will surface the same error via lastError.
      endpoint = null;
    }
    return {
      id: row.id,
      kind: row.kind,
      isActive: row.isActive,
      failCount: row.failCount,
      lastError: row.lastError,
      lastDeliveredAt: row.lastDeliveredAt,
      createdAt: row.createdAt,
      endpoint,
    };
  });

  return NextResponse.json({ targets });
}

// POST /api/tenant/audit-delivery-targets — Create an audit delivery target
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.AUDIT_DELIVERY_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }

  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;

  const result = await parseBody(req, createDeliveryTargetSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // Pre-generate UUID so we can build AAD before DB insert
  const targetId = randomUUID();

  // Strip kind from config — worker reads kind from DB column, not blob
  const { kind: _kind, ...configFields } = data;
  const configJson = JSON.stringify(configFields);

  // Encrypt with AAD = targetId + tenantId (must match worker decryption).
  // Crypto stays OUTSIDE the locked tx below.
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  const aad = Buffer.concat([
    Buffer.from(targetId.replace(/-/g, ""), "hex"),
    Buffer.from(actor.tenantId.replace(/-/g, ""), "hex"),
  ]);
  const encrypted = encryptServerData(configJson, masterKey, aad);

  // Serialize the cap check with the create under a per-tenant advisory lock so
  // two concurrent POSTs cannot both read count < MAX and both create, blowing
  // past MAX_AUDIT_DELIVERY_TARGETS (TOCTOU). Lock, count, and create fold into
  // one tenant tx; over-limit throws a sentinel mapped outside.
  let target;
  try {
    target = await withTenantRls(prisma, actor.tenantId, async (tx) => {
      await advisoryXactLock(tx, actor.tenantId);
      const existingCount = await tx.auditDeliveryTarget.count({
        where: { tenantId: actor.tenantId },
      });
      if (existingCount >= MAX_AUDIT_DELIVERY_TARGETS) {
        throw new AuditDeliveryTargetLimitError();
      }
      return tx.auditDeliveryTarget.create({
        data: {
          id: targetId,
          tenantId: actor.tenantId,
          kind: data.kind,
          configEncrypted: encrypted.ciphertext,
          configIv: encrypted.iv,
          configAuthTag: encrypted.authTag,
          masterKeyVersion: version,
        },
      });
    });
  } catch (e) {
    if (e instanceof AuditDeliveryTargetLimitError) {
      return validationError({
        limit: `Maximum ${MAX_AUDIT_DELIVERY_TARGETS} audit delivery targets per tenant`,
      });
    }
    throw e;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.AUDIT_DELIVERY_TARGET_CREATE,
    metadata: { targetId: target.id, kind: data.kind },
  });

  return NextResponse.json(
    {
      target: {
        id: target.id,
        kind: target.kind,
        isActive: target.isActive,
        createdAt: target.createdAt,
      },
    },
    {
      status: 201,
      headers: { ...NO_STORE_HEADERS },
    },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
