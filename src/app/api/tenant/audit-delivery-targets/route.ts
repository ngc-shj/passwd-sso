import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { assertOrigin } from "@/lib/auth/csrf";
import { parseBody } from "@/lib/http/parse-body";
import {
  TENANT_PERMISSION,
  AUDIT_ACTION,
} from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
  encryptServerData,
} from "@/lib/crypto/crypto-server";
import { AuditDeliveryTargetKind } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  MAX_AUDIT_DELIVERY_TARGETS,
  WEBHOOK_URL_MAX_LENGTH,
} from "@/lib/validations/common";

import { isSsrfSafeWebhookUrl as ssrfSafeUrl, SSRF_URL_VALIDATION_MESSAGE as ssrfMessage } from "@/lib/url/url-validation";

const createDeliveryTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal(AuditDeliveryTargetKind.WEBHOOK),
    url: z.string().url().max(WEBHOOK_URL_MAX_LENGTH).refine(ssrfSafeUrl, { message: ssrfMessage }),
    secret: z.string().min(1),
  }),
  z.object({
    kind: z.literal(AuditDeliveryTargetKind.SIEM_HEC),
    url: z.string().url().max(WEBHOOK_URL_MAX_LENGTH).refine(ssrfSafeUrl, { message: ssrfMessage }),
    token: z.string().min(1),
  }),
  z.object({
    kind: z.literal(AuditDeliveryTargetKind.S3_OBJECT),
    endpoint: z.string().url().max(WEBHOOK_URL_MAX_LENGTH).refine(ssrfSafeUrl, { message: ssrfMessage }),
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
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

  const targets = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.auditDeliveryTarget.findMany({
      where: { tenantId: actor.tenantId },
      select: {
        id: true,
        kind: true,
        isActive: true,
        failCount: true,
        lastError: true,
        lastDeliveredAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json({ targets });
}

// POST /api/tenant/audit-delivery-targets — Create an audit delivery target
async function handlePOST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

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

  const result = await parseBody(req, createDeliveryTargetSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  // Check delivery target count limit (all targets, regardless of isActive)
  const existingCount = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.auditDeliveryTarget.count({ where: { tenantId: actor.tenantId } }),
  );
  if (existingCount >= MAX_AUDIT_DELIVERY_TARGETS) {
    return NextResponse.json(
      {
        error: API_ERROR.VALIDATION_ERROR,
        details: { limit: `Maximum ${MAX_AUDIT_DELIVERY_TARGETS} audit delivery targets per tenant` },
      },
      { status: 400 },
    );
  }

  // Pre-generate UUID so we can build AAD before DB insert
  const targetId = randomUUID();

  // Strip kind from config — worker reads kind from DB column, not blob
  const { kind: _kind, ...configFields } = data;
  const configJson = JSON.stringify(configFields);

  // Encrypt with AAD = targetId + tenantId (must match worker decryption)
  const version = getCurrentMasterKeyVersion();
  const masterKey = getMasterKeyByVersion(version);
  const aad = Buffer.concat([
    Buffer.from(targetId.replace(/-/g, ""), "hex"),
    Buffer.from(actor.tenantId.replace(/-/g, ""), "hex"),
  ]);
  const encrypted = encryptServerData(configJson, masterKey, aad);

  const target = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.auditDeliveryTarget.create({
      data: {
        id: targetId,
        tenantId: actor.tenantId,
        kind: data.kind,
        configEncrypted: encrypted.ciphertext,
        configIv: encrypted.iv,
        configAuthTag: encrypted.authTag,
        masterKeyVersion: version,
      },
    }),
  );

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
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
