/**
 * GET  /api/directory-sync — List all directory-sync configs for the tenant.
 * POST /api/directory-sync — Create a new directory-sync config.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { encryptCredentials } from "@/lib/directory-sync/credentials";
import {
  DIRECTORY_SYNC_PROVIDERS,
  SYNC_INTERVAL_MIN,
  SYNC_INTERVAL_MAX,
  SYNC_INTERVAL_DEFAULT,
  NAME_MAX_LENGTH,
} from "@/lib/validations/common";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { handleAuthError } from "@/lib/http/api-response";

// ─── Validation ──────────────────────────────────────────────

const createSchema = z.object({
  provider: z.enum(DIRECTORY_SYNC_PROVIDERS),
  displayName: z.string().min(1).max(NAME_MAX_LENGTH),
  enabled: z.boolean().optional().default(true),
  syncIntervalMinutes: z.number().int().min(SYNC_INTERVAL_MIN).max(SYNC_INTERVAL_MAX).optional().default(SYNC_INTERVAL_DEFAULT),
  credentials: z.record(z.string(), z.unknown()),
});

// ─── GET ─────────────────────────────────────────────────────

async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  let member;
  try {
    member = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SCIM_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }
  const tenantId = member.tenantId;

  const configs = await withUserTenantRls(session.user.id, () =>
    prisma.directorySyncConfig.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        provider: true,
        displayName: true,
        enabled: true,
        syncIntervalMinutes: true,
        status: true,
        lastSyncAt: true,
        lastSyncError: true,
        lastSyncStats: true,
        nextSyncAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  );

  return NextResponse.json(configs);
}

// ─── POST ────────────────────────────────────────────────────

async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  let member;
  try {
    member = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SCIM_MANAGE);
  } catch (e) {
    return handleAuthError(e);
  }
  const tenantId = member.tenantId;

  const result = await parseBody(req, createSchema);
  if (!result.ok) return result.response;
  const { provider, displayName, enabled, syncIntervalMinutes, credentials } =
    result.data;

  // Check uniqueness (one config per provider per tenant)
  const existing = await withUserTenantRls(session.user.id, () =>
    prisma.directorySyncConfig.findFirst({
      where: { tenantId, provider },
      select: { id: true },
    }),
  );
  if (existing) {
    return NextResponse.json(
      { error: API_ERROR.CONFLICT },
      { status: 409 },
    );
  }

  // We need a temporary ID for AAD — create the row first with empty creds,
  // then encrypt and update. Using a transaction for atomicity.
  const config = await withUserTenantRls(session.user.id, () =>
    prisma.$transaction(async (tx) => {
      // Create with placeholder credentials
      const row = await tx.directorySyncConfig.create({
        data: {
          tenantId,
          provider,
          displayName,
          enabled,
          syncIntervalMinutes,
          // Placeholder — will be replaced immediately
          encryptedCredentials: "",
          credentialsIv: "",
          credentialsAuthTag: "",
        },
      });

      // Encrypt credentials with the real config ID
      const credentialsJson = JSON.stringify(credentials);
      const encrypted = encryptCredentials(credentialsJson, row.id, tenantId);

      // Update with real encrypted credentials
      return tx.directorySyncConfig.update({
        where: { id: row.id },
        data: {
          encryptedCredentials: encrypted.ciphertext,
          credentialsIv: encrypted.iv,
          credentialsAuthTag: encrypted.authTag,
        },
        select: {
          id: true,
          provider: true,
          displayName: true,
          enabled: true,
          syncIntervalMinutes: true,
          status: true,
          lastSyncAt: true,
          lastSyncError: true,
          lastSyncStats: true,
          nextSyncAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, tenantId),
    action: AUDIT_ACTION.DIRECTORY_SYNC_CONFIG_CREATE,
    targetType: AUDIT_TARGET_TYPE.DIRECTORY_SYNC_CONFIG,
    targetId: config.id,
    metadata: { provider, displayName },
  });

  return NextResponse.json(config, { status: 201 });
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
