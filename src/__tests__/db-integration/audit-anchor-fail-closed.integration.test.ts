/**
 * Integration tests for AuditAnchorPublisher fail-closed behavior (FR6, T2).
 *
 * Variant 1: signing key is corrupt/invalid → runCadence returns { kind: "failed", reason }
 *            and publish_paused_until is NOT set (failure before upload attempt means
 *            the sign() call throws internally — caught in the try/catch wrapper).
 *
 * Variant 2: filesystem destination configured to a non-writable path →
 *            upload throws → publish_paused_until is set +
 *            runCadence returns { kind: "failed", reason containing filesystem_UPLOAD_FAILED }.
 *
 * Note on Variant 1 key corruption:
 *   sign() in anchor-manifest.ts wraps Buffer → createPrivateKey → nodeSign.
 *   A 32-byte all-zeros buffer IS a valid DER seed format for Ed25519; Node does not
 *   reject it at key-construction time. Providing a short seed (< 32 bytes) or an
 *   empty buffer causes the DER construction to produce an invalid key object, which
 *   causes nodeSign to throw. We use a 1-byte buffer to reliably trigger the failure.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { AuditAnchorPublisher } from "@/workers/audit-anchor-publisher";
import type { PublisherConfig } from "@/workers/audit-anchor-publisher";
import { FilesystemDestination } from "@/lib/audit/anchor-destinations/filesystem-destination";

// Valid 32-byte signing key (for "upload failure" variant)
const VALID_SIGNING_KEY = randomBytes(32);
const TAG_SECRET = randomBytes(32);

describe("AuditAnchorPublisher — FR6 fail-closed", () => {
  let ctx: TestContext;
  let tenantEnabled: string;
  let tmpDir: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-fail-closed-test-"));
  });

  afterAll(async () => {
    await ctx.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    tenantEnabled = await ctx.createTenant();

    // Enable audit chain
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = $1::uuid`,
        tenantEnabled,
      );
    });

    // Seed anchor row
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const prevHash = randomBytes(32).toString("hex");
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at, epoch)
         VALUES ($1::uuid, 3, $2::bytea, now(), 1)
         ON CONFLICT (tenant_id) DO UPDATE
           SET chain_seq = 3, prev_hash = $2::bytea, epoch = 1, updated_at = now()`,
        tenantEnabled,
        `\\x${prevHash}`,
      );
    });

    // Clean up system_settings from prior runs
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM system_settings WHERE key IN ('audit_anchor_previous_manifest', 'audit_anchor_deployment_id')`,
      );
    });
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantEnabled);
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM system_settings WHERE key IN ('audit_anchor_previous_manifest', 'audit_anchor_deployment_id')`,
      );
    });
    // Clean up temp files
    const files = await fs.readdir(tmpDir).catch(() => []);
    for (const f of files) {
      await fs.unlink(path.join(tmpDir, f)).catch(() => undefined);
    }
  });

  it("Variant 1: corrupt/truncated signing key → runCadence returns { kind: 'failed' }", async () => {
    // A 1-byte seed is invalid for Ed25519 — createPrivateKey will either produce
    // a malformed key or sign() will throw due to incorrect DER length.
    const corruptKey = Buffer.from([0x01]); // 1 byte — not a valid 32-byte Ed25519 seed

    const deploymentId = `test-fail-v1-${randomBytes(4).toString("hex")}`;
    const kid = `audit-anchor-${randomBytes(4).toString("hex")}`;

    const config: PublisherConfig = {
      databaseUrl: process.env.DATABASE_URL!,
      deploymentId,
      signingKey: corruptKey,
      signingKeyKid: kid,
      tagSecret: TAG_SECRET,
      destinations: [new FilesystemDestination({ basePath: tmpDir })],
      cadenceMs: 24 * 60 * 60 * 1000,
      publishOffsetMs: 5 * 60 * 1000,
      pauseCapFactor: 3,
    };

    const publisher = new AuditAnchorPublisher({ prisma: ctx.su.prisma, config });
    const now = new Date("2026-05-02T00:10:00.000Z");
    const outcome = await publisher.runCadence(now);

    // Must return failed (signing error caught by the outer try/catch)
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toBeTruthy();
  });

  it("Variant 2: non-writable filesystem destination → kind=failed with filesystem_UPLOAD_FAILED reason", async () => {
    // Use /dev/null/disabled — a path that cannot be a directory (not writable)
    const nonWritablePath = "/dev/null/disabled";

    const deploymentId = `test-fail-v2-${randomBytes(4).toString("hex")}`;
    const kid = `audit-anchor-${randomBytes(4).toString("hex")}`;

    const config: PublisherConfig = {
      databaseUrl: process.env.DATABASE_URL!,
      deploymentId,
      signingKey: VALID_SIGNING_KEY,
      signingKeyKid: kid,
      tagSecret: TAG_SECRET,
      destinations: [new FilesystemDestination({ basePath: nonWritablePath })],
      cadenceMs: 24 * 60 * 60 * 1000,
      publishOffsetMs: 5 * 60 * 1000,
      pauseCapFactor: 3,
    };

    const publisher = new AuditAnchorPublisher({ prisma: ctx.su.prisma, config });
    const now = new Date("2026-05-02T00:10:00.000Z");
    const outcome = await publisher.runCadence(now);

    // Must return failed due to upload error
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    // The reason must reference the upload failure
    expect(outcome.reason).toContain("filesystem_UPLOAD_FAILED");

    // FR6 fail-closed invariant: publish_paused_until is set in a SEPARATE tx
    // after the publish tx rolls back due to upload failure. The publish tx's
    // own pause UPDATE would be rolled back; the catch-block separate tx in
    // `runCadence` (`audit-anchor-publisher.ts`) persists the pause durably.
    // This test asserts the durably-persisted pause is observable post-rollback.
    const anchors = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ publish_paused_until: Date | null }[]>(
        `SELECT publish_paused_until FROM audit_chain_anchors WHERE tenant_id = $1::uuid`,
        tenantEnabled,
      );
    });

    expect(anchors).toHaveLength(1);
    // FR6 closes Phase 3 R1 newly-discovered bug: pause MUST be durably set
    // even when the publish tx rolls back on upload throw (closes R2-F1).
    expect(anchors[0]!.publish_paused_until).not.toBeNull();
  });
});
