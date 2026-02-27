import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createTagSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { withUserTenantRls } from "@/lib/tenant-context";

// GET /api/tags - List user's tags with password count
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const tags = await withUserTenantRls(session.user.id, async () =>
    prisma.tag.findMany({
      where: { userId: session.user.id },
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: {
            passwords: {
              where: { deletedAt: null, isArchived: false },
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
      passwordCount: tag._count.passwords,
    }))
  );
}

// POST /api/tags - Create a new tag
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

  const parsed = createTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, color } = parsed.data;
  const actor = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  if (!actor) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Check for duplicate name per user
  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.tag.findUnique({
      where: { name_userId: { name, userId: session.user.id } },
    }),
  );
  if (existing) {
    return NextResponse.json(
      { error: API_ERROR.TAG_ALREADY_EXISTS },
      { status: 409 }
    );
  }

  const tag = await withUserTenantRls(session.user.id, async () =>
    prisma.tag.create({
      data: {
        name,
        color: color || null,
        userId: session.user.id,
        tenantId: actor.tenantId,
      },
    }),
  );

  return NextResponse.json(
    { id: tag.id, name: tag.name, color: tag.color },
    { status: 201 }
  );
}
