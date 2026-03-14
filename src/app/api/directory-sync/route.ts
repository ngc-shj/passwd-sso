/**
 * GET  /api/directory-sync — List all directory-sync configs for the tenant.
 * POST /api/directory-sync — Create a new directory-sync config.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { encryptCredentials } from "@/lib/directory-sync/credentials";

// ─── Validation ──────────────────────────────────────────────

const createSchema = z.object({
  provider: z.enum(["AZURE_AD", "GOOGLE_WORKSPACE", "OKTA"]),
  displayName: z.string().min(1).max(100),
  enabled: z.boolean().optional().default(true),
  syncIntervalMinutes: z.number().int().min(15).max(1440).optional().default(60),
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

  const member = await withUserTenantRls(session.user.id, () =>
    prisma.tenantMember.findFirst({
      where: { userId: session.user.id, role: { in: ["ADMIN", "OWNER"] } },
      select: { tenantId: true },
    }),
  );
  if (!member) {
    return NextResponse.json(
      { error: API_ERROR.FORBIDDEN },
      { status: 403 },
    );
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

  const member = await withUserTenantRls(session.user.id, () =>
    prisma.tenantMember.findFirst({
      where: { userId: session.user.id, role: { in: ["ADMIN", "OWNER"] } },
      select: { tenantId: true },
    }),
  );
  if (!member) {
    return NextResponse.json(
      { error: API_ERROR.FORBIDDEN },
      { status: 403 },
    );
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

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.DIRECTORY_SYNC_CONFIG_CREATE,
    userId: session.user.id,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.DIRECTORY_SYNC_CONFIG,
    targetId: config.id,
    metadata: { provider, displayName },
    ...extractRequestMeta(req),
  });

  return NextResponse.json(config, { status: 201 });
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
