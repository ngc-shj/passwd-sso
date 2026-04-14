/**
 * POST /api/directory-sync/[id]/run — Trigger a directory sync run.
 *
 * Body: { dryRun?: boolean, force?: boolean }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { runDirectorySync } from "@/lib/directory-sync/engine";
import { createRateLimiter } from "@/lib/rate-limit";
import { rateLimited, zodValidationError } from "@/lib/api-response";

type RouteContext = { params: Promise<{ id: string }> };

const dirSyncRunLimiter = createRateLimiter({ windowMs: 60_000, max: 1 });

const runSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
});

async function handlePOST(req: NextRequest, ctx: RouteContext) {
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
  const tenantId = member.tenantId;

  const rl = await dirSyncRunLimiter.check(`rl:dirsync_run:${id}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  // Verify config belongs to tenant
  const config = await withUserTenantRls(session.user.id, () =>
    prisma.directorySyncConfig.findFirst({
      where: { id, tenantId },
      select: { id: true, provider: true, displayName: true, enabled: true },
    }),
  );
  if (!config) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 },
    );
  }

  // Parse body (optional — empty body defaults to {})
  let body: unknown = {};
  try {
    const text = await req.text();
    if (text.trim()) {
      body = JSON.parse(text);
    }
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_JSON },
      { status: 400 },
    );
  }

  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }

  const { dryRun, force } = parsed.data;

  // Run sync
  const result = await runDirectorySync({
    configId: id,
    tenantId,
    userId: session.user.id,
    dryRun,
    force,
  });

  await logAuditAsync({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.DIRECTORY_SYNC_RUN,
    userId: session.user.id,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.DIRECTORY_SYNC_CONFIG,
    targetId: config.id,
    metadata: {
      provider: config.provider,
      dryRun,
      force,
      success: result.success,
      usersCreated: result.usersCreated,
      usersUpdated: result.usersUpdated,
      usersDeactivated: result.usersDeactivated,
      abortedSafety: result.abortedSafety,
    },
    ...extractRequestMeta(req),
  });

  if (!result.success) {
    // If it was a lock conflict, return 409
    if (result.errorMessage?.includes("already running")) {
      return NextResponse.json(
        { error: API_ERROR.CONFLICT, result },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "SYNC_FAILED", result },
      { status: 500 },
    );
  }

  return NextResponse.json(result);
}

export const POST = withRequestLog(handlePOST);
