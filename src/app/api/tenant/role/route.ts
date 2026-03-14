import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantMembership } from "@/lib/tenant-auth";
import { withRequestLog } from "@/lib/with-request-log";
import { unauthorized } from "@/lib/api-response";

export const runtime = "nodejs";

// GET /api/tenant/role
// Returns the authenticated user's tenant role (or null if not a tenant member).
async function handleGET() {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const membership = await getTenantMembership(session.user.id);
  return NextResponse.json({ role: membership?.role ?? null });
}

export const GET = withRequestLog(handleGET);
