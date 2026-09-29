/**
 * passkey-signin-client-token-cascade (C3) — real-DB integration tests for
 * `enforceActiveFamilyCap`: the per-user active-device-family cap, counting
 * BROWSER_EXTENSION + IOS_APP families and excluding IOS_AUTOFILL.
 *
 * Unlike its siblings `client-token-presence` and `extension-token-dpop-flow`,
 * this file does NOT mock `@/lib/audit/audit` — the concurrency case (e) needs
 * the real `logAuditAsync` → `audit_outbox` path to run, so an
 * `active_family_cap` eviction is provable from the outbox table rather than
 * a mocked call.
 *
 * These call the issuer functions directly (`issueExtensionToken`,
 * `issueIosToken`, `issueAutofillToken`) rather than going through the HTTP
 * routes — no DPoP proof is needed for that; `cnfJkt` is just an opaque
 * device-key thumbprint at this layer.
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
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { hashToken } from "@/lib/crypto/crypto-server";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { prisma } from "@/lib/prisma";
import { issueExtensionToken } from "@/lib/auth/tokens/extension-token";
import { issueIosToken, issueAutofillToken } from "@/lib/auth/tokens/mobile-token";
import { CLIENT_TOKEN_MAX_ACTIVE_FAMILIES } from "@/lib/constants";

// ─── Fixtures / helpers ──────────────────────────────────────────

// Tenant defaults (extensionTokenIdleTimeoutMinutes / …AbsoluteTimeoutMinutes)
// are far longer than this suite runs for — no per-test tenant policy needed.
const IDLE_MINUTES = 10_080; // 7d (schema default)
const ABSOLUTE_MINUTES = 43_200; // 30d (schema default)

/** Distinct 43-char-ish device-key thumbprint per test device/install. */
function cnfJkt(label: string): string {
  return `${label}-`.padEnd(43, "x").slice(0, 43);
}

async function familyIdForToken(token: string): Promise<string> {
  const row = await withBypassRls(prisma, async (tx) =>
    tx.extensionToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { familyId: true },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);
  if (!row) throw new Error("familyIdForToken: token row not found");
  return row.familyId;
}

async function activeFamilies(ctx: TestContext, userId: string): Promise<string[]> {
  const rows = await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ family_id: string }[]>(
      `SELECT DISTINCT family_id FROM extension_tokens
       WHERE user_id = $1::uuid AND revoked_at IS NULL AND expires_at > now()
         AND client_kind != 'IOS_AUTOFILL'`,
      userId,
    );
  });
  return rows.map((r) => r.family_id);
}

async function allFamilyIds(ctx: TestContext, userId: string): Promise<string[]> {
  const rows = await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ family_id: string }[]>(
      `SELECT DISTINCT family_id FROM extension_tokens WHERE user_id = $1::uuid`,
      userId,
    );
  });
  return rows.map((r) => r.family_id);
}

async function isFamilyFullyRevoked(ctx: TestContext, familyId: string): Promise<boolean> {
  const rows = await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
      `SELECT COUNT(*) AS cnt FROM extension_tokens
       WHERE family_id = $1::uuid AND revoked_at IS NULL`,
      familyId,
    );
  });
  return Number(rows[0]!.cnt) === 0;
}

/** Backdate every row of a family's `last_presence_at` via the superuser client. */
async function backdatePresence(ctx: TestContext, familyId: string, presenceAt: Date): Promise<void> {
  await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE extension_tokens SET last_presence_at = $2 WHERE family_id = $1::uuid`,
      familyId,
      presenceAt,
    );
  });
}

async function auditFamilyRevokedRows(
  ctx: TestContext,
  tenantId: string,
  userId: string,
): Promise<Array<{ metadata: { reason: string; familyId: string; rowsRevoked: number } }>> {
  const rows = await ctx.su.prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<{ payload: { metadata: { reason: string; familyId: string; rowsRevoked: number } } }[]>(
      `SELECT payload FROM audit_outbox
       WHERE tenant_id = $1::uuid AND payload->>'userId' = $2::text
         AND payload->>'action' = 'EXTENSION_TOKEN_FAMILY_REVOKED'`,
      tenantId,
      userId,
    );
  });
  return rows.map((r) => r.payload);
}

describe("passkey-signin-client-token-cascade C3 — active-family cap (real DB)", () => {
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
    // Extension tokens FK-Restrict their tenant; drop them before
    // deleteTestData()'s tenant/user cleanup (mirrors client-token-presence
    // and extension-token-dpop-flow).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM extension_tokens WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  // ── (a) a family + AutoFill: a new extension install evicts nothing ────

  it("(a) an extension family + an iOS family + an active AutoFill token: a new extension install evicts nothing", async () => {
    const ext1 = await issueExtensionToken({
      userId,
      tenantId,
      scope: "passwords:read",
      cnfJkt: cnfJkt("ext1"),
    });
    const ios1 = await issueIosToken({
      userId,
      tenantId,
      deviceJkt: cnfJkt("ios1"),
      cnfJkt: cnfJkt("ios1"),
      idleMinutes: IDLE_MINUTES,
      absoluteMinutes: ABSOLUTE_MINUTES,
      presenceAt: new Date(),
    });
    await issueAutofillToken({ userId, tenantId, cnfJkt: cnfJkt("af1") });

    const fam1 = await familyIdForToken(ext1.token);
    const before = await activeFamilies(ctx, userId);
    expect(before.sort()).toEqual([fam1, ios1.familyId].sort());

    const ext2 = await issueExtensionToken({
      userId,
      tenantId,
      scope: "passwords:read",
      cnfJkt: cnfJkt("ext2"),
    });
    const fam2 = await familyIdForToken(ext2.token);

    const after = await activeFamilies(ctx, userId);
    expect(after.sort()).toEqual([fam1, ios1.familyId, fam2].sort());
    const auditRows = await auditFamilyRevokedRows(ctx, tenantId, userId);
    expect(auditRows).toHaveLength(0);
  });

  // ── (b) a 4th family evicts exactly the family with the oldest presence ──

  it("(b) a 4th family evicts exactly the family with the oldest presence, all of its rows", async () => {
    const ext1 = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("b1") });
    const fam1 = await familyIdForToken(ext1.token);
    const ext2 = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("b2") });
    const fam2 = await familyIdForToken(ext2.token);
    const ext3 = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("b3") });
    const fam3 = await familyIdForToken(ext3.token);

    await backdatePresence(ctx, fam1, new Date("2025-06-01"));
    await backdatePresence(ctx, fam2, new Date("2025-01-01")); // oldest
    await backdatePresence(ctx, fam3, new Date("2025-06-02"));

    const ext4 = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("b4") });
    const fam4 = await familyIdForToken(ext4.token);

    expect(await isFamilyFullyRevoked(ctx, fam2)).toBe(true);
    const active = await activeFamilies(ctx, userId);
    expect(active.sort()).toEqual([fam1, fam3, fam4].sort());

    const auditRows = await auditFamilyRevokedRows(ctx, tenantId, userId);
    expect(
      auditRows.some(
        (r) => r.metadata.reason === "active_family_cap" && r.metadata.familyId === fam2,
      ),
    ).toBe(true);
  });

  // ── (c) same-install reconnect supersedes only that install's family ────

  it("(c) reconnecting the same install (same cnfJkt + clientKind) revokes only that install's previous family", async () => {
    const cnfA = cnfJkt("same-device");
    const cnfB = cnfJkt("other-device");

    const extA1 = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfA });
    const famA1 = await familyIdForToken(extA1.token);
    const extB = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfB });
    const famB = await familyIdForToken(extB.token);

    const extA2 = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfA });
    const famA2 = await familyIdForToken(extA2.token);

    expect(await isFamilyFullyRevoked(ctx, famA1)).toBe(true);
    expect(await isFamilyFullyRevoked(ctx, famB)).toBe(false);
    const active = await activeFamilies(ctx, userId);
    expect(active.sort()).toEqual([famA2, famB].sort());

    const auditRows = await auditFamilyRevokedRows(ctx, tenantId, userId);
    expect(
      auditRows.some(
        (r) => r.metadata.reason === "superseded_same_device" && r.metadata.familyId === famA1,
      ),
    ).toBe(true);
  });

  // ── (d) iOS refresh (familyId supplied) never evicts ────────────────────

  it("(d) iOS refresh (familyId supplied) with the cap already reached evicts nothing", async () => {
    const ext1 = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("d1") });
    const fam1 = await familyIdForToken(ext1.token);
    const ext2 = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("d2") });
    const fam2 = await familyIdForToken(ext2.token);
    const ios1 = await issueIosToken({
      userId,
      tenantId,
      deviceJkt: cnfJkt("d3"),
      cnfJkt: cnfJkt("d3"),
      idleMinutes: IDLE_MINUTES,
      absoluteMinutes: ABSOLUTE_MINUTES,
      presenceAt: new Date(),
    });

    const before = await activeFamilies(ctx, userId);
    expect(before.sort()).toEqual([fam1, fam2, ios1.familyId].sort());

    // Refresh-rotation continuing ios1's OWN family (familyId supplied) —
    // must skip supersede + cap entirely.
    const refreshed = await issueIosToken({
      userId,
      tenantId,
      deviceJkt: cnfJkt("d3"),
      cnfJkt: cnfJkt("d3"),
      familyId: ios1.familyId,
      familyCreatedAt: ios1.familyCreatedAt,
      idleMinutes: IDLE_MINUTES,
      absoluteMinutes: ABSOLUTE_MINUTES,
      presenceAt: new Date(),
    });
    expect(refreshed.familyId).toBe(ios1.familyId);

    const after = await activeFamilies(ctx, userId);
    expect(after.sort()).toEqual(before.sort());
    const auditRows = await auditFamilyRevokedRows(ctx, tenantId, userId);
    expect(auditRows).toHaveLength(0);
  });

  // ── (e) concurrency: contention proven before the invariant ─────────────

  it("(e) 10 concurrent issuances with distinct cnfJkt: contention is provable, and the cap holds", async () => {
    const cnfs = Array.from({ length: 10 }, (_, i) => cnfJkt(`conc-${i}`));
    await Promise.all(
      cnfs.map((cnf) =>
        issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnf }),
      ),
    );

    // 1. Contention actually happened: more distinct families exist (incl.
    // revoked rows) than the cap allows — revocation only sets revokedAt, the
    // rows stay in the table.
    const all = await allFamilyIds(ctx, userId);
    expect(all.length).toBeGreaterThan(CLIENT_TOKEN_MAX_ACTIVE_FAMILIES);

    // 2. At least one real EXTENSION_TOKEN_FAMILY_REVOKED row landed in
    // audit_outbox with reason "active_family_cap" — the real logAuditAsync
    // path, not a mock.
    const auditRows = await auditFamilyRevokedRows(ctx, tenantId, userId);
    expect(auditRows.some((r) => r.metadata.reason === "active_family_cap")).toBe(true);

    // 3. The invariant: at most CLIENT_TOKEN_MAX_ACTIVE_FAMILIES active.
    const active = await activeFamilies(ctx, userId);
    expect(active.length).toBeLessThanOrEqual(CLIENT_TOKEN_MAX_ACTIVE_FAMILIES);
  });

  // ── (f) presence read over ALL rows, not just the active ones ───────────

  it("(f) a genuinely older family is evicted, not one whose only recent presence sits on an expired row", async () => {
    const now = Date.now();
    const iosX = await issueIosToken({
      userId,
      tenantId,
      deviceJkt: cnfJkt("f-ios"),
      cnfJkt: cnfJkt("f-ios"),
      idleMinutes: IDLE_MINUTES,
      absoluteMinutes: ABSOLUTE_MINUTES,
      presenceAt: new Date(now),
    });
    // Expire ONLY the access row, but keep its presence recent; push the
    // refresh row's own presence stamp further back — the family stays
    // "active" via the still-live refresh row, and the true (max) presence
    // sits on the now-expired access row (F-func-1).
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE extension_tokens SET expires_at = $2, last_presence_at = $3
         WHERE id = $1::uuid`,
        iosX.tokenId,
        new Date(now - 1_000),
        new Date(now - 30_000),
      );
      await tx.$executeRawUnsafe(
        `UPDATE extension_tokens SET last_presence_at = $2
         WHERE family_id = $1::uuid AND id != $3::uuid`,
        iosX.familyId,
        new Date(now - 500_000),
        iosX.tokenId,
      );
    });

    const extY = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("f-y") });
    const famY = await familyIdForToken(extY.token);
    await backdatePresence(ctx, famY, new Date(now - 2 * 60 * 60 * 1000)); // genuinely 2h old

    const extZ = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("f-z") });
    const famZ = await familyIdForToken(extZ.token);
    // famZ keeps its just-issued (now) presence.

    const before = await activeFamilies(ctx, userId);
    expect(before.sort()).toEqual([iosX.familyId, famY, famZ].sort());

    const extW = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("f-w") });
    const famW = await familyIdForToken(extW.token);

    expect(await isFamilyFullyRevoked(ctx, famY)).toBe(true);
    const after = await activeFamilies(ctx, userId);
    expect(after.sort()).toEqual([iosX.familyId, famZ, famW].sort());
  });

  // ── (g) tie-break: equal presence → lower familyId evicted ──────────────

  it("(g) equal presence: the lexicographically lower familyId is evicted (deterministic tie-break)", async () => {
    const extA = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("g-a") });
    const famA = await familyIdForToken(extA.token);
    const extB = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("g-b") });
    const famB = await familyIdForToken(extB.token);
    const extC = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("g-c") });
    const famC = await familyIdForToken(extC.token);

    const tiedPresence = new Date(Date.now() - 3_600_000);
    await backdatePresence(ctx, famA, tiedPresence);
    await backdatePresence(ctx, famB, tiedPresence);
    await backdatePresence(ctx, famC, new Date()); // clearly newest — never the eviction target here

    const [lower, higher] = [famA, famB].sort();

    const extD = await issueExtensionToken({ userId, tenantId, scope: "passwords:read", cnfJkt: cnfJkt("g-d") });
    const famD = await familyIdForToken(extD.token);

    expect(await isFamilyFullyRevoked(ctx, lower)).toBe(true);
    expect(await isFamilyFullyRevoked(ctx, higher)).toBe(false);
    const active = await activeFamilies(ctx, userId);
    expect(active.sort()).toEqual([higher, famC, famD].sort());
  });

  // ── (h) AutoFill concurrency: exactly one active row survives ───────────

  it("(h) N concurrent AutoFill mints leave exactly one active IOS_AUTOFILL row", async () => {
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        issueAutofillToken({ userId, tenantId, cnfJkt: cnfJkt(`h-${i}`) }),
      ),
    );

    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(*) AS cnt FROM extension_tokens
         WHERE user_id = $1::uuid AND client_kind = 'IOS_AUTOFILL'
           AND revoked_at IS NULL AND expires_at > now()`,
        userId,
      );
    });
    expect(Number(rows[0]!.cnt)).toBe(1);
  });
});
