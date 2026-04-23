import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";

type Params = { params: Promise<{ id: string }> };

export const runtime = "nodejs";

// GET /api/tenant/access-requests/[id] — Get a single access request
async function handleGET(req: NextRequest, { params }: Params) {
  void req;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const { id } = await params;

  const accessRequest = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.accessRequest.findUnique({
      where: { id },
      select: {
        id: true,
        tenantId: true,
        serviceAccountId: true,
        requestedScope: true,
        justification: true,
        status: true,
        approvedById: true,
        approvedAt: true,
        grantedTokenId: true,
        grantedTokenTtlSec: true,
        expiresAt: true,
        createdAt: true,
        serviceAccount: { select: { id: true, name: true, description: true, isActive: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
    }),
  );

  if (!accessRequest || accessRequest.tenantId !== actor.tenantId) {
    return notFound();
  }

  return NextResponse.json(accessRequest);
}

export const GET = withRequestLog(handleGET);
