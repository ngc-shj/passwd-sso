/**
 * Single delegation session revocation.
 * DELETE: Revoke a specific delegation session by ID.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { withRequestLog } from "@/lib/http/with-request-log";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { revokeDelegationSession } from "@/lib/auth/access/delegation";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";

export const runtime = "nodejs";

async function handleDELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const originError = assertOrigin(request);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const userId = session.user.id;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return errorResponse(API_ERROR.NO_TENANT, 403);
  }

  const { id: sessionId } = await params;
  if (!z.string().uuid().safeParse(sessionId).success) {
    return errorResponse(API_ERROR.INVALID_SESSION, 400);
  }

  const revoked = await revokeDelegationSession(userId, sessionId, tenantId);
  if (!revoked) {
    return errorResponse(API_ERROR.SESSION_NOT_FOUND, 404);
  }

  return NextResponse.json({ revoked: true });
}

export const DELETE = withRequestLog(handleDELETE);
