import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createOrgSchema } from "@/lib/validations";
import { generateOrgKey, wrapOrgKey } from "@/lib/crypto-server";

// GET /api/orgs — List organizations the user belongs to
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.orgMember.findMany({
    where: { userId: session.user.id },
    include: {
      org: {
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          createdAt: true,
        },
      },
    },
    orderBy: { org: { name: "asc" } },
  });

  const orgs = memberships.map((m) => ({
    ...m.org,
    role: m.role,
  }));

  return NextResponse.json(orgs);
}

// POST /api/orgs — Create a new organization
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

  const parsed = createOrgSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, slug, description } = parsed.data;

  // Check slug uniqueness
  const existing = await prisma.organization.findUnique({
    where: { slug },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Slug already taken" },
      { status: 409 }
    );
  }

  // Generate and wrap per-org encryption key
  const orgKey = generateOrgKey();
  const wrappedKey = wrapOrgKey(orgKey);

  const org = await prisma.organization.create({
    data: {
      name,
      slug,
      description: description || null,
      encryptedOrgKey: wrappedKey.ciphertext,
      orgKeyIv: wrappedKey.iv,
      orgKeyAuthTag: wrappedKey.authTag,
      members: {
        create: {
          userId: session.user.id,
          role: "OWNER",
        },
      },
    },
  });

  return NextResponse.json(
    {
      id: org.id,
      name: org.name,
      slug: org.slug,
      description: org.description,
      role: "OWNER",
      createdAt: org.createdAt,
    },
    { status: 201 }
  );
}
