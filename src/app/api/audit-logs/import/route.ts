import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { z } from "zod/v4";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

const bodySchema = z.object({
  requestedCount: z.number().int().min(0),
  successCount: z.number().int().min(0),
  failedCount: z.number().int().min(0),
  filename: z.string().trim().min(1).max(255).optional(),
  format: z.enum(["csv", "json"]).optional(),
  encrypted: z.boolean().optional(),
});

// POST /api/audit-logs/import — Record import summary audit event
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const result = bodySchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: API_ERROR.INVALID_BODY }, { status: 400 });
  }

  const { requestedCount, successCount, failedCount, filename, format, encrypted } = result.data;

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_IMPORT,
    userId: session.user.id,
    metadata: {
      requestedCount,
      successCount,
      failedCount,
      ...(filename ? { filename } : {}),
      ...(format ? { format } : {}),
      ...(typeof encrypted === "boolean" ? { encrypted } : {}),
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ ok: true });
}
