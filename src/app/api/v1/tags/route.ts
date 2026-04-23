import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { validateV1Auth } from "@/lib/auth/v1-auth";
import { withRequestLog } from "@/lib/with-request-log";
import { withTenantRls } from "@/lib/tenant-rls";
import { v1ApiKeyLimiter } from "@/lib/security/rate-limiters";
import { API_KEY_SCOPE } from "@/lib/constants/api-key";
import { enforceAccessRestriction } from "@/lib/auth/access-restriction";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma/prisma-filters";
import { rateLimited, unauthorized } from "@/lib/api-response";


// GET /api/v1/tags — List tags (API key or SA token)
async function handleGET(req: NextRequest) {
  const authResult = await validateV1Auth(req, API_KEY_SCOPE.TAGS_READ);
  if (!authResult.ok) {
    if (authResult.error === "SCOPE_INSUFFICIENT") {
      return NextResponse.json(
        { error: API_ERROR.API_KEY_SCOPE_INSUFFICIENT },
        { status: 403 },
      );
    }
    return unauthorized();
  }

  const { userId, tenantId, rateLimitKey } = authResult.data;

  if (!userId) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED, message: "Service account tokens cannot access personal data via v1 API. Use MCP Gateway." },
      { status: 403 },
    );
  }

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const rl = await v1ApiKeyLimiter.check(`rl:api_key:${rateLimitKey}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const tags = await withTenantRls(prisma, tenantId, async () =>
    prisma.tag.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: {
            passwords: {
              where: { ...ACTIVE_ENTRY_WHERE },
            },
          },
        },
      },
    }),
  );

  return NextResponse.json(
    tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      parentId: tag.parentId,
      passwordCount: tag._count.passwords,
    })),
  );
}

export const GET = withRequestLog(handleGET);
