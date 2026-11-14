/**
 * Integration tests for AuditAnchorPublisher fail-closed behavior (FR6, T2),
 * run as passwd_anchor_publisher.
 *
 * Variant 1: signing key is corrupt/invalid → runCadence returns failed at
 *            stage before_upload and publish_paused_until is NOT set.
 * Variant 2: a filesystem primary nothing can be created under → its listing
 *            is empty, so the run reaches the create, which throws →
 *            publish_paused_until is set to the next boundary by the wall
 *            clock (no longer), and only the failure row is written.
 * Bounds:    the run's one bound on destination I/O ends a hanging listing
 *            and a hanging create each under its own token, and the injected
 *            transaction bound fails a run within the test budget.
 *
 * Note on Variant 1 key corruption:
 *   sign() in anchor-manifest.ts wraps Buffer → createPrivateKey → nodeSign.
 *   A 32-byte all-zeros buffer IS a valid DER seed format for Ed25519; Node does not
 *   reject it at key-construction time. A seed that is not 32 bytes is refused before
 *   any key object is built. We use a 1-byte buffer to reliably trigger the failure.
 *
 * Isolation as in audit-anchor-publisher.integration.test.ts
 * (anchor-publisher-fixtures.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTestContext, createPrismaForRole, type PrismaWithPool, type TestContext } from "./helpers";
import {
  CADENCE_MS,
  anchorState,
  createPublisherCase,
  restorePublisherSettings,
  snapshotPublisherSettings,
  wallClockAt,
  type PublisherCase,
  type SettingsSnapshot,
} from "./anchor-publisher-fixtures";
import { AuditAnchorPublisher, type PublisherConfig } from "@/workers/audit-anchor-publisher";
import { FilesystemDestination } from "@/lib/audit/anchor-destinations/filesystem-destination";
import { trackDestination } from "@/__tests__/helpers/anchor-manifest-fixtures";

describe("AuditAnchorPublisher — FR6 fail-closed", () => {
  let ctx: TestContext;
  let pub: PrismaWithPool;
  let snapshot: SettingsSnapshot;
  let c: PublisherCase;
  let tenantEnabled: string;

  function publisher(config: PublisherConfig): AuditAnchorPublisher {
    return new AuditAnchorPublisher({ prisma: pub.prisma, config });
  }

  async function failureReasons(): Promise<Array<string | null>> {
    return (await c.outboxRows()).map((r) => r.failureReason);
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    pub = createPrismaForRole("anchor-publisher");
    snapshot = await snapshotPublisherSettings(ctx.su);
  });

  afterAll(async () => {
    await restorePublisherSettings(ctx.su, snapshot);
    await pub.prisma.$disconnect();
    await pub.pool.end();
    await ctx.cleanup();
  });

  beforeEach(async () => {
    c = await createPublisherCase(ctx);
    tenantEnabled = await c.createTenant({ enabled: true, chainSeq: 3 });
  });

  afterEach(async () => {
    await c.cleanup();
  });

  it("Variant 1: corrupt/truncated signing key → failed before the upload, no pause", async () => {
    const corruptKey = Buffer.from([0x01]); // 1 byte — not a valid 32-byte Ed25519 seed
    const { dest } = await c.filesystem();
    const before = await dest.list();

    const outcome = await publisher(c.config([dest], { signingKey: corruptKey })).runCadence(c.boundary);

    expect(outcome).toMatchObject({ kind: "failed", stage: "before_upload" });
    expect((await anchorState(ctx.su, [tenantEnabled]))[0]?.publish_paused_until).toBeNull();
    expect(await dest.list()).toEqual(before);
    expect((await c.outboxRows()).map((r) => r.action)).toEqual(["AUDIT_ANCHOR_PUBLISH_FAILED"]);
  });

  it("Variant 2: a filesystem primary nothing can be created under → filesystem_UPLOAD_FAILED at the create, paused only to the next boundary", async () => {
    // The base path does not exist, so its listing is empty and the run
    // decides to publish; its parent refuses the mkdir the create needs.
    const parent = await c.tempDir();
    await fs.chmod(parent, 0o555);
    const dest = new FilesystemDestination({ basePath: path.join(parent, "anchors") });
    expect(await dest.list()).toEqual([]);

    const outcome = await publisher(c.config([dest])).runCadence(c.boundary);

    expect(outcome).toMatchObject({ kind: "failed", stage: "upload", reason: "filesystem_UPLOAD_FAILED:EACCES" });

    // The pause is persisted in its own transaction after the publish
    // transaction rolled back, and ends at the next boundary by the wall clock.
    const [anchor] = await anchorState(ctx.su, [tenantEnabled]);
    expect(anchor?.publish_paused_until).toEqual(new Date(c.boundary.getTime() + CADENCE_MS));
    expect(anchor?.last_published_at).toBeNull();

    // The failure row only: the missing-prior row goes out with a publish.
    expect(await failureReasons()).toEqual(["filesystem_UPLOAD_FAILED:EACCES"]);
  });

  it("the run's bound ends a create that never settles under the upload token, within the test budget", async () => {
    const { dest } = await c.filesystem();
    const hanging = trackDestination(dest, { create: () => new Promise<never>(() => {}) });

    const started = Date.now();
    const outcome = await publisher(c.config([hanging.dest], { uploadTimeoutMs: 500 })).runCadence(c.boundary);

    expect(outcome).toMatchObject({ kind: "failed", stage: "upload", reason: "filesystem_UPLOAD_FAILED:UPLOAD_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await anchorState(ctx.su, [tenantEnabled]))[0]?.publish_paused_until).not.toBeNull();
  });

  it("the run's bound ends a listing that never settles under the read token, within the test budget, with no pause", async () => {
    const { dest } = await c.filesystem();
    const hanging = trackDestination(dest, { list: () => new Promise<never>(() => {}) });

    const started = Date.now();
    const outcome = await publisher(c.config([hanging.dest], { uploadTimeoutMs: 500 })).runCadence(c.boundary);

    expect(outcome).toMatchObject({
      kind: "failed",
      stage: "before_upload",
      reason: "filesystem_READ_FAILED:UPLOAD_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect((await anchorState(ctx.su, [tenantEnabled]))[0]?.publish_paused_until).toBeNull();
    expect(await failureReasons()).toEqual(["filesystem_READ_FAILED:UPLOAD_TIMEOUT"]);
  });

  it("the injected transaction bound fails a run whose transaction outlives it, within the test budget", async () => {
    const { dest } = await c.filesystem();
    const slow = trackDestination(dest, {
      create: (args) => new Promise((resolve) => setTimeout(() => resolve(dest.create(args)), 2_000)),
    });

    const started = Date.now();
    const outcome = await publisher(
      c.config([slow.dest], { txTimeoutMs: 1_000, uploadTimeoutMs: 10_000 }),
    ).runCadence(c.boundary);

    expect(outcome.kind).toBe("failed");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((await anchorState(ctx.su, [tenantEnabled]))[0]?.last_published_at).toBeNull();

    // The object was stored before the transaction died: the retry adopts it.
    const retry = await publisher(c.config([dest], { now: wallClockAt(c.boundary) })).runCadence(c.boundary);
    expect(retry).toMatchObject({ kind: "published", adopted: true });
  });
});
