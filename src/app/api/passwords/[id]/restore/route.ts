import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";

// POST /api/passwords/[id]/restore - Restore from trash
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.passwordEntry.findUnique({
    where: { id },
  });

  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!existing.deletedAt) {
    return NextResponse.json({ error: "Not in trash" }, { status: 400 });
  }

  await prisma.passwordEntry.update({
    where: { id },
    data: { deletedAt: null },
  });

  logAudit({
    scope: "PERSONAL",
    action: "ENTRY_RESTORE",
    userId: session.user.id,
    targetType: "PasswordEntry",
    targetId: id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
