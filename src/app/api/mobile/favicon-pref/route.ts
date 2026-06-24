/**
 * GET  /api/mobile/favicon-pref — Read the current favicon fetch preference
 * PUT  /api/mobile/favicon-pref — Update the favicon fetch preference
 *
 * iOS-DPoP-authenticated preference management. Mirrors the web route
 * (/api/user/favicon-pref) but uses validateExtensionToken (DPoP) instead of
 * Auth.js session, and enforces the IOS_APP clientKind guard.
 *
 * Both handlers use withTenantRls (NOT withUserTenantRls) so that the RLS
 * context is set correctly for extension tokens where tenantId is always
 * present.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { validateExtensionToken } from "@/lib/auth/tokens/extension-token";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { withTenantRls } from "@/lib/tenant-rls";
import { parseBody } from "@/lib/http/parse-body";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  errorResponse,
  forbidden,
} from "@/lib/http/api-response";
import { withRequestLog } from "@/lib/http/with-request-log";

export const runtime = "nodejs";

const updateFaviconPrefSchema = z.object({ fetchFavicons: z.boolean() }).strict();

async function handleGET(req: NextRequest): Promise<Response> {
  const auth = await validateExtensionToken(req);
  if (!auth.ok) {
    return errorResponse(API_ERROR[auth.error], 401);
  }
  const { userId, tenantId, clientKind } = auth.data;

  if (clientKind !== "IOS_APP") {
    return forbidden();
  }

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const user = await withTenantRls(prisma, tenantId, (tx) =>
    tx.user.findUnique({
      where: { id: userId },
      select: { fetchFavicons: true },
    }),
  );

  return NextResponse.json({ fetchFavicons: user?.fetchFavicons ?? false });
}

async function handlePUT(req: NextRequest): Promise<Response> {
  const auth = await validateExtensionToken(req);
  if (!auth.ok) {
    return errorResponse(API_ERROR[auth.error], 401);
  }
  const { userId, tenantId, clientKind } = auth.data;

  if (clientKind !== "IOS_APP") {
    return forbidden();
  }

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const result = await parseBody(req, updateFaviconPrefSchema);
  if (!result.ok) return result.response;

  await withTenantRls(prisma, tenantId, (tx) =>
    tx.user.update({
      where: { id: userId },
      data: { fetchFavicons: result.data.fetchFavicons },
    }),
  );

  return NextResponse.json({ fetchFavicons: result.data.fetchFavicons });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
