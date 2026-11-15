/**
 * Integration tests for AuditAnchorPublisher, run as the publisher's own role
 * (passwd_anchor_publisher) against the real schema, grants and RLS, with the
 * filesystem destination as the primary.
 *
 * Covers the run protocol: the decision table read from what the primary
 * holds, adoption, the legacy `system_settings` rows that no longer decide,
 * the clamp on `last_published_at`, the persisted attempt cap, the lock
 * (overlap observed in pg_locks; lock_held against a second session), the
 * no-tenant path, the rows a publish emits, mirrors and their backfill, a key
 * rotation — and the publisher's own audit write, by bypass notices.
 *
 * Isolation (see anchor-publisher-fixtures.ts): every case is its own world —
 * its own temp dirs, tenants, signing key, deployment id and span of
 * far-future boundaries, each removed by a teardown registered at creation.
 *
 * MinIO-backed cases (S3 object versions) live in
 * audit-anchor-publisher-s3.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createTestContext,
  createPrismaForRole,
  expectBypassNotices,
  expectBypassRefusal,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";
import {
  CADENCE_MS,
  LEGACY_SETTING,
  SETTING,
  advanceChain,
  anchorState,
  createPublisherCase,
  deleteAnchorRows,
  readSetting,
  restorePublisherSettings,
  seedChainTenant,
  setChainEnabled,
  setChainSeq,
  setLastPublishedAt,
  snapshotPublisherSettings,
  wallClockAt,
  writeSetting,
  type PublisherCase,
  type SettingsSnapshot,
} from "./anchor-publisher-fixtures";
import {
  ADVISORY_LOCK_KEY,
  AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP,
  AuditAnchorPublisher,
  type CadenceOutcome,
  type PublisherConfig,
} from "@/workers/audit-anchor-publisher";
import logger from "@/lib/logger";
import { buildManifestArtifactKey, publicKeyArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import type { AnchorDestination } from "@/lib/audit/anchor-destinations/destination";
import {
  verify as verifyManifest,
  chainLocationFor,
  computeTenantTag,
  publicKeyForSigningKey,
  type Manifest,
} from "@/lib/audit/anchor-manifest";
import { AUDIT_ANCHOR_MIRROR_BACKFILL_MAX } from "@/lib/constants/audit/audit";
import { BYPASS_GRANT, setBypassGucs } from "@/lib/tenant-rls-grants";
import { SYSTEM_TENANT_ID } from "@/lib/constants/app";
import {
  archivePublicKey,
  createCalls,
  kidOf,
  signedManifest,
  storeArtifact,
  storeManifest,
  trackDestination,
} from "@/__tests__/helpers/anchor-manifest-fixtures";

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

const CAP = AUDIT_ANCHOR_UPLOAD_ATTEMPT_CAP;

describe("AuditAnchorPublisher — integration as passwd_anchor_publisher", () => {
  let ctx: TestContext;
  let pub: PrismaWithPool;
  let snapshot: SettingsSnapshot;
  let c: PublisherCase;
  let tenantA: string;
  let tenantB: string;
  let tenantDisabled: string;

  function publisher(config: PublisherConfig, client: PrismaWithPool = pub): AuditAnchorPublisher {
    return new AuditAnchorPublisher({ prisma: client.prisma, config });
  }

  /** Run `boundary` on a fresh publisher whose clock is an hour into it. */
  function runAt(boundary: Date, destinations: AnchorDestination[], overrides: Partial<PublisherConfig> = {}): Promise<CadenceOutcome> {
    return publisher(c.config(destinations, { now: wallClockAt(boundary), ...overrides })).runCadence(boundary);
  }

  async function attemptsRow(): Promise<unknown> {
    const value = await readSetting(ctx.su, SETTING.UPLOAD_ATTEMPTS);
    return value === null ? null : JSON.parse(value);
  }

  async function sortedKeys(dest: AnchorDestination): Promise<string[]> {
    return [...(await dest.list())].sort();
  }

  async function storedManifest(dest: AnchorDestination, key: string, publicKey: Buffer = c.publicKey): Promise<Manifest> {
    const bytes = await dest.read(key);
    if (bytes === null) throw new Error(`no object at ${key}`);
    return verifyManifest(bytes.toString("utf-8"), publicKey);
  }

  /** A manifest the case's identity would have published to `at` for `boundary`. */
  function ours(boundary: Date, at: AnchorDestination, overrides: Partial<Parameters<typeof signedManifest>[0]> = {}) {
    return signedManifest({
      signingKey: c.signingKey,
      boundary,
      deploymentId: c.deploymentId,
      tagSecret: c.tagSecret,
      location: at.location,
      tenants: [tenantA, tenantB].sort().map((tenantId) => ({
        tenantId,
        chainSeq: 5n,
        prevHash: randomBytes(32),
        epoch: 1,
      })),
      ...overrides,
    });
  }

  async function lastPublished(): Promise<Array<Date | null>> {
    return (await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.last_published_at);
  }

  /** What a denied run must leave: the primary as it was, no publish recorded, no mirror create. */
  async function expectDenied(primary: AnchorDestination, before: string[], mirrorCalls: string[] = []): Promise<void> {
    expect(await sortedKeys(primary)).toEqual(before);
    expect(createCalls(mirrorCalls)).toEqual([]);
  }

  function failureReasons(rows: Array<{ failureReason: string | null }>): string[] {
    return rows.flatMap((r) => (r.failureReason === null ? [] : [r.failureReason]));
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
    tenantA = await c.createTenant();
    tenantB = await c.createTenant();
    tenantDisabled = await c.createTenant({ enabled: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await c.cleanup();
  });

  // ─── publish ──────────────────────────────────────────────────────────────

  it("publishes the given boundary covering exactly the chain-enabled tenants, with no bypass outside its grants", async () => {
    const { dest } = await c.filesystem();
    const config = c.config([dest]);

    let outcome: CadenceOutcome | undefined;
    const notices = await expectBypassNotices(async () => {
      outcome = await publisher(config).runCadence(c.boundary);
    });
    // The publish grant names every table the transactions touch, and the
    // audit write's grant (AUDIT_WRITE_DIRECT_OUTBOX) names audit_outbox.
    expect(notices).toEqual([]);

    expect(outcome).toMatchObject({ kind: "published", adopted: false, tenantsCount: 2, chainEnabledTenantCount: 2 });
    if (outcome?.kind !== "published") return;

    expect(await sortedKeys(dest)).toEqual([c.manifestKey(), publicKeyArtifactKey(c.kid)].sort());
    const manifest = await storedManifest(dest, c.manifestKey());
    expect(manifest.anchoredAt).toBe(c.boundary.toISOString());
    expect(manifest.previousManifest).toBeNull();
    const tags = manifest.tenants.map((t) => t.tenantTag).sort();
    expect(tags).toEqual([computeTenantTag(tenantA, c.tagSecret), computeTenantTag(tenantB, c.tagSecret)].sort());

    // Nothing but the attempt count is written to system_settings.
    expect(await readSetting(ctx.su, LEGACY_SETTING.LAST_PUBLISHED_BOUNDARY)).toBeNull();
    expect(await readSetting(ctx.su, LEGACY_SETTING.PREVIOUS_MANIFEST)).toBeNull();

    // The helper's rows, written as this role: the missing-prior report (a
    // far-future boundary has no prior publication), then the success event.
    expect((await c.outboxRows()).map((r) => [r.action, r.failureReason])).toEqual([
      ["AUDIT_ANCHOR_PUBLISH_FAILED", "MISSING_PRIOR_CADENCE_PUBLICATION"],
      ["AUDIT_ANCHOR_PUBLISHED", null],
    ]);
    expect((await c.outboxRows()).at(-1)?.metadata).toEqual({
      manifestSha256: outcome.manifestSha256,
      destinations: ["filesystem"],
      tenantsCount: 2,
      artifactKey: c.manifestKey(),
      anchoredAt: c.boundary.toISOString(),
      adopted: false,
      genesis: true,
    });
  });

  it("lists the manifest's tenants in tenant-id order, whatever order the rows are stored in", async () => {
    // Rewriting the lower id's anchor row moves its tuple behind the other's,
    // so an unordered read returns the higher id first.
    const [lower, higher] = [tenantA, tenantB].sort();
    await seedChainTenant(ctx.su, lower!, { enabled: true, chainSeq: 9 });
    const { dest } = await c.filesystem();

    expect(await runAt(c.boundary, [dest])).toMatchObject({ kind: "published" });

    const manifest = await storedManifest(dest, c.manifestKey());
    expect(manifest.tenants.map((t) => t.tenantTag)).toEqual([
      computeTenantTag(lower!, c.tagSecret),
      computeTenantTag(higher!, c.tagSecret),
    ]);
  });

  it("refuses an outbox write under a grant without auditOutbox, and reports it (control)", async () => {
    // The refused INSERT is the transaction's last statement.
    const { notices, table } = await expectBypassRefusal(() =>
      pub.prisma.$transaction(async (tx) => {
        // No tenant id: the row's SYSTEM_TENANT_ID cannot be admitted by the
        // policy's tenant branch, so only the grant decides.
        await setBypassGucs(tx, BYPASS_GRANT.AUDIT_ANCHOR_PUBLISH);
        await tx.auditOutbox.createMany({
          data: [{
            tenantId: SYSTEM_TENANT_ID,
            payload: { action: "AUDIT_ANCHOR_PUBLISHED", metadata: { anchoredAt: c.boundary.toISOString() } },
          }],
        });
      }),
    );
    expect(table).toBe("audit_outbox");
    expect(notices.map((n) => n.table)).toEqual(["audit_outbox"]);
    // The transaction ended with the refusal; the allow twin is the first cell,
    // whose publish writes the same kind of row.
    expect(await c.outboxRows()).toEqual([]);
  });

  it("two runs for one boundary publish once (row h): the second skips and the primary is unchanged", async () => {
    const { dest } = await c.filesystem();
    const config = c.config([dest]);

    const first = await publisher(config).runCadence(c.boundary);
    const afterFirst = await sortedKeys(dest);
    const bytes = await dest.read(c.manifestKey());
    await advanceChain(ctx.su, tenantA);
    const second = await publisher(config).runCadence(c.boundary);

    expect([first.kind, second.kind]).toEqual(["published", "skipped_already_published"]);
    expect(await sortedKeys(dest)).toEqual(afterFirst);
    expect(await dest.read(c.manifestKey())).toEqual(bytes);
    expect(await attemptsRow()).toEqual({ boundary: c.boundary.toISOString(), count: 1 });
  });

  it("publishes when every tenant is paused, and clears the pauses", async () => {
    const pausedUntil = new Date(Date.now() + CADENCE_MS);
    await seedChainTenant(ctx.su, tenantA, { enabled: true, pausedUntil });
    await seedChainTenant(ctx.su, tenantB, { enabled: true, pausedUntil });
    const { dest } = await c.filesystem();

    const outcome = await runAt(c.boundary, [dest]);

    expect(outcome).toMatchObject({ kind: "published", tenantsCount: 2 });
    const state = await anchorState(ctx.su, [tenantA, tenantB]);
    expect(state.map((s) => s.publish_paused_until)).toEqual([null, null]);
    expect((await c.outboxRows()).map((r) => r.action)).not.toContain("AUDIT_ANCHOR_PUBLISH_PAUSED");
  });

  // ─── the decision table ───────────────────────────────────────────────────

  it("row a: a primary that cannot be listed fails closed, uncounted; the same primary once readable publishes", async () => {
    const { dest } = await c.filesystem();
    const mirror = trackDestination((await c.filesystem()).dest);
    const before = await sortedKeys(dest);
    let failing = true;
    const primary = trackDestination(dest, {
      list: async (signal) => {
        if (failing) throw Object.assign(new Error("denied"), { code: "EACCES" });
        return dest.list(signal);
      },
    });
    const config = c.config([primary.dest, mirror.dest]);

    const outcome = await publisher(config).runCadence(c.boundary);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "filesystem_READ_FAILED:EACCES",
      stage: "before_upload",
      chainEnabledTenantCount: 2,
    });
    await expectDenied(dest, before, mirror.calls);
    expect(await lastPublished()).toEqual([null, null]);
    expect(await attemptsRow()).toBeNull();
    expect(failureReasons(await c.outboxRows())).toEqual(["filesystem_READ_FAILED:EACCES"]);

    failing = false;
    expect(await publisher(config).runCadence(c.boundary)).toMatchObject({ kind: "published" });
  });

  it("row b: a latest object that is not a manifest fails closed and nothing is written", async () => {
    const { dest } = await c.filesystem();
    await storeArtifact(dest, c.manifestKey(), Buffer.from("garbage"));
    const mirror = trackDestination((await c.filesystem()).dest);
    const before = await sortedKeys(dest);
    const next = c.boundaryAt(1);

    const outcome = await runAt(next, [dest, mirror.dest]);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE",
      stage: "before_upload",
      chainEnabledTenantCount: 2,
    });
    await expectDenied(dest, before, mirror.calls);
    expect(await lastPublished()).toEqual([null, null]);
    expect(await attemptsRow()).toBeNull();
  });

  it("row c: an object dated past the wall clock's boundary fails; the clock at its date, an earlier boundary skips as stale (row f)", async () => {
    const { dest } = await c.filesystem();
    const next = c.boundaryAt(1);
    await storeManifest(dest, ours(next, dest));
    const mirror = trackDestination((await c.filesystem()).dest);
    const before = await sortedKeys(dest);

    const ahead = await runAt(c.boundary, [dest, mirror.dest]);
    expect(ahead).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:PUBLISHED_OBJECT_AHEAD",
      stage: "before_upload",
    });
    await expectDenied(dest, before, mirror.calls);
    expect(await lastPublished()).toEqual([null, null]);

    const stale = await runAt(c.boundary, [dest, mirror.dest], { now: wallClockAt(next) });
    expect(stale.kind).toBe("skipped_already_published");
    await expectDenied(dest, before, mirror.calls);
    expect(await attemptsRow()).toBeNull();
  });

  it("row d1: a last_published_at past the wall clock's boundary fails closed, the object for the boundary notwithstanding", async () => {
    const { dest } = await c.filesystem();
    await storeManifest(dest, ours(c.boundary, dest));
    const mirror = trackDestination((await c.filesystem()).dest);
    const before = await sortedKeys(dest);
    const planted = new Date(c.boundaryAt(1).getTime() + 1);
    await setLastPublishedAt(ctx.su, [tenantA], planted);

    const outcome = await runAt(c.boundary, [dest, mirror.dest]);

    expect(outcome).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:LAST_PUBLISHED_AHEAD_OF_CLOCK",
      stage: "before_upload",
    });
    await expectDenied(dest, before, mirror.calls);
    expect((await anchorState(ctx.su, [tenantA]))[0]?.last_published_at).toEqual(planted);
    expect((await anchorState(ctx.su, [tenantB]))[0]?.last_published_at).toBeNull();

    // Allow: the value corrected to the boundary the object is for.
    await setLastPublishedAt(ctx.su, [tenantA], wallClockAtDate(c.boundary));
    expect((await runAt(c.boundary, [dest, mirror.dest])).kind).toBe("skipped_already_published");
  });

  it("row d2: last_published_at at the boundary with no object at the primary fails closed — it is not a skip", async () => {
    const { dest } = await c.filesystem();
    const mirror = trackDestination((await c.filesystem()).dest);
    const before = await sortedKeys(dest);
    await setLastPublishedAt(ctx.su, [tenantA], c.boundary);

    const outcome = await runAt(c.boundary, [dest, mirror.dest]);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "CADENCE_FAILED:DESTINATION_BEHIND_DATABASE",
      stage: "before_upload",
      chainEnabledTenantCount: 2,
    });
    await expectDenied(dest, before, mirror.calls);
    expect(await attemptsRow()).toBeNull();
    expect(failureReasons(await c.outboxRows())).toEqual(["CADENCE_FAILED:DESTINATION_BEHIND_DATABASE"]);
  });

  it("row d2's allow twin: last_published_at on the latest manifest's date publishes the next boundary, chained to it", async () => {
    const { dest } = await c.filesystem();
    const previous = ours(c.boundary, dest);
    await storeManifest(dest, previous);
    await setLastPublishedAt(ctx.su, [tenantA], wallClockAtDate(c.boundary));
    const next = c.boundaryAt(1);

    const outcome = await runAt(next, [dest]);

    expect(outcome).toMatchObject({ kind: "published", adopted: false });
    expect((await storedManifest(dest, c.manifestKey(next))).previousManifest).toEqual({
      uri: `filesystem://${previous.artifactKey}`,
      sha256: previous.sha256,
    });
    // The previous boundary was published: no missing-prior row.
    expect(failureReasons(await c.outboxRows())).toEqual([]);
  });

  it("row d2: an empty new primary fails closed though the secondary holds the manifests", async () => {
    const { dest: populated } = await c.filesystem();
    expect((await runAt(c.boundary, [populated])).kind).toBe("published");
    const { dest: emptyPrimary } = await c.filesystem();
    const before = await sortedKeys(emptyPrimary);
    const next = c.boundaryAt(1);

    const outcome = await runAt(next, [emptyPrimary, populated]);

    expect(outcome).toMatchObject({ kind: "failed", reason: "CADENCE_FAILED:DESTINATION_BEHIND_DATABASE" });
    expect(await sortedKeys(emptyPrimary)).toEqual(before);
    expect(await populated.read(c.manifestKey(next))).toBeNull();
  });

  it("row g: the boundary's object under another identity skips, writes nothing, and reports once per boundary", async () => {
    const { dest } = await c.filesystem();
    const theirs = ours(c.boundary, dest, { deploymentId: "another-deployment" });
    await storeManifest(dest, theirs);
    const mirror = trackDestination((await c.filesystem()).dest);
    const before = await sortedKeys(dest);
    const one = publisher(c.config([dest, mirror.dest]));

    const outcomes = [await one.runCadence(c.boundary), await one.runCadence(c.boundary)];

    expect(outcomes.map((o) => o.kind)).toEqual(["skipped_already_published", "skipped_already_published"]);
    await expectDenied(dest, before, mirror.calls);
    expect(await lastPublished()).toEqual([null, null]);
    expect(await attemptsRow()).toBeNull();
    expect((await c.outboxRows()).map((r) => r.metadata)).toEqual([
      {
        failureReason: "PUBLISHED_BY_OTHER_IDENTITY",
        artifactKey: theirs.artifactKey,
        anchoredAt: c.boundary.toISOString(),
      },
    ]);

    // Allow: the same object under this publisher's identity is adopted (row i).
    const { dest: own } = await c.filesystem();
    const planted = ours(c.boundary, own);
    await storeManifest(own, planted);
    const adopted = await runAt(c.boundary, [own]);
    expect(adopted).toMatchObject({ kind: "published", adopted: true, manifestSha256: planted.sha256 });
    expect(await own.read(planted.artifactKey)).toEqual(planted.bytes);
  });

  // ─── legacy system_settings rows ──────────────────────────────────────────

  it("a legacy boundary marker at the boundary, with no object at the primary, does not skip", async () => {
    // The exact value the old code wrote and read: the boundary's ISO string.
    await writeSetting(ctx.su, LEGACY_SETTING.LAST_PUBLISHED_BOUNDARY, c.boundary.toISOString());
    const { dest } = await c.filesystem();

    const outcome = await runAt(c.boundary, [dest]);

    expect(outcome).toMatchObject({ kind: "published", adopted: false });
    expect(await dest.read(c.manifestKey())).not.toBeNull();
    // Inert: neither read nor rewritten.
    expect(await readSetting(ctx.su, LEGACY_SETTING.LAST_PUBLISHED_BOUNDARY)).toBe(c.boundary.toISOString());
  });

  it("a legacy previous-manifest pointer naming an older manifest does not change what the next manifest chains to", async () => {
    const { dest } = await c.filesystem();
    const first = await runAt(c.boundary, [dest]);
    const second = await runAt(c.boundaryAt(1), [dest]);
    expect([first.kind, second.kind]).toEqual(["published", "published"]);
    if (first.kind !== "published" || second.kind !== "published") return;
    // The exact value the old code wrote and parsed, redirected to the older manifest.
    await writeSetting(
      ctx.su,
      LEGACY_SETTING.PREVIOUS_MANIFEST,
      JSON.stringify({ uri: `filesystem://${c.manifestKey()}`, sha256: first.manifestSha256 }),
    );
    const third = c.boundaryAt(2);

    expect((await runAt(third, [dest])).kind).toBe("published");

    expect((await storedManifest(dest, c.manifestKey(third))).previousManifest).toEqual({
      uri: `filesystem://${c.manifestKey(c.boundaryAt(1))}`,
      sha256: second.manifestSha256,
    });
  });

  // ─── the clamp ────────────────────────────────────────────────────────────

  it("a publish whose clock crosses the next boundary before the database write records its own boundary, and the next boundary publishes", async () => {
    const { dest } = await c.filesystem();
    const next = c.boundaryAt(1);
    let now = wallClockAt(c.boundary)();
    const crossing = await publisher(
      c.config([dest], {
        now: () => now,
        hooks: {
          afterUpload: async () => {
            now = next.getTime() + 60_000;
          },
        },
      }),
    ).runCadence(c.boundary);
    expect(crossing.kind).toBe("published");
    const lastInstant = new Date(next.getTime() - 1);
    expect(await lastPublished()).toEqual([lastInstant, lastInstant]);

    expect(await runAt(next, [dest])).toMatchObject({ kind: "published", adopted: false });
  });

  // ─── no chain-enabled tenant ──────────────────────────────────────────────

  it("with no chain-enabled tenant, more boots in a day than the cap each report skipped_no_tenants and never count", async () => {
    expect(await attemptsRow()).toBeNull();
    await setChainEnabled(ctx.su, tenantA, false);
    await setChainEnabled(ctx.su, tenantB, false);
    const { dest } = await c.filesystem();

    for (let boot = 0; boot < CAP + 1; boot++) {
      vi.resetModules();
      const mod = await import("@/workers/audit-anchor-publisher");
      const fresh = new mod.AuditAnchorPublisher({ prisma: pub.prisma, config: c.config([dest]) });
      const outcome = await fresh.runCadence(c.boundary);
      expect(outcome).toMatchObject({ kind: "skipped_no_tenants", chainEnabledTenantCount: 0 });
    }

    expect(await attemptsRow()).toBeNull();
    expect(failureReasons(await c.outboxRows())).not.toContain("UPLOAD_ATTEMPT_CAP_REACHED");
  });

  it("with no chain-enabled tenant and the anchor rows deleted, a manifest key at the primary keeps the skip unhealthy", async () => {
    const { dest } = await c.filesystem();
    expect((await runAt(c.boundary, [dest])).kind).toBe("published");
    // What a database writer hiding a once-enabled deployment would do.
    await setChainEnabled(ctx.su, tenantA, false);
    await setChainEnabled(ctx.su, tenantB, false);
    await deleteAnchorRows(ctx.su, [tenantA, tenantB, tenantDisabled]);
    // The case shows the manifest key's arm only when no anchor row is left at all.
    const [{ n: anchorRowsLeft }] = await ctx.su.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM audit_chain_anchors`,
    );
    expect(anchorRowsLeft, "anchor rows of other tenants on this database").toBe(0);

    const outcome = await runAt(c.boundaryAt(1), [dest]);

    expect(outcome).toEqual({
      kind: "skipped_no_tenants",
      reason: "NO_CHAIN_ENABLED_TENANTS",
      everChainEnabled: true,
      chainEnabledTenantCount: 0,
    });
  });

  // ─── the attempt cap and the lock ─────────────────────────────────────────

  it("the attempt count persists across boots: lost commits up to the cap create one object, then the cap is reported, then a reset at the next boundary", async () => {
    expect(await attemptsRow()).toBeNull();
    const { dest } = await c.filesystem();
    const storing = trackDestination(dest);
    // Each attempt reaches the commit, then loses it: the first stores the
    // object, the later ones adopt it.
    const failingCommit = { afterUpload: async () => { throw new Error("commit lost"); } };

    for (let boot = 1; boot <= CAP; boot++) {
      vi.resetModules();
      const mod = await import("@/workers/audit-anchor-publisher");
      const fresh = new mod.AuditAnchorPublisher({
        prisma: pub.prisma,
        config: c.config([storing.dest], { hooks: failingCommit }),
      });
      const outcome = await fresh.runCadence(c.boundary);
      expect(outcome).toMatchObject({ kind: "failed", stage: "after_upload" });
      expect(await attemptsRow()).toEqual({ boundary: c.boundary.toISOString(), count: boot });
    }
    expect(createCalls(storing.calls)).toEqual([`create:${c.manifestKey()}`]);

    vi.resetModules();
    const pastCapMod = await import("@/workers/audit-anchor-publisher");
    const pastCap = await new pastCapMod.AuditAnchorPublisher({
      prisma: pub.prisma,
      config: c.config([storing.dest]),
    }).runCadence(c.boundary);
    expect(pastCap).toMatchObject({ kind: "upload_cap_reached", attempts: CAP + 1 });

    vi.resetModules();
    const againMod = await import("@/workers/audit-anchor-publisher");
    const again = await new againMod.AuditAnchorPublisher({
      prisma: pub.prisma,
      config: c.config([storing.dest]),
    }).runCadence(c.boundary);
    expect(again.kind).toBe("upload_cap_reached");
    expect(createCalls(storing.calls)).toHaveLength(1);

    const capRows = (await c.outboxRows()).filter((r) => r.failureReason === "UPLOAD_ATTEMPT_CAP_REACHED");
    expect(capRows).toHaveLength(1);

    // Allow: the next boundary counts from 1 and reaches the create.
    const next = c.boundaryAt(1);
    const allowed = await runAt(next, [storing.dest]);
    expect(allowed.kind).toBe("published");
    expect(createCalls(storing.calls)).toEqual([`create:${c.manifestKey()}`, `create:${c.manifestKey(next)}`]);
    expect(await attemptsRow()).toEqual({ boundary: next.toISOString(), count: 1 });
  });

  it("a tenant set changed after a publish does not unsettle it: restarts skip, and a boot past the cap does not report it", async () => {
    const { dest } = await c.filesystem();
    expect((await runAt(c.boundary, [dest])).kind).toBe("published");
    const before = await sortedKeys(dest);
    // One published tenant disabled, one unpublished tenant enabled.
    await setChainEnabled(ctx.su, tenantB, false);
    const tenantC = await c.createTenant();

    const kinds: string[] = [];
    for (let boot = 0; boot < CAP + 1; boot++) {
      kinds.push((await runAt(c.boundary, [dest])).kind);
    }

    expect(kinds).toEqual(Array(CAP + 1).fill("skipped_already_published"));
    expect(await sortedKeys(dest)).toEqual(before);
    expect(await attemptsRow()).toEqual({ boundary: c.boundary.toISOString(), count: 1 });
    expect((await anchorState(ctx.su, [tenantC]))[0]?.last_published_at).toBeNull();
    expect(failureReasons(await c.outboxRows())).not.toContain("UPLOAD_ATTEMPT_CAP_REACHED");
  });

  it("overlap: a run waits in pg_locks behind one mid-create, then skips the boundary it published without a create of its own", async () => {
    const second = createPrismaForRole("anchor-publisher");
    // Released in `finally` too: a failed assertion must not leave run A
    // holding the lock and its transaction open past the test.
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const runs: Promise<unknown>[] = [];
    try {
      const { dest } = await c.filesystem();
      let pidA: number | null = null;
      let enteredCreate: () => void = () => {};
      const creating = new Promise<void>((resolve) => {
        enteredCreate = resolve;
      });
      const blocking = trackDestination(dest, {
        create: async (args) => {
          const result = await dest.create(args);
          enteredCreate();
          await gate;
          return result;
        },
      });
      const waiting = trackDestination(dest);

      const configA = c.config([blocking.dest], {
        hooks: {
          inTx: async (tx) => {
            const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            pidA = row?.pid ?? null;
          },
        },
      });
      const configB = c.config([waiting.dest], { lockTimeoutMs: 20_000 });

      const runA = publisher(configA).runCadence(c.boundary);
      runs.push(runA);
      await Promise.race([
        creating,
        runA.then((o) => {
          throw new Error("run A ended first: " + JSON.stringify(o));
        }),
      ]);
      expect(pidA).not.toBeNull();
      const runB = publisher(configB, second).runCadence(c.boundary);
      runs.push(runB);

      const deadline = Date.now() + 10_000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const rows = await ctx.su.prisma.$queryRawUnsafe<{ pid: number }[]>(
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted AND $1::int = ANY(pg_blocking_pids(pid))`,
          pidA,
        );
        blocked = rows.length > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);

      releaseA();
      const outcomes = await Promise.all([runA, runB]);
      expect(outcomes.map((o) => o.kind)).toEqual(["published", "skipped_already_published"]);
      // The lock, not create-only, is what kept the second instance out.
      expect(createCalls(waiting.calls)).toEqual([]);
      expect(await sortedKeys(dest)).toEqual([c.manifestKey(), publicKeyArtifactKey(c.kid)].sort());
    } finally {
      releaseA();
      await Promise.allSettled(runs);
      await second.prisma.$disconnect();
      await second.pool.end();
    }
  });

  it("lock_held: a second session holding the lock past lock_timeout yields lock_held, no failure row, no pause", async () => {
    const holder = createPrismaForRole("superuser", { max: 1 });
    try {
      await holder.prisma.$executeRaw`SELECT pg_advisory_lock(hashtext(${ADVISORY_LOCK_KEY}::text))`;
      // Decoys a weaker holder query would also return: the next bigint key
      // (same classid and objsubid, another objid), the two-int4 form over
      // the same two halves (objsubid 2), and the bigint key with the same
      // objid and objsubid but classid 1.
      await holder.prisma.$executeRaw`SELECT pg_advisory_lock(hashtext(${ADVISORY_LOCK_KEY}::text)::bigint + 1)`;
      await holder.prisma.$executeRaw`SELECT pg_advisory_lock(0, hashtext(${ADVISORY_LOCK_KEY}::text))`;
      await holder.prisma.$executeRaw`SELECT pg_advisory_lock((1::bigint << 32) + hashtext(${ADVISORY_LOCK_KEY}::text)::bigint)`;
      try {
        // The holder query docs/operations/alerts.md gives under lock_held,
        // run verbatim, finds this session's publish lock and only it:
        // hashtext is int4, widened to the bigint key, so classid is its high
        // 32 bits and objid its low 32.
        const [{ pid: holderPid }] = await holder.prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        const holders = await ctx.su.prisma.$queryRawUnsafe<{ pid: number }[]>(lockHeldHolderQueryFromAlertsDoc());
        expect(holders.map((h) => h.pid)).toEqual([holderPid]);

        const { dest } = await c.filesystem();
        const outcome = await publisher(c.config([dest], { lockTimeoutMs: 200 })).runCadence(c.boundary);

        expect(outcome).toMatchObject({ kind: "lock_held", reason: "LOCK_HELD_BY_OTHER_INSTANCE" });
        expect(await c.outboxRows()).toEqual([]);
        const state = await anchorState(ctx.su, [tenantA, tenantB]);
        expect(state.map((s) => s.publish_paused_until)).toEqual([null, null]);
        expect(await attemptsRow()).toBeNull();
      } finally {
        await holder.prisma.$executeRaw`SELECT pg_advisory_unlock(hashtext(${ADVISORY_LOCK_KEY}::text))`;
        await holder.prisma.$executeRaw`SELECT pg_advisory_unlock(hashtext(${ADVISORY_LOCK_KEY}::text)::bigint + 1)`;
        await holder.prisma.$executeRaw`SELECT pg_advisory_unlock(0, hashtext(${ADVISORY_LOCK_KEY}::text))`;
        await holder.prisma.$executeRaw`SELECT pg_advisory_unlock((1::bigint << 32) + hashtext(${ADVISORY_LOCK_KEY}::text)::bigint)`;
      }
    } finally {
      await holder.prisma.$disconnect();
      await holder.pool.end();
    }
  });

  // ─── the rows a publish emits ─────────────────────────────────────────────

  /** Publish the case's first boundary and the next one, changing the world in between. */
  async function publishTwice(dest: AnchorDestination, between: () => Promise<void>): Promise<string[]> {
    expect((await runAt(c.boundary, [dest])).kind).toBe("published");
    await between();
    const next = c.boundaryAt(1);
    expect((await runAt(next, [dest])).kind).toBe("published");
    const rows = await publisherRowsFor(next);
    return failureReasons(rows);
  }

  async function publisherRowsFor(boundary: Date) {
    return (await c.outboxRows()).filter((r) => r.metadata.anchoredAt === boundary.toISOString());
  }

  it("an unchanged tenant set over an advancing chain emits no detection row", async () => {
    const { dest } = await c.filesystem();
    expect(await publishTwice(dest, () => advanceChain(ctx.su, tenantA))).toEqual([]);
  });

  it("a tenant disabled between two publishes emits one TENANT_DROPPED_FROM_MANIFEST row", async () => {
    const { dest } = await c.filesystem();

    expect(await publishTwice(dest, () => setChainEnabled(ctx.su, tenantB, false))).toEqual([
      "TENANT_DROPPED_FROM_MANIFEST",
    ]);
    const [row] = (await publisherRowsFor(c.boundaryAt(1))).filter((r) => r.failureReason !== null);
    expect(row?.metadata).toMatchObject({
      count: 1,
      artifactKey: c.manifestKey(c.boundaryAt(1)),
      comparedArtifactKey: c.manifestKey(c.boundaryAt(1)),
    });
  });

  it("a lost commit after a tenant was disabled: the failed run writes the TENANT_DROPPED_FROM_MANIFEST row with its failure row, and the retry that adopts writes it again", async () => {
    const { dest } = await c.filesystem();
    expect((await runAt(c.boundary, [dest])).kind).toBe("published");
    await setChainEnabled(ctx.su, tenantB, false);
    const next = c.boundaryAt(1);
    const storing = trackDestination(dest);

    const lost = await runAt(next, [storing.dest], { hooks: { afterUpload: async () => { throw new Error("commit lost"); } } });
    expect(lost).toMatchObject({ kind: "failed", stage: "after_upload" });
    // The run that stored the manifest reports the drop itself; nothing published.
    const afterLost = await publisherRowsFor(next);
    expect(afterLost.map((r) => r.action)).toEqual(["AUDIT_ANCHOR_PUBLISH_FAILED", "AUDIT_ANCHOR_PUBLISH_FAILED"]);
    expect(failureReasons(afterLost)).toEqual(["COMMIT_FAILED_AFTER_UPLOAD:unknown", "TENANT_DROPPED_FROM_MANIFEST"]);
    const drop = {
      failureReason: "TENANT_DROPPED_FROM_MANIFEST",
      count: 1,
      artifactKey: c.manifestKey(next),
      anchoredAt: next.toISOString(),
      comparedArtifactKey: c.manifestKey(next),
    };
    expect(afterLost[1]?.metadata).toEqual(drop);

    const retry = await runAt(next, [storing.dest]);

    expect(retry).toMatchObject({ kind: "published", adopted: true, tenantsCount: 1 });
    expect(createCalls(storing.calls)).toEqual([`create:${c.manifestKey(next)}`]);
    const rows = await publisherRowsFor(next);
    expect(failureReasons(rows)).toEqual([
      "COMMIT_FAILED_AFTER_UPLOAD:unknown",
      "TENANT_DROPPED_FROM_MANIFEST",
      "TENANT_DROPPED_FROM_MANIFEST",
    ]);
    expect(rows.filter((r) => r.failureReason === "TENANT_DROPPED_FROM_MANIFEST").map((r) => r.metadata)).toEqual([drop, drop]);

    // Allow: the same lost commit and adopt over an unchanged tenant set emits no detection row.
    const third = c.boundaryAt(2);
    await runAt(third, [storing.dest], { hooks: { afterUpload: async () => { throw new Error("commit lost"); } } });
    expect(await runAt(third, [storing.dest])).toMatchObject({ kind: "published", adopted: true });
    expect(failureReasons(await publisherRowsFor(third))).toEqual(["COMMIT_FAILED_AFTER_UPLOAD:unknown"]);
  });

  it("a boundary stored without a disabled tenant and never settled: the next boundary's publish reports the drop once", async () => {
    const { dest } = await c.filesystem();
    expect((await runAt(c.boundary, [dest])).kind).toBe("published");
    const settledAt = await lastPublished();
    await setChainEnabled(ctx.su, tenantB, false);
    const unsettled = c.boundaryAt(1);
    const lost = await runAt(unsettled, [dest], { hooks: { afterUpload: async () => { throw new Error("commit lost"); } } });
    expect(lost).toMatchObject({ kind: "failed", stage: "after_upload" });
    // Stored, and the database still records the first boundary's publish.
    expect(await sortedKeys(dest)).toContain(c.manifestKey(unsettled));
    expect(await lastPublished()).toEqual(settledAt);

    const next = c.boundaryAt(2);
    expect(await runAt(next, [dest])).toMatchObject({ kind: "published", adopted: false, tenantsCount: 1 });

    // The new manifest and the one it chains to both lack the tenant.
    const rows = await publisherRowsFor(next);
    expect(failureReasons(rows)).toEqual(["MISSING_PRIOR_CADENCE_PUBLICATION", "TENANT_DROPPED_FROM_MANIFEST"]);
    expect(rows.find((r) => r.failureReason === "TENANT_DROPPED_FROM_MANIFEST")?.metadata).toMatchObject({
      count: 1,
      artifactKey: c.manifestKey(next),
      comparedArtifactKey: c.manifestKey(unsettled),
    });

    // Allow: the manifest chained to is now settled, so it is not compared again.
    const after = c.boundaryAt(3);
    expect((await runAt(after, [dest])).kind).toBe("published");
    expect(failureReasons(await publisherRowsFor(after))).toEqual([]);
  });

  it("a drop stored by a failed commit stays on record when last_published_at is then moved onto its date: the next boundary publishes and never compares it", async () => {
    const { dest } = await c.filesystem();
    expect((await runAt(c.boundary, [dest])).kind).toBe("published");
    await setChainEnabled(ctx.su, tenantB, false);
    const unsettled = c.boundaryAt(1);
    const lost = await runAt(unsettled, [dest], { hooks: { afterUpload: async () => { throw new Error("commit lost"); } } });
    expect(lost).toMatchObject({ kind: "failed", stage: "after_upload" });

    // A database writer makes the stored manifest count as settled.
    await setLastPublishedAt(ctx.su, [tenantA, tenantB], wallClockAtDate(unsettled));
    const next = c.boundaryAt(2);
    expect(await runAt(next, [dest])).toMatchObject({ kind: "published", adopted: false, tenantsCount: 1 });

    expect(failureReasons(await publisherRowsFor(next))).toEqual([]);
    const recorded = (await publisherRowsFor(unsettled)).filter((r) => r.failureReason === "TENANT_DROPPED_FROM_MANIFEST");
    expect(recorded.map((r) => r.metadata)).toEqual([
      {
        failureReason: "TENANT_DROPPED_FROM_MANIFEST",
        count: 1,
        artifactKey: c.manifestKey(unsettled),
        anchoredAt: unsettled.toISOString(),
        comparedArtifactKey: c.manifestKey(unsettled),
      },
    ]);
  });

  it("a failure before the primary holds the boundary's object writes no comparison row, a tenant disabled notwithstanding", async () => {
    const { dest } = await c.filesystem();
    expect((await runAt(c.boundary, [dest])).kind).toBe("published");
    await setChainEnabled(ctx.su, tenantB, false);
    const next = c.boundaryAt(1);
    const refusing = trackDestination(dest, {
      create: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });

    const outcome = await runAt(next, [refusing.dest]);

    expect(outcome).toMatchObject({ kind: "failed", stage: "upload", reason: "filesystem_UPLOAD_FAILED:EACCES" });
    expect(await dest.read(c.manifestKey(next))).toBeNull();
    expect(failureReasons(await publisherRowsFor(next))).toEqual(["filesystem_UPLOAD_FAILED:EACCES"]);
  });

  // ─── the chain location a manifest is bound to ────────────────────────────

  it("a manifest copied from another directory is refused as the latest; the directory it was published to chains to it", async () => {
    const { dest: origin } = await c.filesystem();
    expect((await runAt(c.boundary, [origin])).kind).toBe("published");
    const published = (await origin.read(c.manifestKey()))!;
    expect(await storedManifest(origin, c.manifestKey())).toMatchObject({
      version: 2,
      chainLocation: chainLocationFor(origin.location),
    });

    // The same authentic bytes, copied into a directory that holds no chain.
    const { dest: copy } = await c.filesystem();
    await storeArtifact(copy, c.manifestKey(), published);
    const mirror = trackDestination((await c.filesystem()).dest);
    const before = await sortedKeys(copy);
    const next = c.boundaryAt(1);

    const refused = await runAt(next, [copy, mirror.dest]);

    expect(refused).toEqual({
      kind: "failed",
      reason: "CADENCE_FAILED:PUBLISHED_OBJECT_FOREIGN_LOCATION",
      stage: "before_upload",
      chainEnabledTenantCount: 2,
    });
    await expectDenied(copy, before, mirror.calls);
    // Uncounted: the count is still the first boundary's publish.
    expect(await attemptsRow()).toEqual({ boundary: c.boundary.toISOString(), count: 1 });
    expect(failureReasons(await publisherRowsFor(next))).toEqual(["CADENCE_FAILED:PUBLISHED_OBJECT_FOREIGN_LOCATION"]);

    // Allow: where it was published.
    expect(await runAt(next, [origin])).toMatchObject({ kind: "published", adopted: false });
    const payload = Buffer.from(published.toString("utf-8").split(".")[1] ?? "", "base64url");
    expect((await storedManifest(origin, c.manifestKey(next))).previousManifest).toEqual({
      uri: `filesystem://${c.manifestKey()}`,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
  });

  it("upgrade in place: an earlier release's version 1 manifest dated on last_published_at is chained to by a version 2 one; with no last_published_at it is refused", async () => {
    const { dest } = await c.filesystem();
    const legacy = ours(c.boundary, dest, { version: 1 });
    await storeManifest(dest, legacy);
    const before = await sortedKeys(dest);
    const next = c.boundaryAt(1);

    // Deny: nothing in the database vouches for it.
    const refused = await runAt(next, [dest]);
    expect(refused).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:LEGACY_MANIFEST_UNSETTLED",
      stage: "before_upload",
    });
    await expectDenied(dest, before);
    expect(await attemptsRow()).toBeNull();

    // Allow: the earlier release recorded its publish.
    await setLastPublishedAt(ctx.su, [tenantA, tenantB], wallClockAtDate(c.boundary));
    expect(await runAt(next, [dest])).toMatchObject({ kind: "published", adopted: false });
    expect(await storedManifest(dest, c.manifestKey(next))).toMatchObject({
      version: 2,
      chainLocation: chainLocationFor(dest.location),
      previousManifest: { uri: `filesystem://${legacy.artifactKey}`, sha256: legacy.sha256 },
    });
  });

  it("a second manifest key on the date of the recorded version 1 manifest is refused; the same manifest alone on its date is chained to", async () => {
    const otherKey = randomBytes(32);
    const next = c.boundaryAt(1);
    await setLastPublishedAt(ctx.su, [tenantA, tenantB], wallClockAtDate(c.boundary));

    // Deny: a version 1 manifest of another chain, copied onto the recorded date.
    const { dest } = await c.filesystem();
    await storeManifest(dest, ours(c.boundary, dest, { version: 1 }));
    await archivePublicKey(dest, publicKeyForSigningKey(otherKey));
    await storeManifest(dest, signedManifest({ signingKey: otherKey, boundary: c.boundary, version: 1 }));
    const before = await sortedKeys(dest);

    const refused = await runAt(next, [dest]);

    expect(refused).toMatchObject({
      kind: "failed",
      reason: "CADENCE_FAILED:LEGACY_MANIFEST_UNSETTLED",
      stage: "before_upload",
    });
    await expectDenied(dest, before);
    expect(await attemptsRow()).toBeNull();

    // Allow: the one key on that date.
    const { dest: alone } = await c.filesystem();
    await storeManifest(alone, ours(c.boundary, alone, { version: 1 }));
    await archivePublicKey(alone, publicKeyForSigningKey(otherKey));
    expect(await runAt(next, [alone])).toMatchObject({ kind: "published", adopted: false });
  });

  it("a manifest naming no predecessor after earlier ones: its recorded day skips and writes nothing, and the publish that chains to it writes the row", async () => {
    const { dest } = await c.filesystem();
    expect((await runAt(c.boundary, [dest])).kind).toBe("published");
    // What an earlier release's publisher stores and records once its pointer row is gone.
    const slippedAt = c.boundaryAt(1);
    const slipped = ours(slippedAt, dest, { version: 1 });
    await storeManifest(dest, slipped);
    await setLastPublishedAt(ctx.su, [tenantA, tenantB], wallClockAtDate(slippedAt));

    expect((await runAt(slippedAt, [dest])).kind).toBe("skipped_already_published");
    expect(await publisherRowsFor(slippedAt)).toEqual([]);

    const next = c.boundaryAt(2);
    expect(await runAt(next, [dest])).toMatchObject({ kind: "published", adopted: false });
    const failures = (await publisherRowsFor(next)).filter((r) => r.failureReason !== null);
    expect(failures.map((r) => r.metadata)).toEqual([
      {
        failureReason: "GENESIS_AFTER_EARLIER_MANIFESTS",
        artifactKey: c.manifestKey(next),
        anchoredAt: next.toISOString(),
        comparedArtifactKey: slipped.artifactKey,
      },
    ]);

    // Allow: the publish after it chains to a manifest that names its predecessor.
    const after = c.boundaryAt(3);
    expect((await runAt(after, [dest])).kind).toBe("published");
    expect(failureReasons(await publisherRowsFor(after))).toEqual([]);
  });

  it("a chain_seq lowered between two publishes emits one CHAIN_SEQ_REGRESSION row; an unchanged one, none", async () => {
    const { dest } = await c.filesystem();
    expect(await publishTwice(dest, () => setChainSeq(ctx.su, tenantA, 4))).toEqual(["CHAIN_SEQ_REGRESSION"]);

    // Equal to the previous manifest's: not a regression.
    const third = c.boundaryAt(2);
    expect((await runAt(third, [dest])).kind).toBe("published");
    expect(failureReasons(await publisherRowsFor(third))).toEqual([]);
  });

  it("a second manifest key on the chained-to date emits one MULTIPLE_MANIFESTS_FOR_DATE row", async () => {
    const { dest } = await c.filesystem();
    const otherKey = randomBytes(32);

    const reasons = await publishTwice(dest, async () => {
      await archivePublicKey(dest, publicKeyForSigningKey(otherKey));
      await storeManifest(dest, signedManifest({ signingKey: otherKey, boundary: c.boundary, location: dest.location }));
    });

    expect(reasons).toEqual(["MULTIPLE_MANIFESTS_FOR_DATE"]);
    const [row] = (await publisherRowsFor(c.boundaryAt(1))).filter((r) => r.failureReason !== null);
    expect(row?.metadata).toMatchObject({ date: c.boundary.toISOString().slice(0, 10), count: 2 });
  });

  it("emits OWN_PUBLIC_KEY_NOT_ARCHIVED with each publish until the own key is archived", async () => {
    const { dest } = await c.filesystem({ archiveOwnKey: false });
    expect((await runAt(c.boundary, [dest])).kind).toBe("published");
    expect(failureReasons(await publisherRowsFor(c.boundary))).toContain("OWN_PUBLIC_KEY_NOT_ARCHIVED");

    const next = c.boundaryAt(1);
    expect((await runAt(next, [dest])).kind).toBe("published");
    expect(failureReasons(await publisherRowsFor(next))).toEqual(["OWN_PUBLIC_KEY_NOT_ARCHIVED"]);

    const third = c.boundaryAt(2);
    await archivePublicKey(dest, c.publicKey);
    expect((await runAt(third, [dest])).kind).toBe("published");
    expect(failureReasons(await publisherRowsFor(third))).toEqual([]);
  });

  it("counts an archived file holding another key's content as not archived", async () => {
    const { dest } = await c.filesystem({ archiveOwnKey: false });
    await storeArtifact(
      dest,
      publicKeyArtifactKey(c.kid),
      Buffer.from(`${publicKeyForSigningKey(randomBytes(32)).toString("hex")}\n`),
    );

    expect((await runAt(c.boundary, [dest])).kind).toBe("published");

    expect(failureReasons(await publisherRowsFor(c.boundary))).toContain("OWN_PUBLIC_KEY_NOT_ARCHIVED");
  });

  // ─── mirrors ──────────────────────────────────────────────────────────────

  it("a secondary holding other bytes for the key fails as diverged and records no publish; holding the same bytes, the retry publishes", async () => {
    const { dest: primary } = await c.filesystem();
    const { dest: diverged } = await c.filesystem();
    await storeArtifact(diverged, c.manifestKey(), ours(c.boundary, primary).bytes);
    const before = await sortedKeys(diverged);

    const outcome = await runAt(c.boundary, [primary, diverged]);

    expect(outcome).toEqual({
      kind: "failed",
      reason: "filesystem_MIRROR_DIVERGED",
      stage: "upload",
      chainEnabledTenantCount: 2,
    });
    expect(await sortedKeys(diverged)).toEqual(before);
    expect(await lastPublished()).toEqual([null, null]);
    const paused = await anchorState(ctx.su, [tenantA, tenantB]);
    expect(paused.every((s) => s.publish_paused_until !== null)).toBe(true);

    // Allow: a secondary that holds what the primary holds.
    const { dest: same } = await c.filesystem();
    await storeArtifact(same, c.manifestKey(), (await primary.read(c.manifestKey()))!);
    const retry = await runAt(c.boundary, [primary, same]);
    expect(retry).toMatchObject({ kind: "published", adopted: true });
    expect((await anchorState(ctx.su, [tenantA, tenantB])).map((s) => s.publish_paused_until)).toEqual([null, null]);
  });

  it("a secondary down for three boundaries is filled by the backfill once it is back", async () => {
    const { dest: primary } = await c.filesystem();
    const { dest: store } = await c.filesystem();
    let down = true;
    const secondary = trackDestination(store, {
      create: async (args) => {
        if (down) throw Object.assign(new Error("unreachable"), { code: "ECONNREFUSED" });
        return store.create(args);
      },
    });

    for (const days of [0, 1, 2]) {
      const failed = await runAt(c.boundaryAt(days), [primary, secondary.dest]);
      expect(failed).toMatchObject({ kind: "failed", stage: "upload", reason: "filesystem_UPLOAD_FAILED:ECONNREFUSED" });
    }
    expect(await sortedKeys(store)).toEqual([publicKeyArtifactKey(c.kid)]);

    down = false;
    const back = await runAt(c.boundaryAt(3), [primary, secondary.dest]);

    expect(back.kind).toBe("published");
    const manifestKeys = [0, 1, 2, 3].map((days) => c.manifestKey(c.boundaryAt(days)));
    expect(await sortedKeys(store)).toEqual([...manifestKeys, publicKeyArtifactKey(c.kid)].sort());
    for (const key of manifestKeys) expect(await store.read(key)).toEqual(await primary.read(key));
  });

  it("backfill: a gap of eight is filled seven newest first, the eighth on the next run", async () => {
    const gap = AUDIT_ANCHOR_MIRROR_BACKFILL_MAX + 1;
    const { dest: primary } = await c.filesystem();
    for (let days = 0; days < gap; days++) {
      expect((await runAt(c.boundaryAt(days), [primary])).kind).toBe("published");
    }
    const gapKeys = Array.from({ length: gap }, (_, days) => c.manifestKey(c.boundaryAt(days)));
    const { dest: secondary } = await c.filesystem({ archiveOwnKey: false });

    expect((await runAt(c.boundaryAt(gap), [primary, secondary])).kind).toBe("published");
    // The boundary's own object and the seven newest of the gap: the oldest is left.
    expect(await sortedKeys(secondary)).toEqual([...gapKeys.slice(1), c.manifestKey(c.boundaryAt(gap))].sort());

    expect((await runAt(c.boundaryAt(gap + 1), [primary, secondary])).kind).toBe("published");
    expect(await sortedKeys(secondary)).toEqual(
      [...gapKeys, c.manifestKey(c.boundaryAt(gap)), c.manifestKey(c.boundaryAt(gap + 1))].sort(),
    );
    for (const key of gapKeys) expect(await secondary.read(key)).toEqual(await primary.read(key));
  });

  it("backfill: a secondary that throws during it leaves the run published and logs mirror_backfill_failed; the next run completes it", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { dest: primary } = await c.filesystem();
    for (const days of [0, 1]) expect((await runAt(c.boundaryAt(days), [primary])).kind).toBe("published");
    const { dest: store } = await c.filesystem({ archiveOwnKey: false });
    const current = c.manifestKey(c.boundaryAt(2));
    let failBackfill = true;
    const secondary = trackDestination(store, {
      create: async (args) => {
        if (failBackfill && args.artifactKey !== current) throw Object.assign(new Error("full"), { code: "ENOSPC" });
        return store.create(args);
      },
    });

    const outcome = await runAt(c.boundaryAt(2), [primary, secondary.dest]);

    expect(outcome).toMatchObject({ kind: "published", adopted: false });
    expect(await sortedKeys(store)).toEqual([current]);
    expect(
      warn.mock.calls.map(([fields]) => fields).filter((f) => (f as { _logType?: string })._logType?.endsWith("mirror_backfill_failed")),
    ).toEqual([
      {
        destination: "filesystem",
        error: { name: "Error", code: "ENOSPC" },
        _logType: "audit-anchor-publisher.mirror_backfill_failed",
      },
    ]);

    failBackfill = false;
    expect((await runAt(c.boundaryAt(3), [primary, secondary.dest])).kind).toBe("published");
    expect(await sortedKeys(store)).toEqual([0, 1, 2, 3].map((days) => c.manifestKey(c.boundaryAt(days))).sort());
  });

  // ─── key rotation ─────────────────────────────────────────────────────────

  it("rotation: the old key not archived fails closed (row b); archived, the same instance chains to the old-kid manifest and reports the rotation once; the old key afterwards fails (row e)", async () => {
    // The old public key was never archived.
    const { dest } = await c.filesystem({ archiveOwnKey: false });
    const first = await runAt(c.boundary, [dest]);
    expect(first.kind).toBe("published");
    if (first.kind !== "published") return;

    // The operator switches the signing key and archives the new public key only.
    const newKey = randomBytes(32);
    const newPublicKey = publicKeyForSigningKey(newKey);
    await archivePublicKey(dest, newPublicKey);
    const next = c.boundaryAt(1);
    const rotated = publisher(c.config([dest], { signingKey: newKey, now: wallClockAt(next) }));
    const before = await sortedKeys(dest);

    const refused = await rotated.runCadence(next);
    expect(refused).toMatchObject({ kind: "failed", reason: "CADENCE_FAILED:PUBLISHED_OBJECT_UNVERIFIABLE" });
    expect(await sortedKeys(dest)).toEqual(before);

    // Archived as the operator's script does: a create at public-keys/<kid>.pub.
    expect(
      await dest.create({
        artifactKey: publicKeyArtifactKey(c.kid),
        artifactBytes: Buffer.from(`${c.publicKey.toString("hex")}\n`),
        contentType: "text/plain",
      }),
    ).toBe("created");

    // The same instance: the miss was not cached.
    const published = await rotated.runCadence(next);
    expect(published).toMatchObject({ kind: "published", adopted: false });
    const newManifestKey = buildManifestArtifactKey(next, kidOf(newKey));
    expect((await storedManifest(dest, newManifestKey, newPublicKey)).previousManifest).toEqual({
      uri: `filesystem://${c.manifestKey()}`,
      sha256: first.manifestSha256,
    });
    const rotations = (await c.outboxRows()).filter((r) => r.action === "AUDIT_ANCHOR_KEY_ROTATED");
    expect(rotations.map((r) => r.metadata)).toEqual([
      { oldKid: c.kid, newKid: kidOf(newKey), anchoredAt: next.toISOString(), artifactKey: newManifestKey },
    ]);

    // Reverting to the retired key: the latest is under the new kid, and the
    // old kid has published before.
    const third = c.boundaryAt(2);
    const afterRotation = await sortedKeys(dest);
    const reverted = await runAt(third, [dest]);
    expect(reverted).toMatchObject({ kind: "failed", reason: "CADENCE_FAILED:LATEST_UNDER_RETIRED_KEY" });
    expect(await sortedKeys(dest)).toEqual(afterRotation);
    expect(await dest.read(c.manifestKey(third))).toBeNull();
  });
});

/** An instant an hour into `boundary`, as a publish for it would have written. */
function wallClockAtDate(boundary: Date): Date {
  return new Date(wallClockAt(boundary)());
}
