// Self-test fixture — BAD: contains inline status mutations outside the allowlist.
// The CI guard MUST flag every mutation site below.
// DO NOT import or use this file in production code.

// Placeholder types to avoid requiring a real Prisma import in the fixture.
type UpdateArgs = { where: object; data: object };
type UpsertArgs = { where: object; create: object; update: object };
const prisma = {} as {
  emergencyAccessGrant: {
    update: (args: UpdateArgs) => Promise<unknown>;
    updateMany: (args: UpdateArgs) => Promise<{ count: number }>;
    upsert: (args: UpsertArgs) => Promise<unknown>;
  };
  accessRequest: {
    update: (args: UpdateArgs) => Promise<unknown>;
    updateMany: (args: UpdateArgs) => Promise<{ count: number }>;
  };
};
const tx = prisma; // simulate `prisma.$transaction((tx) => ...)` shape

// 1) updateMany + literal status
async function badRevokeUpdateMany(grantId: string): Promise<void> {
  await prisma.emergencyAccessGrant.updateMany({
    where: { id: grantId },
    data: { status: "REVOKED" },
  });
}

// 2) update + variable status (variable initializer)
async function badRevokeUpdateVar(grantId: string): Promise<void> {
  const next = "REVOKED";
  await prisma.emergencyAccessGrant.update({
    where: { id: grantId },
    data: { status: next },
  });
}

// 3) upsert with status in `update` payload
async function badUpsertUpdate(grantId: string): Promise<void> {
  await prisma.emergencyAccessGrant.upsert({
    where: { id: grantId },
    create: { /* shape elided */ } as object,
    update: { status: "REVOKED" },
  });
}

// 4) upsert with status in `create` payload (the other key payload checked)
async function badUpsertCreate(grantId: string): Promise<void> {
  await prisma.emergencyAccessGrant.upsert({
    where: { id: grantId },
    create: { status: "PENDING" } as object,
    update: { /* no status */ } as object,
  });
}

// 5) tx.<model>.update — transaction-prefixed call (any identifier alias)
async function badRevokeViaTx(grantId: string): Promise<void> {
  await tx.accessRequest.update({
    where: { id: grantId },
    data: { status: "DENIED" },
  });
}

// 6) Computed property name — opaque escape hatch, MUST be flagged
async function badComputedKey(grantId: string): Promise<void> {
  const k = "status";
  await prisma.emergencyAccessGrant.updateMany({
    where: { id: grantId },
    data: { [k]: "REVOKED" },
  });
}

// 7) Shorthand `{ status }` — variable name is "status"
async function badShorthand(grantId: string, status: string): Promise<void> {
  await prisma.emergencyAccessGrant.updateMany({
    where: { id: grantId },
    data: { status },
  });
}

// 8) Spread + status — the plain status property AFTER the spread is caught
async function badSpreadThenStatus(grantId: string, extra: object): Promise<void> {
  await prisma.emergencyAccessGrant.updateMany({
    where: { id: grantId },
    data: { ...extra, status: "REVOKED" },
  });
}

void badRevokeUpdateMany;
void badRevokeUpdateVar;
void badUpsertUpdate;
void badUpsertCreate;
void badRevokeViaTx;
void badComputedKey;
void badShorthand;
void badSpreadThenStatus;
export {};
