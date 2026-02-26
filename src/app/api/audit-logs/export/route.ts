import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireOrgPermission, OrgAuthError } from "@/lib/org-auth";
import { z } from "zod/v4";
import { API_ERROR } from "@/lib/api-error-codes";
import { TEAM_PERMISSION, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

const bodySchema = z.object({
  orgId: z.string().optional(),
  entryCount: z.number().int().min(0),
  format: z.enum(["csv", "json"]),
  filename: z.string().trim().min(1).max(255).optional(),
  encrypted: z.boolean().optional(),
  includeOrgs: z.boolean().optional(),
});

// POST /api/audit-logs/export — Record export audit event
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

  const { orgId, entryCount, format, filename, encrypted, includeOrgs } = result.data;

  // Verify org membership when orgId is specified
  if (orgId) {
    try {
      await requireOrgPermission(session.user.id, orgId, TEAM_PERMISSION.ORG_UPDATE);
    } catch (e) {
      if (e instanceof OrgAuthError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  }

  logAudit({
    scope: orgId ? AUDIT_SCOPE.ORG : AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_EXPORT,
    userId: session.user.id,
    orgId: orgId ?? undefined,
    metadata: {
      entryCount,
      format,
      ...(filename ? { filename } : {}),
      ...(typeof encrypted === "boolean" ? { encrypted } : {}),
      ...(typeof includeOrgs === "boolean" ? { includeOrgs } : {}),
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ ok: true });
}
