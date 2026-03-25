import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { validateApiKeyOnly } from "@/lib/api-key";
import { withRequestLog } from "@/lib/with-request-log";
import { withTenantRls } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_KEY_SCOPE } from "@/lib/constants/api-key";
import { enforceAccessRestriction } from "@/lib/access-restriction";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma-filters";
import { rateLimited, unauthorized } from "@/lib/api-response";

const apiKeyLimiter = createRateLimiter({ windowMs: 60_000, max: 100 });

// GET /api/v1/tags — List tags (API key only)
async function handleGET(req: NextRequest) {
  const authResult = await validateApiKeyOnly(req, API_KEY_SCOPE.TAGS_READ);
  if (!authResult.ok) {
    if (authResult.error === "SCOPE_INSUFFICIENT") {
      return NextResponse.json(
        { error: API_ERROR.API_KEY_SCOPE_INSUFFICIENT },
        { status: 403 },
      );
    }
    return unauthorized();
  }

  const { userId, tenantId, apiKeyId } = authResult.data;

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const rl = await apiKeyLimiter.check(`rl:api_key:${apiKeyId}`);
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
