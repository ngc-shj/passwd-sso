/**
 * GET    /api/directory-sync/[id] — Get a single directory-sync config.
 * PUT    /api/directory-sync/[id] — Update a directory-sync config.
 * DELETE /api/directory-sync/[id] — Delete a directory-sync config.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { encryptCredentials } from "@/lib/directory-sync/credentials";
import {
  SYNC_INTERVAL_MIN,
  SYNC_INTERVAL_MAX,
  NAME_MAX_LENGTH,
} from "@/lib/validations/common";

type RouteContext = { params: Promise<{ id: string }> };

// ─── Validation ──────────────────────────────────────────────

const updateSchema = z.object({
  displayName: z.string().min(1).max(NAME_MAX_LENGTH).optional(),
  enabled: z.boolean().optional(),
  syncIntervalMinutes: z.number().int().min(SYNC_INTERVAL_MIN).max(SYNC_INTERVAL_MAX).optional(),
  credentials: z.record(z.string(), z.unknown()).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────

async function resolveAdminAndConfig(
  userId: string,
  configId: string,
) {
  const member = await withUserTenantRls(userId, () =>
    prisma.tenantMember.findFirst({
      where: { userId, role: { in: ["ADMIN", "OWNER"] } },
      select: { tenantId: true },
    }),
  );
  if (!member) return null;

  const config = await withUserTenantRls(userId, () =>
    prisma.directorySyncConfig.findFirst({
      where: { id: configId, tenantId: member.tenantId },
    }),
  );

  return config ? { tenantId: member.tenantId, config } : null;
}

// ─── GET ─────────────────────────────────────────────────────

async function handleGET(req: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const { id } = await ctx.params;

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

  const config = await withUserTenantRls(session.user.id, () =>
    prisma.directorySyncConfig.findFirst({
      where: { id, tenantId: member.tenantId },
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

  if (!config) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 },
    );
  }

  return NextResponse.json(config);
}

// ─── PUT ─────────────────────────────────────────────────────

async function handlePUT(req: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const { id } = await ctx.params;

  const resolved = await resolveAdminAndConfig(session.user.id, id);
  if (!resolved) {
    // Could be FORBIDDEN or NOT_FOUND — check admin first
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
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 },
    );
  }

  const { tenantId, config } = resolved;

  const result = await parseBody(req, updateSchema);
  if (!result.ok) return result.response;
  const { displayName, enabled, syncIntervalMinutes, credentials } =
    result.data;

  // Build update data
  const updateData: Record<string, unknown> = {};
  if (displayName !== undefined) updateData.displayName = displayName;
  if (enabled !== undefined) updateData.enabled = enabled;
  if (syncIntervalMinutes !== undefined)
    updateData.syncIntervalMinutes = syncIntervalMinutes;

  // Re-encrypt credentials if provided
  if (credentials) {
    const credentialsJson = JSON.stringify(credentials);
    const encrypted = encryptCredentials(credentialsJson, config.id, tenantId);
    updateData.encryptedCredentials = encrypted.ciphertext;
    updateData.credentialsIv = encrypted.iv;
    updateData.credentialsAuthTag = encrypted.authTag;
  }

  const updated = await withUserTenantRls(session.user.id, () =>
    prisma.directorySyncConfig.update({
      where: { id: config.id },
      data: updateData,
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

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, tenantId),
    action: AUDIT_ACTION.DIRECTORY_SYNC_CONFIG_UPDATE,
    targetType: AUDIT_TARGET_TYPE.DIRECTORY_SYNC_CONFIG,
    targetId: config.id,
    metadata: {
      provider: config.provider,
      displayName: displayName ?? config.displayName,
      credentialsRotated: !!credentials,
    },
  });

  return NextResponse.json(updated);
}

// ─── DELETE ──────────────────────────────────────────────────

async function handleDELETE(req: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const { id } = await ctx.params;

  const resolved = await resolveAdminAndConfig(session.user.id, id);
  if (!resolved) {
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
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 },
    );
  }

  const { tenantId, config } = resolved;

  await withUserTenantRls(session.user.id, () =>
    prisma.directorySyncConfig.delete({
      where: { id: config.id },
    }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, tenantId),
    action: AUDIT_ACTION.DIRECTORY_SYNC_CONFIG_DELETE,
    targetType: AUDIT_TARGET_TYPE.DIRECTORY_SYNC_CONFIG,
    targetId: config.id,
    metadata: {
      provider: config.provider,
      displayName: config.displayName,
    },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
