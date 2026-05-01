/**
 * Integration tests for AuditAnchorPublisher (FR2 + happy path, T2).
 *
 * Setup:
 *   - 2 tenants with audit_chain_enabled = true, with audit_logs rows + anchors advanced.
 *   - 1 tenant with audit_chain_enabled = false (must be excluded from manifest).
 *
 * Assertions:
 *   - runCadence returns { kind: "published", tenantsCount: 2 }
 *   - audit_chain_anchors.last_published_at updated for both chain-enabled tenants
 *   - system_settings row for audit_anchor_previous_manifest exists with sha256 matching
 *   - The disabled tenant is NOT in the manifest tenants[] array
 *   - The published JWS verifies with the signing public key
 *
 * Uses FilesystemDestination (temp dir) to avoid S3/GitHub dependencies.
 * Uses FR7/FR8 stubs (see bottom of file) — TODO markers for future implementation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes, createPrivateKey, createPublicKey } from "node:crypto";
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
import { verify as verifyManifest } from "@/lib/audit/anchor-manifest";
import { computeTenantTag } from "@/lib/audit/anchor-manifest";

// Fresh Ed25519 seed (32 bytes) for each test run
const SIGNING_KEY = randomBytes(32);
const TAG_SECRET = randomBytes(32);

// PKCS8 prefix for Ed25519 private key (RFC 8410)
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// SPKI prefix for Ed25519 public key (RFC 8410)
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Derive the 32-byte Ed25519 public key from the seed (private key).
 * Node's createPrivateKey + createPublicKey is the supported path.
 */
function derivePublicKey(seed: Buffer): Buffer {
  const privKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const pubKey = createPublicKey(privKey);
  const rawDer = pubKey.export({ type: "spki", format: "der" }) as Buffer;
  // Strip the SPKI prefix (12 bytes) to get the raw 32-byte public key
  return rawDer.subarray(ED25519_SPKI_PREFIX.length);
}

describe("AuditAnchorPublisher — FR2 happy-path integration", () => {
  let ctx: TestContext;
  let tenantEnabled1: string;
  let tenantEnabled2: string;
  let tenantDisabled: string;
  let tmpDir: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-publisher-test-"));
  });

  afterAll(async () => {
    await ctx.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    tenantEnabled1 = await ctx.createTenant();
    tenantEnabled2 = await ctx.createTenant();
    tenantDisabled = await ctx.createTenant();

    // Enable audit chain for tenants 1 and 2
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = true WHERE id = ANY($1::uuid[])`,
        [tenantEnabled1, tenantEnabled2],
      );
      await tx.$executeRawUnsafe(
        `UPDATE tenants SET audit_chain_enabled = false WHERE id = $1::uuid`,
        tenantDisabled,
      );
    });

    // Seed anchor rows with chain_seq = 5 for both chain-enabled tenants
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const prevHash = randomBytes(32).toString("hex");
      for (const tenantId of [tenantEnabled1, tenantEnabled2]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at, epoch)
           VALUES ($1::uuid, 5, $2::bytea, now(), 1)
           ON CONFLICT (tenant_id) DO UPDATE
             SET chain_seq = 5, prev_hash = $2::bytea, epoch = 1, updated_at = now()`,
          tenantId,
          `\\x${prevHash}`,
        );
      }
    });

    // Clean up system_settings for this deployment from prior runs
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM system_settings WHERE key IN ('audit_anchor_previous_manifest', 'audit_anchor_deployment_id')`,
      );
    });
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantEnabled1);
    await ctx.deleteTestData(tenantEnabled2);
    await ctx.deleteTestData(tenantDisabled);
    // Clean up system_settings after test
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM system_settings WHERE key IN ('audit_anchor_previous_manifest', 'audit_anchor_deployment_id')`,
      );
    });
    // Clean up written artifacts
    const files = await fs.readdir(tmpDir).catch(() => []);
    for (const f of files) {
      await fs.unlink(path.join(tmpDir, f)).catch(() => undefined);
    }
  });

  it("FR2: runCadence publishes manifest covering exactly the 2 chain-enabled tenants", async () => {
    const deploymentId = `test-deploy-${randomBytes(4).toString("hex")}`;
    const kid = `audit-anchor-${randomBytes(4).toString("hex")}`;

    const config: PublisherConfig = {
      databaseUrl: process.env.DATABASE_URL!,
      deploymentId,
      signingKey: SIGNING_KEY,
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

    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") return;

    expect(outcome.tenantsCount).toBe(2);
    expect(outcome.destinations).toContain("filesystem");
    expect(outcome.manifestSha256).toMatch(/^[0-9a-f]{64}$/);

    // Verify last_published_at updated for both chain-enabled tenants
    const anchors = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ tenant_id: string; last_published_at: Date | null }[]>(
        `SELECT tenant_id, last_published_at FROM audit_chain_anchors
         WHERE tenant_id = ANY($1::uuid[])`,
        [tenantEnabled1, tenantEnabled2],
      );
    });

    for (const anchor of anchors) {
      expect(anchor.last_published_at).not.toBeNull();
    }

    // Verify system_settings row for audit_anchor_previous_manifest
    const settings = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ key: string; value: string }[]>(
        `SELECT key, value FROM system_settings WHERE key = 'audit_anchor_previous_manifest'`,
      );
    });

    expect(settings).toHaveLength(1);
    const manifestPtr = JSON.parse(settings[0]!.value) as { uri: string; sha256: string };
    expect(manifestPtr.sha256).toBe(outcome.manifestSha256);

    // Verify the artifact was written to the filesystem destination
    const artifactFiles = await fs.readdir(tmpDir);
    expect(artifactFiles.length).toBeGreaterThan(0);
    const jwsFile = artifactFiles.find((f) => f.endsWith(".jws"));
    expect(jwsFile).toBeDefined();

    // Read and verify the JWS signature
    const jwsContent = await fs.readFile(path.join(tmpDir, jwsFile!), "utf-8");
    const publicKey = derivePublicKey(SIGNING_KEY);
    const manifest = verifyManifest(jwsContent.trim(), publicKey);

    // Manifest must contain exactly 2 tenant entries
    expect(manifest.tenants).toHaveLength(2);

    // The disabled tenant's tag must NOT be in the manifest
    const disabledTag = computeTenantTag(tenantDisabled, TAG_SECRET);
    const tenantTagsInManifest = manifest.tenants.map((t) => t.tenantTag);
    expect(tenantTagsInManifest).not.toContain(disabledTag);

    // Both chain-enabled tenant tags must be present
    const tag1 = computeTenantTag(tenantEnabled1, TAG_SECRET);
    const tag2 = computeTenantTag(tenantEnabled2, TAG_SECRET);
    expect(tenantTagsInManifest).toContain(tag1);
    expect(tenantTagsInManifest).toContain(tag2);

    // Each tenant entry must have chainSeq = "5" and epoch = 1
    for (const entry of manifest.tenants) {
      expect(entry.chainSeq).toBe("5");
      expect(entry.epoch).toBe(1);
    }
  });

  // FR7 stub — key rotation overlap test
  // TODO: implement FR7 (key rotation): generate new key, publish overlap manifest under both
  //       keys, retire old key. Requires multi-cadence test fixtures.
  it.todo("FR7: key rotation overlap — manifest published under both old and new key");

  // FR8 stub — regression detection test
  // TODO: implement FR8 (regression detection): verify that lower chain_seq in subsequent
  //       publication is detected as a tamper signal by the verifier.
  it.todo("FR8: chain_seq regression detection — lower seq in later manifest is a tamper signal");
});
