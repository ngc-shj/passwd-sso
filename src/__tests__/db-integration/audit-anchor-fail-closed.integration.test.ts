/**
 * Integration tests for AuditAnchorPublisher fail-closed behavior (FR6, T2),
 * run as passwd_anchor_publisher.
 *
 * Variant 1: signing key is corrupt/invalid → runCadence returns failed at
 *            stage before_upload and publish_paused_until is NOT set.
 * Variant 2: filesystem destination configured to a non-writable path →
 *            upload throws → publish_paused_until is set to the next boundary
 *            by the wall clock (no longer), and the failure and missing-prior
 *            paths leave their outbox rows.
 * Bounds:    the injected upload and transaction bounds fail a run within the
 *            test budget.
 *
 * Note on Variant 1 key corruption:
 *   sign() in anchor-manifest.ts wraps Buffer → createPrivateKey → nodeSign.
 *   A 32-byte all-zeros buffer IS a valid DER seed format for Ed25519; Node does not
 *   reject it at key-construction time. Providing a short seed (< 32 bytes) or an
 *   empty buffer causes the DER construction to produce an invalid key object, which
 *   causes nodeSign to throw. We use a 1-byte buffer to reliably trigger the failure.
 *
 * Isolation as in audit-anchor-publisher.integration.test.ts
 * (anchor-publisher-fixtures.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestContext, createPrismaForRole, type PrismaWithPool, type TestContext } from "./helpers";
import {
  CADENCE_MS,
  OFFSET_MS,
  SETTING,
  anchorState,
  assertOnlyChainEnabledTenants,
  clearPublisherSettings,
  farFutureBoundary,
  makePublisherConfig,
  publisherOutboxRows,
  purgePublisherOutboxRows,
  restorePublisherSettings,
  seedChainTenant,
  snapshotPublisherSettings,
  type SettingsSnapshot,
} from "./anchor-publisher-fixtures";
import { AuditAnchorPublisher, currentCadenceBoundary, type PublisherConfig } from "@/workers/audit-anchor-publisher";
import { FilesystemDestination } from "@/lib/audit/anchor-destinations/filesystem-destination";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";

describe("AuditAnchorPublisher — FR6 fail-closed", () => {
  let ctx: TestContext;
  let pub: PrismaWithPool;
  let snapshot: SettingsSnapshot;
  let tenantEnabled: string;
  let tmpDir: string;
  let base: Date;
  let caseIndex = 0;
  const usedBoundaries: Date[] = [];

  function nextBoundary(): Date {
    const b = new Date(base.getTime() + caseIndex++ * 10 * CADENCE_MS);
    usedBoundaries.push(b);
    return b;
  }

  function publisher(config: PublisherConfig): AuditAnchorPublisher {
    return new AuditAnchorPublisher({ prisma: pub.prisma, config });
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertOnlyChainEnabledTenants(ctx.su, []);
    pub = createPrismaForRole("anchor-publisher");
    snapshot = await snapshotPublisherSettings(ctx.su);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-fail-closed-test-"));
    base = farFutureBoundary();
  });

  afterAll(async () => {
    await purgePublisherOutboxRows(ctx.su, usedBoundaries);
    await restorePublisherSettings(ctx.su, snapshot);
    await pub.prisma.$disconnect();
    await pub.pool.end();
    await ctx.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    tenantEnabled = await ctx.createTenant();
    await seedChainTenant(ctx.su, tenantEnabled, { enabled: true, chainSeq: 3 });
    await assertOnlyChainEnabledTenants(ctx.su, [tenantEnabled]);
    await clearPublisherSettings(ctx.su);
  });

  afterEach(async () => {
    await clearPublisherSettings(ctx.su, [SETTING.UPLOAD_ATTEMPTS]);
    await clearPublisherSettings(ctx.su);
    await purgePublisherOutboxRows(ctx.su, usedBoundaries);
    await ctx.deleteTestData(tenantEnabled);
    for (const f of await fs.readdir(tmpDir).catch(() => [])) {
      await fs.unlink(path.join(tmpDir, f)).catch(() => undefined);
    }
  });

  it("Variant 1: corrupt/truncated signing key → failed before the upload, no pause", async () => {
    const boundary = nextBoundary();
    const corruptKey = Buffer.from([0x01]); // 1 byte — not a valid 32-byte Ed25519 seed
    const config = makePublisherConfig([new FilesystemDestination({ basePath: tmpDir })], { signingKey: corruptKey });

    const outcome = await publisher(config).runCadence(boundary);

    expect(outcome).toMatchObject({ kind: "failed", stage: "before_upload" });
    expect((await anchorState(ctx.su, [tenantEnabled]))[0]?.publish_paused_until).toBeNull();
    expect((await publisherOutboxRows(ctx.su, [boundary])).map((r) => r.action)).toContain(
      "AUDIT_ANCHOR_PUBLISH_FAILED",
    );
  });

  it("Variant 2: non-writable filesystem destination → filesystem_UPLOAD_FAILED, paused only to the next boundary", async () => {
    const boundary = nextBoundary();
    // /dev/null/disabled cannot be a directory.
    const config = makePublisherConfig([new FilesystemDestination({ basePath: "/dev/null/disabled" })]);

    const before = Date.now();
    const outcome = await publisher(config).runCadence(boundary);
    const after = Date.now();

    expect(outcome).toMatchObject({ kind: "failed", stage: "upload" });
    if (outcome.kind !== "failed") return;
    expect(outcome.reason).toContain("filesystem_UPLOAD_FAILED");

    // The pause is persisted in its own transaction after the publish
    // transaction rolled back, and ends at the next boundary by the wall clock.
    const [anchor] = await anchorState(ctx.su, [tenantEnabled]);
    const pausedUntil = anchor?.publish_paused_until?.getTime();
    const nextBoundaries = [before, after].map(
      (t) => currentCadenceBoundary(new Date(t), CADENCE_MS, OFFSET_MS).getTime() + CADENCE_MS,
    );
    expect(nextBoundaries).toContain(pausedUntil);

    // The failure row only: the missing-prior row goes out with a publish.
    expect((await publisherOutboxRows(ctx.su, [boundary])).map((r) => r.failureReason)).toEqual([outcome.reason]);
  });

  it("the injected upload bound fails a destination that never settles, within the test budget", async () => {
    const boundary = nextBoundary();
    const hanging: AnchorDestination = { name: "filesystem", upload: () => new Promise<void>(() => {}) };

    const started = Date.now();
    const outcome = await publisher(makePublisherConfig([hanging], { uploadTimeoutMs: 500 })).runCadence(boundary);

    expect(outcome).toMatchObject({ kind: "failed", stage: "upload", reason: "filesystem_UPLOAD_FAILED:UPLOAD_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("the injected transaction bound fails a run whose transaction outlives it, within the test budget", async () => {
    const boundary = nextBoundary();
    const slow: AnchorDestination = {
      name: "filesystem",
      upload: () => new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    };

    const started = Date.now();
    const outcome = await publisher(
      makePublisherConfig([slow], { txTimeoutMs: 1_000, uploadTimeoutMs: 10_000 }),
    ).runCadence(boundary);

    expect(outcome.kind).toBe("failed");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await anchorState(ctx.su, [tenantEnabled]))[0]?.last_published_at).toBeNull();
  });
});
