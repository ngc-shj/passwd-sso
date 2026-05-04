// Self-test fixture — BAD: contains an inline status mutation outside the allowlist.
// The CI guard MUST flag this file.
// DO NOT import or use this file in production code.

// Placeholder type to avoid requiring a real Prisma import in the fixture.
const prisma = {} as {
  emergencyAccessGrant: {
    updateMany: (args: { where: object; data: object }) => Promise<{ count: number }>;
  };
};

async function badRevoke(grantId: string): Promise<void> {
  // BAD: writes data: { status: ... } directly — should go through transition()
  await prisma.emergencyAccessGrant.updateMany({
    where: { id: grantId },
    data: { status: "REVOKED" },
  });
}

void badRevoke;
export {};
