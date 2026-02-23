import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { ORG_ROLE } from "@/lib/constants";

// GET /api/orgs/pending-key-distributions
// Returns all pending key distributions across all orgs where the user is OWNER/ADMIN.
// Used for automatic background key distribution after vault unlock.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  // Find orgs where the user is OWNER or ADMIN and org is E2E-enabled
  const adminMemberships = await prisma.orgMember.findMany({
    where: {
      userId: session.user.id,
      role: { in: [ORG_ROLE.OWNER, ORG_ROLE.ADMIN] },
    },
    select: { orgId: true },
  });

  if (adminMemberships.length === 0) {
    return NextResponse.json([]);
  }

  const orgIds = adminMemberships.map((m) => m.orgId);

  // Find members who need key distribution
  const pendingMembers = await prisma.orgMember.findMany({
    where: {
      orgId: { in: orgIds },
      keyDistributed: false,
      user: {
        ecdhPublicKey: { not: null },
      },
    },
    select: {
      id: true,
      orgId: true,
      userId: true,
      user: {
        select: {
          ecdhPublicKey: true,
          name: true,
          email: true,
        },
      },
      org: {
        select: {
          orgKeyVersion: true,
        },
      },
    },
  });

  const result = pendingMembers.map((m) => ({
    memberId: m.id,
    orgId: m.orgId,
    userId: m.userId,
    ecdhPublicKey: m.user.ecdhPublicKey,
    name: m.user.name,
    email: m.user.email,
    orgKeyVersion: m.org.orgKeyVersion,
  }));

  return NextResponse.json(result);
}
