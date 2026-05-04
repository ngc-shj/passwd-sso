// Self-test fixture — GOOD: updates emergencyAccessGrant without touching status.
// The CI guard MUST NOT flag this file.
// DO NOT import or use this file in production code.

// Placeholder type to avoid requiring a real Prisma import in the fixture.
const prisma = {} as {
  emergencyAccessGrant: {
    updateMany: (args: { where: object; data: object }) => Promise<{ count: number }>;
  };
};

async function clearEphemeralKey(ownerId: string): Promise<void> {
  // GOOD: updates revokedAt (not status) — within policy for inline mutations
  await prisma.emergencyAccessGrant.updateMany({
    where: { ownerId },
    data: { revokedAt: new Date() },
  });
}

void clearEphemeralKey;
export {};
