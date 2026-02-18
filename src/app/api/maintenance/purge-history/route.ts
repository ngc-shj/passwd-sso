import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_SCOPE, AUDIT_ACTION, AUDIT_METADATA_KEY } from "@/lib/constants";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// POST /api/maintenance/purge-history - Delete history entries older than 90 days
// Auth: session only. Scope: user's own history only.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const ninetyDaysAgo = new Date(Date.now() - NINETY_DAYS_MS);

  const deleted = await prisma.passwordEntryHistory.deleteMany({
    where: {
      entry: { userId: session.user.id },
      changedAt: { lt: ninetyDaysAgo },
    },
  });

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.HISTORY_PURGE,
    userId: session.user.id,
    metadata: {
      [AUDIT_METADATA_KEY.PURGED_COUNT]: deleted.count,
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ purged: deleted.count });
}
