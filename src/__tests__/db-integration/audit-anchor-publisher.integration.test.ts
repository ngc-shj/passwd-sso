/**
 * Integration tests for AuditAnchorPublisher, run as the publisher's own role
 * (passwd_anchor_publisher) against the real schema, grants and RLS.
 *
 * Covers the cadence contract (C2): the explicit boundary, the idempotency
 * marker and its absent-marker derivation, the persisted attempt cap, the
 * lock (overlap observed in pg_locks; lock_held against a second session),
 * every tenant published whatever its pause, the no-tenant path — and the
 * publisher's own audit write (C1), by bypass notices.
 *
 * Isolation (see anchor-publisher-fixtures.ts): the file refuses to run beside
 * chain-enabled tenants it did not create; the four publisher settings rows
 * are snapshotted and restored; every case starts with none of them and the
 * attempt count is deleted after it; boundaries are far-future and unique to
 * the run, which keeps every audit row and artifact this file writes its own.
 *
 * MinIO-backed cases (S3 object versions) live in
 * audit-anchor-publisher-s3.integration.test.ts. The FR7 / FR8 /
 * DESTINATION_DIVERGENCE stubs at the bottom are TODO markers for later work.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createPrivateKey } from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createTestContext,
  createPrismaForRole,
  expectBypassNotices,
  setBypassRlsGucs,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";
import {
  CADENCE_MS,
  SETTING,
  anchorState,
  assertOnlyChainEnabledTenants,
  clearPublisherSettings,
  farFutureBoundary,
  makePublisherConfig,
  wallClockAt,
  publisherOutboxRows,
  purgePublisherOutboxRows,
  readSetting,
  restorePublisherSettings,
  seedChainTenant,
  snapshotPublisherSettings,
  type SettingsSnapshot,
} from "./anchor-publisher-fixtures";
import {
  ADVISORY_LOCK_KEY,
  AuditAnchorPublisher,
  buildManifestArtifactKey,
  type PublisherConfig,
} from "@/workers/audit-anchor-publisher";
import { FilesystemDestination } from "@/lib/audit/anchor-destinations/filesystem-destination";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import {
  verify as verifyManifest,
  computeTenantTag,
  derivePublicKey as derivePublicKeyObject,
} from "@/lib/audit/anchor-manifest";
import { BYPASS_GRANT, setBypassGucs } from "@/lib/tenant-rls-grants";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX_LEN = 12;

function derivePublicKey(seed: Buffer): Buffer {
  const privKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const rawDer = derivePublicKeyObject(privKey).export({ type: "spki", format: "der" }) as Buffer;
  return rawDer.subarray(ED25519_SPKI_PREFIX_LEN);
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * The one fenced `sql` block under the `audit-anchor-publisher.lock_held`
 * heading of docs/operations/alerts.md — the holder query an operator runs.
 * Throws when the section or its block is missing, or when it has more than
 * one, so the test cannot run a query the page no longer shows.
 */
function lockHeldHolderQueryFromAlertsDoc(): string {
  const doc = readFileSync(path.join(REPO_ROOT, "docs", "operations", "alerts.md"), "utf8");
  const heading = "## `audit-anchor-publisher.lock_held`\n";
  const start = doc.indexOf(heading);
  if (start === -1 || doc.indexOf(heading, start + 1) !== -1) {
    throw new Error("alerts.md: expected exactly one lock_held section");
  }
  const rest = doc.slice(start + heading.length);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const blocks = [...section.matchAll(/^```sql\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
  if (blocks.length !== 1) throw new Error(`alerts.md: lock_held section has ${blocks.length} sql blocks, expected 1`);
  return blocks[0];
}

describe("AuditAnchorPublisher — integration as passwd_anchor_publisher", () => {
  let ctx: TestContext;
  let pub: PrismaWithPool;
  let snapshot: SettingsSnapshot;
  let tmpDir: string;
  let tenantA: string;
  let tenantB: string;
  let tenantDisabled: string;
  let base: Date;
  let caseIndex = 0;
  const usedBoundaries: Date[] = [];

  /** A fresh far-future boundary for this case (and recorded for cleanup). */
  function nextBoundary(): Date {
    const b = new Date(base.getTime() + caseIndex++ * 10 * CADENCE_MS);
    usedBoundaries.push(b, new Date(b.getTime() + CADENCE_MS));
    return b;
  }

  function publisher(config: PublisherConfig, client: PrismaWithPool = pub): AuditAnchorPublisher {
    return new AuditAnchorPublisher({ prisma: client.prisma, config });
  }

  function fsDestination(): FilesystemDestination {
    return new FilesystemDestination({ basePath: tmpDir });
  }

  async function attemptsRow(): Promise<unknown> {
    const value = await readSetting(ctx.su, SETTING.UPLOAD_ATTEMPTS);
    return value === null ? null : JSON.parse(value);
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    await assertOnlyChainEnabledTenants(ctx.su, []);
    pub = createPrismaForRole("anchor-publisher");
    snapshot = await snapshotPublisherSettings(ctx.su);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-publisher-test-"));
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
    tenantA = await ctx.createTenant();
    tenantB = await ctx.createTenant();
    tenantDisabled = await ctx.createTenant();
    await seedChainTenant(ctx.su, tenantA, { enabled: true });
    await seedChainTenant(ctx.su, tenantB, { enabled: true });
    await seedChainTenant(ctx.su, tenantDisabled, { enabled: false });
    await assertOnlyChainEnabledTenants(ctx.su, [tenantA, tenantB]);
    await clearPublisherSettings(ctx.su);
  });

  afterEach(async () => {
    await clearPublisherSettings(ctx.su, [SETTING.UPLOAD_ATTEMPTS]);
    await clearPublisherSettings(ctx.su);
    await purgePublisherOutboxRows(ctx.su, usedBoundaries);
    await ctx.deleteTestData(tenantA);
    await ctx.deleteTestData(tenantB);
    await ctx.deleteTestData(tenantDisabled);
    for (const f of await fs.readdir(tmpDir).catch(() => [])) {
      await fs.unlink(path.join(tmpDir, f)).catch(() => undefined);
    }
  });

  it("publishes the given boundary covering exactly the chain-enabled tenants, with no bypass outside its grants", async () => {
    const boundary = nextBoundary();
    const config = makePublisherConfig([fsDestination()]);

    let outcome: Awaited<ReturnType<AuditAnchorPublisher["runCadence"]>> | undefined;
    const notices = await expectBypassNotices(async () => {
      outcome = await publisher(config).runCadence(boundary);
    });
    // The publish grant names every table the transaction touches, and the
    // audit write's grant (AUDIT_WRITE_DIRECT_OUTBOX) names audit_outbox.
    expect(notices).toEqual([]);

    expect(outcome).toMatchObject({ kind: "published", tenantsCount: 2, chainEnabledTenantCount: 2 });
    if (outcome?.kind !== "published") return;

    expect(await readSetting(ctx.su, SETTING.LAST_PUBLISHED_BOUNDARY)).toBe(boundary.toISOString());
    const pointer = JSON.parse((await readSetting(ctx.su, SETTING.PREVIOUS_MANIFEST)) ?? "null") as {
      sha256: string;
    };
    expect(pointer.sha256).toBe(outcome.manifestSha256);

    const key = buildManifestArtifactKey(boundary, config.signingKeyKid);
    const jws = await fs.readFile(path.join(tmpDir, key), "utf-8");
    const manifest = verifyManifest(jws.trim(), derivePublicKey(config.signingKey));
    expect(manifest.anchoredAt).toBe(boundary.toISOString());
    const tags = manifest.tenants.map((t) => t.tenantTag).sort();
    expect(tags).toEqual(
      [computeTenantTag(tenantA, config.tagSecret), computeTenantTag(tenantB, config.tagSecret)].sort(),
    );

    // The helper's row, written as this role: the success event and the
    // missing-prior report (a far-future boundary has no prior publication).
    const rows = await publisherOutboxRows(ctx.su, [boundary]);
    expect(rows).toEqual(
      expect.arrayContaining([
        { action: "AUDIT_ANCHOR_PUBLISHED", failureReason: null },
        { action: "AUDIT_ANCHOR_PUBLISH_FAILED", failureReason: "MISSING_PRIOR_CADENCE_PUBLICATION" },
      ]),
    );
  });

  it("lists the manifest's tenants in tenant-id order, whatever order the rows are stored in", async () => {
    // Rewriting the lower id's anchor row moves its tuple behind the other's,
    // so an unordered read returns the higher id first.
    const [lower, higher] = [tenantA, tenantB].sort();
    await seedChainTenant(ctx.su, lower!, { enabled: true, chainSeq: 9 });
    const boundary = nextBoundary();
    const config = makePublisherConfig([fsDestination()]);

    expect(await publisher(config).runCadence(boundary)).toMatchObject({ kind: "published" });

    const jws = await fs.readFile(path.join(tmpDir, buildManifestArtifactKey(boundary, config.signingKeyKid)), "utf-8");
    const manifest = verifyManifest(jws.trim(), derivePublicKey(config.signingKey));
    expect(manifest.tenants.map((t) => t.tenantTag)).toEqual([
      computeTenantTag(lower!, config.tagSecret),
      computeTenantTag(higher!, config.tagSecret),
    ]);
  });

  it("the bypass-notice measurement sees an outbox write under a grant without auditOutbox (control)", async () => {
    const boundary = nextBoundary();
    const notices = await expectBypassNotices(() =>
      pub.prisma.$transaction(async (tx) => {
        // No tenant id: the row's SYSTEM_TENANT_ID cannot be admitted by the
        // policy's tenant branch, so only the grant decides.
        await setBypassGucs(tx, BYPASS_GRANT.AUDIT_ANCHOR_PUBLISH);
        await tx.auditOutbox.createMany({
          data: [{
            tenantId: SYSTEM_TENANT_ID,
            payload: { action: "AUDIT_ANCHOR_PUBLISHED", metadata: { anchoredAt: boundary.toISOString() } },
          }],
        });
      }),
    );
    expect(notices.map((n) => n.table)).toEqual(["audit_outbox"]);
  });

  it("two runs for one boundary publish once", async () => {
    const boundary = nextBoundary();
    const config = makePublisherConfig([fsDestination()], { now: wallClockAt(boundary) });

    const first = await publisher(config).runCadence(boundary);
    const second = await publisher(config).runCadence(boundary);

    expect([first.kind, second.kind]).toEqual(["published", "skipped_already_published"]);
    expect(await fs.readdir(tmpDir)).toHaveLength(1);
  });

  it("an absent marker is derived from last_published_at at or after the boundary", async () => {
    const boundary = nextBoundary();
    await seedChainTenant(ctx.su, tenantA, { enabled: true, lastPublishedAt: boundary });

    const outcome = await publisher(makePublisherConfig([fsDestination()])).runCadence(boundary);

    expect(outcome.kind).toBe("skipped_already_published");
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it("an absent marker with last_published_at below the boundary publishes", async () => {
    const boundary = nextBoundary();
    await seedChainTenant(ctx.su, tenantA, { enabled: true, lastPublishedAt: new Date(boundary.getTime() - 1) });

    const outcome = await publisher(makePublisherConfig([fsDestination()])).runCadence(boundary);

    expect(outcome.kind).toBe("published");
  });

  it("publishes when every tenant is paused, and clears the pauses", async () => {
    const boundary = nextBoundary();
    const pausedUntil = new Date(Date.now() + CADENCE_MS);
    await seedChainTenant(ctx.su, tenantA, { enabled: true, pausedUntil });
    await seedChainTenant(ctx.su, tenantB, { enabled: true, pausedUntil });

    const outcome = await publisher(makePublisherConfig([fsDestination()])).runCadence(boundary);

    expect(outcome).toMatchObject({ kind: "published", tenantsCount: 2 });
    const state = await anchorState(ctx.su, [tenantA, tenantB]);
    expect(state.map((s) => s.publish_paused_until)).toEqual([null, null]);
    const rows = await publisherOutboxRows(ctx.su, [boundary]);
    expect(rows.map((r) => r.action)).not.toContain("AUDIT_ANCHOR_PUBLISH_PAUSED");
  });

  it("with no chain-enabled tenant, four boots in a day each report skipped_no_tenants and never count", async () => {
    expect(await attemptsRow()).toBeNull();
    await seedChainTenant(ctx.su, tenantA, { enabled: false });
    await seedChainTenant(ctx.su, tenantB, { enabled: false });
    const boundary = nextBoundary();

    for (let boot = 0; boot < 4; boot++) {
      vi.resetModules();
      const mod = await import("@/workers/audit-anchor-publisher");
      const fresh = new mod.AuditAnchorPublisher({ prisma: pub.prisma, config: makePublisherConfig([fsDestination()]) });
      const outcome = await fresh.runCadence(boundary);
      expect(outcome).toMatchObject({ kind: "skipped_no_tenants", chainEnabledTenantCount: 0 });
    }

    expect(await attemptsRow()).toBeNull();
    const rows = await publisherOutboxRows(ctx.su, [boundary]);
    expect(rows.map((r) => r.failureReason)).not.toContain("UPLOAD_ATTEMPT_CAP_REACHED");
  });

  it("the attempt count persists across boots: three failed attempts, then the cap, then a reset at the next boundary", async () => {
    expect(await attemptsRow()).toBeNull();
    const boundary = nextBoundary();
    const config = makePublisherConfig([]);
    const uploads: string[] = [];
    const storing: AnchorDestination = {
      name: "filesystem",
      upload: async (args) => {
        uploads.push(args.artifactKey);
        await fsDestination().upload(args);
      },
    };
    // Each attempt stores the object, then loses its commit.
    const failingCommit = { afterUpload: async () => { throw new Error("commit lost"); } };

    for (let boot = 1; boot <= 3; boot++) {
      vi.resetModules();
      const mod = await import("@/workers/audit-anchor-publisher");
      const fresh = new mod.AuditAnchorPublisher({
        prisma: pub.prisma,
        config: { ...config, destinations: [storing], hooks: failingCommit },
      });
      const outcome = await fresh.runCadence(boundary);
      expect(outcome).toMatchObject({ kind: "failed", stage: "after_upload" });
      expect(await attemptsRow()).toEqual({ boundary: boundary.toISOString(), count: boot });
    }
    expect(uploads).toHaveLength(3);

    vi.resetModules();
    const fourthMod = await import("@/workers/audit-anchor-publisher");
    const fourth = await new fourthMod.AuditAnchorPublisher({
      prisma: pub.prisma,
      config: { ...config, destinations: [storing] },
    }).runCadence(boundary);
    expect(fourth).toMatchObject({ kind: "upload_cap_reached", attempts: 4 });
    expect(uploads).toHaveLength(3);

    vi.resetModules();
    const fifthMod = await import("@/workers/audit-anchor-publisher");
    const fifth = await new fifthMod.AuditAnchorPublisher({
      prisma: pub.prisma,
      config: { ...config, destinations: [storing] },
    }).runCadence(boundary);
    expect(fifth.kind).toBe("upload_cap_reached");

    const capRows = (await publisherOutboxRows(ctx.su, [boundary])).filter(
      (r) => r.failureReason === "UPLOAD_ATTEMPT_CAP_REACHED",
    );
    expect(capRows).toHaveLength(1);

    // Allow: the next boundary counts from 1 and reaches the upload.
    const next = new Date(boundary.getTime() + CADENCE_MS);
    const allowed = await publisher({ ...config, destinations: [storing] }).runCadence(next);
    expect(allowed.kind).toBe("published");
    expect(uploads).toHaveLength(4);
    expect(await attemptsRow()).toEqual({ boundary: next.toISOString(), count: 1 });
  });

  it("overlap: a run waits in pg_locks behind one mid-upload, then skips the boundary it published", async () => {
    const boundary = nextBoundary();
    const second = createPrismaForRole("anchor-publisher");
    // Released in `finally` too: a failed assertion must not leave run A
    // holding the lock and its transaction open past the test.
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const runs: Promise<unknown>[] = [];
    try {
      let pidA: number | null = null;
      let enteredUpload: () => void = () => {};
      const uploading = new Promise<void>((resolve) => {
        enteredUpload = resolve;
      });
      const blocking: AnchorDestination = {
        name: "filesystem",
        upload: async (args) => {
          await fsDestination().upload(args);
          enteredUpload();
          await gate;
        },
      };

      const configA = makePublisherConfig([blocking], {
        now: wallClockAt(boundary),
        hooks: {
          inTx: async (tx) => {
            const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            pidA = row?.pid ?? null;
          },
        },
      });
      const configB = makePublisherConfig([fsDestination()], { lockTimeoutMs: 20_000, now: wallClockAt(boundary) });

      const runA = publisher(configA).runCadence(boundary);
      runs.push(runA);
      await uploading;
      expect(pidA).not.toBeNull();
      const runB = publisher(configB, second).runCadence(boundary);
      runs.push(runB);

      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const rows = await ctx.su.prisma.$queryRawUnsafe<{ pid: number }[]>(
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND $1::int = ANY(pg_blocking_pids(pid))`,
          pidA,
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);

      releaseA();
      const outcomes = await Promise.all([runA, runB]);
      expect(outcomes.map((o) => o.kind)).toEqual(["published", "skipped_already_published"]);
    } finally {
      releaseA();
      await Promise.allSettled(runs);
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });

  it("lock_held: a second session holding the lock past lock_timeout yields lock_held, no failure row, no pause", async () => {
    const boundary = nextBoundary();
    const holder = createPrismaForRole("superuser", { max: 1 });
    try {
      await holder.prisma.$executeRaw`SELECT pg_advisory_lock(hashtext(${ADVISORY_LOCK_KEY}::text))`;
      // Decoys a weaker holder query would also return: the next bigint key
      // (same classid and objsubid, another objid), and the two-int4 form over
      // the same two halves (objsubid 2).
      await holder.prisma.$executeRaw`SELECT pg_advisory_lock(hashtext(${ADVISORY_LOCK_KEY}::text)::bigint + 1)`;
      await holder.prisma.$executeRaw`SELECT pg_advisory_lock(0, hashtext(${ADVISORY_LOCK_KEY}::text))`;
      try {
        // The holder query docs/operations/alerts.md gives under lock_held,
        // run verbatim, finds this session's publish lock and only it:
        // hashtext is int4, widened to the bigint key, so classid is its high
        // 32 bits and objid its low 32.
        const [{ pid: holderPid }] = await holder.prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const holders = await ctx.su.prisma.$queryRawUnsafe<{ pid: number }[]>(lockHeldHolderQueryFromAlertsDoc());
        expect(holders.map((h) => h.pid)).toEqual([holderPid]);

        const outcome = await publisher(makePublisherConfig([fsDestination()], { lockTimeoutMs: 200 })).runCadence(boundary);

        expect(outcome).toMatchObject({ kind: "lock_held", reason: "LOCK_HELD_BY_OTHER_INSTANCE" });
        expect(await publisherOutboxRows(ctx.su, [boundary])).toEqual([]);
        const state = await anchorState(ctx.su, [tenantA, tenantB]);
        expect(state.map((s) => s.publish_paused_until)).toEqual([null, null]);
        expect(await attemptsRow()).toBeNull();
      } finally {
        await holder.prisma.$executeRaw`SELECT pg_advisory_unlock(hashtext(${ADVISORY_LOCK_KEY}::text))`;
        await holder.prisma.$executeRaw`SELECT pg_advisory_unlock(hashtext(${ADVISORY_LOCK_KEY}::text)::bigint + 1)`;
        await holder.prisma.$executeRaw`SELECT pg_advisory_unlock(0, hashtext(${ADVISORY_LOCK_KEY}::text))`;
      }
    } finally {
      await holder.prisma.$disconnect();
      await holder.pool.end();
    }
  });

  it("the role writes the marker through Prisma upsert on a second publish (UPDATE path)", async () => {
    const boundary = nextBoundary();
    const config = makePublisherConfig([fsDestination()], { now: wallClockAt(boundary) });
    await publisher(config).runCadence(boundary);
    const next = new Date(boundary.getTime() + CADENCE_MS);
    const outcome = await publisher(config).runCadence(next);

    expect(outcome.kind).toBe("published");
    expect(await readSetting(ctx.su, SETTING.LAST_PUBLISHED_BOUNDARY)).toBe(next.toISOString());
    // The superuser reads what the role wrote, under the test setup grant.
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM system_settings WHERE key = $1`,
        SETTING.LAST_PUBLISHED_BOUNDARY,
      );
    });
    expect(rows[0]?.n).toBe(1);
  });

  // FR7 stub — key rotation overlap test
  // TODO: implement FR7 (key rotation): generate new key, publish overlap manifest under both
  //       keys, retire old key. Requires multi-cadence test fixtures.
  it.todo("FR7: key rotation overlap — manifest published under both old and new key");

  // FR8 stub — regression detection test
  // TODO: implement FR8 (regression detection): verify that lower chain_seq in subsequent
  //       publication is detected as a tamper signal by the verifier.
  it.todo("FR8: chain_seq regression detection — lower seq in later manifest is a tamper signal");

  // DESTINATION_DIVERGENCE stub — the follow-up audit-anchor-github-release-destination
  // .integration.test.ts points at.
  // TODO: upload manifest A to one destination and a tampered B to another, run the verifier's
  //       cross-destination check, and assert it reports DESTINATION_DIVERGENCE.
  it.todo("DESTINATION_DIVERGENCE: the verifier detects destinations holding different bytes for one key");
});
