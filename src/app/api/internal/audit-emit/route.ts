import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkAuth } from "@/lib/check-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

export const runtime = "nodejs";

// Actions callable from the proxy via internal fetch.
// Restricting to a fixed set prevents this endpoint from becoming
// a generic audit write proxy for arbitrary callers.
const ALLOWED_ACTIONS = new Set<string>([
  AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
]);

export async function POST(request: NextRequest) {
  const authResult = await checkAuth(request);
  if (!authResult.ok) return NextResponse.json({}, { status: 401 });

  const { userId } = authResult.auth;

  let body: { action: string; metadata?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({}, { status: 400 });
  }

  const { action, metadata } = body;

  if (!action || !ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json({}, { status: 400 });
  }

  const auditAction = AUDIT_ACTION[action as keyof typeof AUDIT_ACTION];

  const meta = extractRequestMeta(request);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: auditAction,
    userId,
    metadata: metadata ?? {},
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({ ok: true });
}
