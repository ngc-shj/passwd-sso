import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { z } from "zod/v4";

const bodySchema = z.object({
  orgId: z.string().optional(),
  entryCount: z.number().int().min(0),
  format: z.enum(["csv", "json"]),
});

// POST /api/audit-logs/export — Record export audit event
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = bodySchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { orgId, entryCount, format } = result.data;

  logAudit({
    scope: orgId ? "ORG" : "PERSONAL",
    action: "ENTRY_EXPORT",
    userId: session.user.id,
    orgId: orgId ?? undefined,
    metadata: { entryCount, format },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ ok: true });
}
