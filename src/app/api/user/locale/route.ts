import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { withUserTenantRls } from "@/lib/tenant-context";
import { routing } from "@/i18n/routing";
import { z } from "zod";

const updateLocaleSchema = z.object({
  locale: z.enum(routing.locales as unknown as [string, ...string[]]),
});

// PUT /api/user/locale — Update user's preferred locale
export async function PUT(req: NextRequest) {
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

  const parsed = updateLocaleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.user.update({
      where: { id: session.user.id },
      data: { locale: parsed.data.locale },
    }),
  );

  return NextResponse.json({ locale: parsed.data.locale });
}
