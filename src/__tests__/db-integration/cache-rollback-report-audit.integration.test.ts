/**
 * iOS AutoFill MVP — T43: cache-rollback-report endpoint emits the correct
 * audit row.
 *
 * Verifies that POST /api/mobile/cache-rollback-report:
 *   1. Validates the iOS DPoP-signed request via validateExtensionToken.
 *   2. Enqueues a MOBILE_CACHE_ROLLBACK_REJECTED audit row to audit_outbox
 *      (or MOBILE_CACHE_FLAG_FORGED for the `flag_forged` rejectionKind).
 *
 * The assertion is at the outbox-row level, not at the drained-audit_logs
 * level: logAuditAsync awaits enqueueAudit() synchronously before returning,
 * so the outbox row is durable as soon as POST() resolves. We do not run the
 * outbox worker in-process here — that pipeline is covered by other
 * integration tests (audit-outbox-*.integration.test.ts).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { hashToken } from "@/lib/crypto/crypto-server";
import { computeAth } from "@/lib/auth/dpop/verify";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import {
  type TestKeypair,
  generateKeypair,
  makeProof,
} from "@/__tests__/helpers/dpop-test-keypair";
import { _resetJtiCacheForTests } from "@/lib/auth/dpop/jti-cache";
import { ROLLBACK_REJECTION_KIND } from "@/app/api/mobile/cache-rollback-report/route";

import { POST as cacheRollbackReportPOST } from "@/app/api/mobile/cache-rollback-report/route";

describe("POST /api/mobile/cache-rollback-report — audit emission (T43)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });
  beforeEach(async () => {
    // canonicalHtu reads APP_URL at call time (not import time), so the stub
    // here applies before any handler invocation. afterEach unstubs via setup.ts.
    vi.stubEnv("APP_URL", "https://app.example.test");
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    _resetJtiCacheForTests();
  });
  afterEach(async () => {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM extension_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  /** Insert an IOS_APP-typed extension_token row with a fixed cnfJkt. */
  async function insertIosTokenRow(plaintext: string, jkt: string): Promise<string> {
    const id = randomUUID();
    const familyId = randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_tokens (
           id, user_id, tenant_id, token_hash, scope, expires_at,
           created_at, family_id, family_created_at,
           client_kind, device_pubkey, cnf_jkt
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now(), $7::uuid, now(),
           'IOS_APP'::"ExtensionTokenClientKind", $8, $9
         )`,
        id,
        userId,
        tenantId,
        hashToken(plaintext),
        "passwords:read,passwords:write",
        expiresAt,
        familyId,
        // device_pubkey is stored separately; the cnf_jkt is what DPoP
        // verification compares against. Use a placeholder pubkey blob.
        "test-device-pubkey-base64url",
        jkt,
      );
    });
    return id;
  }

  /** Build a DPoP-signed POST request to the cache-rollback-report route. */
  async function buildRequest(args: {
    accessToken: string;
    kp: TestKeypair;
    body: Record<string, unknown>;
  }): Promise<NextRequest> {
    const htu = canonicalHtu({ route: "/api/mobile/cache-rollback-report" });
    const proof = await makeProof(args.kp, {
      jti: randomUUID(),
      htm: "POST",
      htu,
      iat: Math.floor(Date.now() / 1000),
      ath: computeAth(args.accessToken),
    });
    return new NextRequest(htu, {
      method: "POST",
      headers: {
        // extractBearer() in extension-token.ts only matches `Bearer`. The
        // DPoP-bound proof travels in the `dpop` header.
        authorization: `Bearer ${args.accessToken}`,
        dpop: proof,
        "content-type": "application/json",
      },
      body: JSON.stringify(args.body),
    });
  }

  /** Read pending outbox payloads for the test tenant. */
  async function readOutbox(): Promise<Array<{ payload: Record<string, unknown> }>> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<
        Array<{ payload: Record<string, unknown> }>
      >(
        `SELECT payload FROM audit_outbox
         WHERE tenant_id = $1::uuid
         ORDER BY created_at ASC`,
        tenantId,
      );
      return rows;
    });
  }

  it("counter_mismatch enqueues MOBILE_CACHE_ROLLBACK_REJECTED outbox row", async () => {
    const accessToken = `mob_${randomUUID().replace(/-/g, "")}`;
    const kp = await generateKeypair();
    const tokenId = await insertIosTokenRow(accessToken, kp.jkt);

    const body = {
      deviceId: "device-uuid-counter",
      expectedCounter: 42,
      observedCounter: 41,
      headerIssuedAt: 1_743_800_000,
      lastSuccessfulRefreshAt: 1_743_799_000,
      rejectionKind: ROLLBACK_REJECTION_KIND.COUNTER_MISMATCH,
    };

    const req = await buildRequest({ accessToken, kp, body });
    const res = await cacheRollbackReportPOST(req);
    expect(res.status).toBe(200);

    const rows = await readOutbox();
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload;
    expect(payload.action).toBe("MOBILE_CACHE_ROLLBACK_REJECTED");
    expect(payload.userId).toBe(userId);
    expect(payload.targetType).toBe("ExtensionToken");
    expect(payload.targetId).toBe(tokenId);
    expect(payload.metadata).toMatchObject({
      deviceId: "device-uuid-counter",
      rejectionKind: ROLLBACK_REJECTION_KIND.COUNTER_MISMATCH,
      expectedCounter: 42,
      observedCounter: 41,
    });
  });

  it("flag_forged enqueues MOBILE_CACHE_FLAG_FORGED outbox row", async () => {
    const accessToken = `mob_${randomUUID().replace(/-/g, "")}`;
    const kp = await generateKeypair();
    await insertIosTokenRow(accessToken, kp.jkt);

    const body = {
      deviceId: "device-uuid-flag",
      expectedCounter: 0,
      observedCounter: 0,
      headerIssuedAt: 1_743_800_000,
      lastSuccessfulRefreshAt: 1_743_800_000,
      rejectionKind: ROLLBACK_REJECTION_KIND.FLAG_FORGED,
    };

    const req = await buildRequest({ accessToken, kp, body });
    const res = await cacheRollbackReportPOST(req);
    expect(res.status).toBe(200);

    const rows = await readOutbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.action).toBe("MOBILE_CACHE_FLAG_FORGED");
    expect(rows[0].payload.metadata).toMatchObject({
      deviceId: "device-uuid-flag",
      rejectionKind: ROLLBACK_REJECTION_KIND.FLAG_FORGED,
    });
  });
});
