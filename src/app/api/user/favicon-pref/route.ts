import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/http/parse-body";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { unauthorized } from "@/lib/http/api-response";

const updateFaviconPrefSchema = z.object({ fetchFavicons: z.boolean() }).strict();

// PUT /api/user/favicon-pref — Update user's favicon fetch preference
async function handlePUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const result = await parseBody(req, updateFaviconPrefSchema);
  if (!result.ok) return result.response;

  await withUserTenantRls(session.user.id, async () =>
    prisma.user.update({
      where: { id: session.user.id },
      data: { fetchFavicons: result.data.fetchFavicons },
    }),
  );

  return NextResponse.json({ fetchFavicons: result.data.fetchFavicons });
}

export const PUT = withRequestLog(handlePUT);
