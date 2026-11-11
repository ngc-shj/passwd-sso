/**
 * Real-DB tests for duplicateGrantWhere (C6): the emergency-access POST
 * duplicate check must not treat a never-accepted invite whose token has
 * expired as a live duplicate, while ACCEPTED/ACTIVATED grants — whose
 * token_expires_at is only the invite window — still block a re-invite.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { duplicateGrantWhere } from "@/lib/emergency-access/emergency-access-server";

describe("emergency-access duplicateGrantWhere (C6)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let ownerId: string;
  const granteeEmail = "grantee-dup@example.com";
  const MS_PER_HOUR = 60 * 60 * 1000;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    ownerId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function insertGrant(status: string, tokenExpiresAt: Date): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO emergency_access_grants
           (id, owner_id, grantee_email, wait_days, token_hash, token_expires_at, status, tenant_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 3, $4, $5::timestamptz, $6::"EmergencyAccessStatus", $7::uuid, now(), now())`,
        id,
        ownerId,
        granteeEmail,
        `tok-${id.slice(0, 16)}`,
        tokenExpiresAt,
        status,
        tenantId,
      );
    });
    return id;
  }

  async function findDuplicate(now: Date, email = granteeEmail): Promise<string | null> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const row = await tx.emergencyAccessGrant.findFirst({
        where: duplicateGrantWhere(ownerId, email, now),
        select: { id: true },
      });
      return row?.id ?? null;
    });
  }

  it("a live PENDING invite is a duplicate", async () => {
    const now = new Date();
    const id = await insertGrant("PENDING", new Date(now.getTime() + MS_PER_HOUR));
    expect(await findDuplicate(now)).toBe(id);
  });

  it("matches the grantee email case-insensitively", async () => {
    const now = new Date();
    const id = await insertGrant("PENDING", new Date(now.getTime() + MS_PER_HOUR));
    expect(await findDuplicate(now, granteeEmail.toUpperCase())).toBe(id);
  });

  it("an expired PENDING invite is not a duplicate", async () => {
    const now = new Date();
    await insertGrant("PENDING", new Date(now.getTime() - MS_PER_HOUR));
    expect(await findDuplicate(now)).toBeNull();
  });

  it("a PENDING invite expiring exactly at `now` is not a duplicate", async () => {
    const now = new Date();
    await insertGrant("PENDING", now);
    expect(await findDuplicate(now)).toBeNull();
  });

  it.each(["ACCEPTED", "ACTIVATED"])(
    "an %s grant with a past token_expires_at is still a duplicate",
    async (status) => {
      const now = new Date();
      const id = await insertGrant(status, new Date(now.getTime() - MS_PER_HOUR));
      expect(await findDuplicate(now)).toBe(id);
    },
  );

  it.each(["REVOKED", "REJECTED"])("a %s grant is not a duplicate", async (status) => {
    const now = new Date();
    await insertGrant(status, new Date(now.getTime() + MS_PER_HOUR));
    expect(await findDuplicate(now)).toBeNull();
  });
});
