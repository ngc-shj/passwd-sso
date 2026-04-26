import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { checkAuth } from "@/lib/auth/session/check-auth";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { createRateLimiter } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

const auditEmitLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

// Actions callable from the proxy via internal fetch.
// Restricting to a fixed set prevents this endpoint from becoming
// a generic audit write proxy for arbitrary callers.
const ALLOWED_ACTIONS = new Set<string>([
  AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
]);

// Bound the metadata payload an authenticated caller may write to the audit
// outbox. Without these limits, a misbehaving (or compromised) caller can
// push large payloads into audit_outbox and bloat the table or its drained
// audit_logs storage. These limits cover top-level keys and serialized size;
// the byte cap also bounds nesting depth implicitly.
const MAX_METADATA_KEYS = 20;
const MAX_METADATA_BYTES = 4096;

const metadataSchema = z
  .record(z.string(), z.unknown())
  .refine((m) => Object.keys(m).length <= MAX_METADATA_KEYS, {
    message: `metadata must have at most ${MAX_METADATA_KEYS} keys`,
  })
  .refine(
    (m) => {
      try {
        return new TextEncoder().encode(JSON.stringify(m)).byteLength <= MAX_METADATA_BYTES;
      } catch {
        return false;
      }
    },
    { message: `metadata must be at most ${MAX_METADATA_BYTES} bytes when serialized` },
  );

const bodySchema = z.object({
  action: z.string(),
  metadata: metadataSchema.optional(),
});

export async function POST(request: NextRequest) {
  const authResult = await checkAuth(request);
  if (!authResult.ok) return NextResponse.json({}, { status: 401 });

  const { userId } = authResult.auth;

  const rl = await auditEmitLimiter.check(`rl:audit_emit:${userId}`);
  if (!rl.allowed) {
    return NextResponse.json({}, { status: 429 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({}, { status: 400 });
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({}, { status: 400 });
  }

  const { action, metadata } = parsed.data;

  if (!ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json({}, { status: 400 });
  }

  const auditAction = AUDIT_ACTION[action as keyof typeof AUDIT_ACTION];

  const meta = extractRequestMeta(request);
  await logAuditAsync({
    scope: AUDIT_SCOPE.TENANT,
    action: auditAction,
    userId,
    metadata: metadata ?? {},
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({ ok: true });
}
