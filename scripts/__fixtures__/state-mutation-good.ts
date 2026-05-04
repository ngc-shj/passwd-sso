// Self-test fixture — GOOD: every mutation either skips the status column or
// is on a non-target model. The CI guard MUST NOT flag any line in this file.
// DO NOT import or use this file in production code.

type UpdateArgs = { where: object; data: object };
type UpsertArgs = { where: object; create: object; update: object };
const prisma = {} as {
  emergencyAccessGrant: {
    update: (args: UpdateArgs) => Promise<unknown>;
    updateMany: (args: UpdateArgs) => Promise<{ count: number }>;
    upsert: (args: UpsertArgs) => Promise<unknown>;
  };
  accessRequest: {
    updateMany: (args: UpdateArgs) => Promise<{ count: number }>;
  };
  // Non-target model — status writes here are out of scope.
  user: {
    update: (args: UpdateArgs) => Promise<unknown>;
  };
};

// 1) Updates a non-status column on a target model — fine
async function clearEphemeralKey(ownerId: string): Promise<void> {
  await prisma.emergencyAccessGrant.updateMany({
    where: { ownerId },
    data: { revokedAt: new Date() },
  });
}

// 2) status: null is a clear (allowed; the lint allows null literal explicitly)
async function clearStatusField(grantId: string): Promise<void> {
  await prisma.emergencyAccessGrant.update({
    where: { id: grantId },
    data: { status: null },
  });
}

// 3) Upsert without status in either payload
async function upsertWithoutStatus(grantId: string): Promise<void> {
  await prisma.emergencyAccessGrant.upsert({
    where: { id: grantId },
    create: { revokedAt: null } as object,
    update: { revokedAt: new Date() } as object,
  });
}

// 4) status write on a NON-target model — out of scope for this lint
async function userStatusFieldUnrelated(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { status: "ACTIVE" },
  });
}

// 5) accessRequest update with non-status field
async function rotateApprovedBy(reqId: string, approver: string): Promise<void> {
  await prisma.accessRequest.updateMany({
    where: { id: reqId },
    data: { approvedById: approver },
  });
}

void clearEphemeralKey;
void clearStatusField;
void upsertWithoutStatus;
void userStatusFieldUnrelated;
void rotateApprovedBy;
export {};
