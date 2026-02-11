import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { updateTagSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";

// PUT /api/tags/[id] - Update a tag
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.tag.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = updateTagSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updateData: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name;
  if (parsed.data.color !== undefined)
    updateData.color = parsed.data.color || null;

  // Check for duplicate name if name is being changed
  if (updateData.name && updateData.name !== existing.name) {
    const duplicate = await prisma.tag.findUnique({
      where: {
        name_userId: {
          name: updateData.name as string,
          userId: session.user.id,
        },
      },
    });
    if (duplicate) {
      return NextResponse.json(
        { error: API_ERROR.TAG_ALREADY_EXISTS },
        { status: 409 }
      );
    }
  }

  const tag = await prisma.tag.update({
    where: { id },
    data: updateData,
  });

  return NextResponse.json({ id: tag.id, name: tag.name, color: tag.color });
}

// DELETE /api/tags/[id] - Delete a tag
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.tag.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  await prisma.tag.delete({ where: { id } });

  return NextResponse.json({ success: true });
}
