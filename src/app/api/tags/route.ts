import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createTagSchema } from "@/lib/validations";

// GET /api/tags - List user's tags with password count
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tags = await prisma.tag.findMany({
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
  });

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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, color } = parsed.data;

  // Check for duplicate name per user
  const existing = await prisma.tag.findUnique({
    where: { name_userId: { name, userId: session.user.id } },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Tag already exists" },
      { status: 409 }
    );
  }

  const tag = await prisma.tag.create({
    data: {
      name,
      color: color || null,
      userId: session.user.id,
    },
  });

  return NextResponse.json(
    { id: tag.id, name: tag.name, color: tag.color },
    { status: 201 }
  );
}
