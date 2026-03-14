import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/parse-body";
import { withUserTenantRls } from "@/lib/tenant-context";
import { routing } from "@/i18n/routing";
import { z } from "zod";
import { withRequestLog } from "@/lib/with-request-log";
import { unauthorized } from "@/lib/api-response";

const updateLocaleSchema = z.object({
  locale: z.enum(routing.locales as unknown as [string, ...string[]]),
});

// PUT /api/user/locale — Update user's preferred locale
async function handlePUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const result = await parseBody(req, updateLocaleSchema);
  if (!result.ok) return result.response;

  await withUserTenantRls(session.user.id, async () =>
    prisma.user.update({
      where: { id: session.user.id },
      data: { locale: result.data.locale },
    }),
  );

  return NextResponse.json({ locale: result.data.locale });
}

export const PUT = withRequestLog(handlePUT);
