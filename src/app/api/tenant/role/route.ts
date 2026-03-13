import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { getTenantMembership } from "@/lib/tenant-auth";
import { withRequestLog } from "@/lib/with-request-log";

export const runtime = "nodejs";

// GET /api/tenant/role
// Returns the authenticated user's tenant role (or null if not a tenant member).
async function handleGET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const membership = await getTenantMembership(session.user.id);
  return NextResponse.json({ role: membership?.role ?? null });
}

export const GET = withRequestLog(handleGET);
