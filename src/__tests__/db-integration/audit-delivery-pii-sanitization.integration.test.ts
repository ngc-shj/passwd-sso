/**
 * Phase 3: PII sanitization — blocklisted metadata keys are stripped
 * from external delivery payloads. Tests both METADATA_BLOCKLIST
 * (crypto keys) and EXTERNAL_DELIVERY_METADATA_BLOCKLIST (business PII).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { METADATA_BLOCKLIST } from "@/lib/audit/audit-logger";
import {
  EXTERNAL_DELIVERY_METADATA_BLOCKLIST,
  sanitizeForExternalDelivery,
} from "@/lib/http/external-http";

describe("audit-delivery PII sanitization", () => {
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
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });
  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  it("EXTERNAL_DELIVERY_METADATA_BLOCKLIST is a superset of METADATA_BLOCKLIST", () => {
    for (const key of METADATA_BLOCKLIST) {
      expect(EXTERNAL_DELIVERY_METADATA_BLOCKLIST.has(key)).toBe(true);
    }
  });

  it("EXTERNAL_DELIVERY_METADATA_BLOCKLIST includes business PII keys", () => {
    const expectedPiiKeys = [
      "email",
      "targetUserEmail",
      "reason",
      "incidentRef",
      "displayName",
      "justification",
      "requestedScope",
    ];
    for (const key of expectedPiiKeys) {
      expect(EXTERNAL_DELIVERY_METADATA_BLOCKLIST.has(key)).toBe(true);
    }
  });

  it("sanitizeForExternalDelivery strips all blocklisted keys from flat payload", () => {
    const payload = {
      id: randomUUID(),
      tenantId,
      action: "ENTRY_CREATE",
      scope: "PERSONAL",
      userId,
      actorType: "HUMAN",
      metadata: {
        entryId: randomUUID(),
        email: "user@example.com",
        targetUserEmail: "target@example.com",
        displayName: "John Doe",
        password: "supersecret",
        encryptedBlob: "base64data",
        reason: "emergency",
        justification: "need access",
        requestedScope: "vault:unlock-data",
        incidentRef: "INC-001",
        token: "abc123",
      },
      createdAt: new Date().toISOString(),
    };

    const sanitized = sanitizeForExternalDelivery(payload) as Record<string, unknown>;

    // Non-blocklisted fields should survive
    expect(sanitized.id).toBe(payload.id);
    expect(sanitized.action).toBe("ENTRY_CREATE");
    expect(sanitized.scope).toBe("PERSONAL");

    // Metadata should have blocklisted keys removed
    const meta = sanitized.metadata as Record<string, unknown>;
    expect(meta.entryId).toBeDefined();

    // All blocklisted keys must be absent
    expect(meta.email).toBeUndefined();
    expect(meta.targetUserEmail).toBeUndefined();
    expect(meta.displayName).toBeUndefined();
    expect(meta.password).toBeUndefined();
    expect(meta.encryptedBlob).toBeUndefined();
    expect(meta.reason).toBeUndefined();
    expect(meta.justification).toBeUndefined();
    expect(meta.requestedScope).toBeUndefined();
    expect(meta.incidentRef).toBeUndefined();
    expect(meta.token).toBeUndefined();
  });

  it("sanitizeForExternalDelivery strips nested blocklisted keys", () => {
    const payload = {
      action: "EMERGENCY_ACCESS_REQUEST",
      metadata: {
        outer: {
          email: "nested@example.com",
          safeField: "keep-me",
        },
      },
    };

    const sanitized = sanitizeForExternalDelivery(payload) as Record<string, unknown>;
    const meta = sanitized.metadata as Record<string, unknown>;
    const outer = meta.outer as Record<string, unknown>;

    expect(outer.email).toBeUndefined();
    expect(outer.safeField).toBe("keep-me");
  });

  it("outbox row with blocklisted metadata keys retains them (sanitization is at delivery time)", async () => {
    // The outbox stores the full metadata including PII — sanitization
    // happens when the deliverer builds the external payload, not at enqueue time.
    const metadataWithPii = {
      entryId: randomUUID(),
      email: "user@example.com",
      targetUserEmail: "target@example.com",
    };

    const outboxId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_outbox (id, tenant_id, payload, status, sent_at)
         VALUES ($1::uuid, $2::uuid, $3::jsonb, 'SENT', now())`,
        outboxId,
        tenantId,
        JSON.stringify({
          scope: "PERSONAL",
          action: "ENTRY_CREATE",
          userId,
          actorType: "HUMAN",
          metadata: metadataWithPii,
        }),
      );
    });

    // Read back from DB — PII keys are still present in the stored payload
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ payload: Record<string, unknown> }[]>(
        `SELECT payload FROM audit_outbox WHERE id = $1::uuid`,
        outboxId,
      );
    });

    const storedMeta = (rows[0].payload as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(storedMeta.email).toBe("user@example.com");
    expect(storedMeta.targetUserEmail).toBe("target@example.com");
    expect(storedMeta.entryId).toBeDefined();
  });

  it("sanitizeForExternalDelivery handles null and undefined gracefully", () => {
    expect(sanitizeForExternalDelivery(null)).toBeNull();
    expect(sanitizeForExternalDelivery(undefined)).toBeUndefined();
  });

  it("sanitizeForExternalDelivery handles arrays with blocklisted keys", () => {
    const payload = [
      { email: "a@example.com", safe: "keep" },
      { email: "b@example.com", safe: "also-keep" },
    ];

    const sanitized = sanitizeForExternalDelivery(payload) as Array<Record<string, unknown>>;
    expect(sanitized).toHaveLength(2);
    expect(sanitized[0].email).toBeUndefined();
    expect(sanitized[0].safe).toBe("keep");
    expect(sanitized[1].email).toBeUndefined();
    expect(sanitized[1].safe).toBe("also-keep");
  });
});
