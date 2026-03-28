/**
 * Single delegation session revocation.
 * DELETE: Revoke a specific delegation session by ID.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { assertOrigin } from "@/lib/csrf";
import { withRequestLog } from "@/lib/with-request-log";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { revokeDelegationSession } from "@/lib/delegation";

export const runtime = "nodejs";

async function handleDELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const originError = assertOrigin(request);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return NextResponse.json({ error: "No tenant" }, { status: 403 });
  }

  const { id: sessionId } = await params;
  if (!z.string().uuid().safeParse(sessionId).success) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  const revoked = await revokeDelegationSession(userId, sessionId, tenantId);
  if (!revoked) {
    return NextResponse.json({ error: "Session not found or already revoked" }, { status: 404 });
  }

  return NextResponse.json({ revoked: true });
}

export const DELETE = withRequestLog(handleDELETE);
