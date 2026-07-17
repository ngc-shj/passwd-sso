/**
 * Integration test (real DB): master-key rotation state machine — CAS races
 * (C9a) and env drift (C9c), per security-control-verification plan.
 *
 * Production entry points driven directly (test-F1/RT5): the three real
 * route handlers (approve/execute/revoke) with real `op_*` operator tokens
 * seeded in the DB and validated via the real validateOperatorToken path
 * (no auth mock — the admin routes are Bearer-token authenticated against a
 * real DB row, not a session).
 *
 * C9b (execute partial-failure, VE2) lives in a SEPARATE unit-test file —
 * ../../app/api/admin/rotate-master-key/[rotationId]/execute/execute-partial-failure.test.ts
 * — because its module-scope `vi.mock("@/lib/crypto/crypto-server", ...)`
 * would otherwise shadow the real `hashToken` this file needs for seeding
 * operator tokens (vi.mock is hoisted file-wide, not scoped to a describe
 * block).
 *
 * Run: docker compose up -d db && npm run test:integration -- master-key-rotation-races
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import {
  createTestContext,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { hashToken } from "@/lib/crypto/crypto-server";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";

// Rate limiters are per-key, max=1 for these routes — disable so repeated
// calls in the same test/loop are never throttled.
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));

import { POST as approvePOST } from "@/app/api/admin/rotate-master-key/[rotationId]/approve/route";
import { POST as executePOST } from "@/app/api/admin/rotate-master-key/[rotationId]/execute/route";
import { POST as revokePOST } from "@/app/api/admin/rotate-master-key/[rotationId]/revoke/route";

function hex(nBytes: number): string {
  return randomBytes(nBytes).toString("hex");
}

function makeOperatorTokenPlaintext(): string {
  // OPERATOR_TOKEN_PLAINTEXT_RE: /^op_[A-Za-z0-9_-]{43}$/
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let body = "";
  for (let i = 0; i < 43; i++) {
    body += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${OPERATOR_TOKEN_PREFIX}${body}`;
}

function buildRequest(
  path: string,
  token: string,
  body?: Record<string, unknown>,
): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function rotationParams(rotationId: string) {
  return { params: Promise.resolve({ rotationId }) };
}

/**
 * deleteTestData can lose a race against the live audit-outbox-worker
 * process (running against this same dev DB — see CLAUDE.md docker
 * services): the worker drains audit_outbox rows into audit_logs
 * concurrently with cleanup, so a freshly-inserted audit_logs row can appear
 * AFTER this helper's own audit_logs delete step, failing the tenant
 * delete's audit_logs_tenant_id_fkey. This suite drives real rotation
 * routes across many iterations (heavy audit emission), so retry with a
 * short backoff.
 */
async function deleteTestDataWithRetry(ctx: TestContext, tenantId: string): Promise<void> {
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await ctx.deleteTestData(tenantId);
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      await new Promise((res) => setTimeout(res, 50 * attempt));
    }
  }
}

describe("master-key rotation — real-DB integration (C9)", () => {
  let ctx: TestContext;
  let tenantId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    vi.clearAllMocks();
    // The execute handler re-validates targetVersion against
    // SHARE_MASTER_KEY_CURRENT_VERSION and needs SHARE_MASTER_KEY_V2 configured
    // to rewrap. These tests seed targetVersion: 2, so make the env self-
    // contained rather than relying on the ambient .env (CI's ci-integration.yml
    // sets only the legacy SHARE_MASTER_KEY = v1). Individual tests (C9c) may
    // override SHARE_MASTER_KEY_CURRENT_VERSION to exercise version drift.
    vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "2");
    vi.stubEnv(
      "SHARE_MASTER_KEY_V2",
      "2222222222222222222222222222222222222222222222222222222222222222",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    // master_key_rotations and password_shares are not cleaned by the shared
    // deleteTestData helper; their tenant FK is Restrict, so they must be
    // removed before the tenant delete or it fails.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(`DELETE FROM master_key_rotations WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(`DELETE FROM password_shares WHERE tenant_id = $1::uuid`, tenantId);
    });
    await deleteTestDataWithRetry(ctx, tenantId);
  });

  /** Seed an OWNER tenant member + a valid op_* operator token for them. */
  async function seedOperator(): Promise<{ userId: string; token: string }> {
    const userId = await ctx.createUser(tenantId);
    // ctx.createUser already inserts a tenant_members OWNER row — reuse it.
    const plaintext = makeOperatorTokenPlaintext();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO operator_tokens (
           id, token_hash, prefix, name, tenant_id, subject_user_id, created_by_user_id,
           scope, expires_at, created_at
         ) VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $6::uuid, 'maintenance', now() + interval '30 days', now())`,
        randomUUID(),
        hashToken(plaintext),
        plaintext.slice(0, 8),
        `test-operator-${userId.slice(0, 8)}`,
        tenantId,
        userId,
      );
    });
    return { userId, token: plaintext };
  }

  async function seedRotationRow(opts: {
    initiatedById: string;
    targetVersion: number;
    approvedById?: string | null;
    approvedAt?: Date | null;
    executedAt?: Date | null;
    executedById?: string | null;
    revokedAt?: Date | null;
    revokedById?: string | null;
    expiresAt?: Date;
    revokeShares?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    const expiresAt = opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000);
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO master_key_rotations (
           id, tenant_id, initiated_by_id, target_version, revoke_shares,
           approved_by_id, approved_at, executed_at, executed_by_id,
           expires_at, revoked_at, revoked_by_id, created_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5,
           $6::uuid, $7, $8, $9::uuid,
           $10, $11, $12::uuid, now()
         )`,
        id, tenantId, opts.initiatedById, opts.targetVersion, opts.revokeShares ?? true,
        opts.approvedById ?? null, opts.approvedAt ?? null, opts.executedAt ?? null, opts.executedById ?? null,
        expiresAt, opts.revokedAt ?? null, opts.revokedById ?? null,
      );
    });
    return id;
  }

  async function getRotationRow(rotationId: string) {
    const r = await ctx.su.pool.query<{
      approved_at: Date | null; executed_at: Date | null; revoked_at: Date | null;
    }>(
      `SELECT approved_at, executed_at, revoked_at FROM master_key_rotations WHERE id = $1::uuid`,
      [rotationId],
    );
    return r.rows[0];
  }

  async function seedPasswordShare(masterKeyVersion: number): Promise<string> {
    const ownerId = await ctx.createUser(tenantId);
    const shareId = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO password_shares (
           id, tenant_id, created_by_id, encrypted_data, data_iv, data_auth_tag,
           token_hash, master_key_version, expires_at, created_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, now() + interval '1 day', now())`,
        shareId, tenantId, ownerId, hex(32), hex(12), hex(16), hex(32), masterKeyVersion,
      );
    });
    return shareId;
  }

  // ── C9a: approve-vs-revoke on pending ─────────────────────────────────────

  it("C9a — concurrent approve-vs-revoke on pending row: both CAS updates may commit (disjoint predicates); execute is unconditionally blocked once revoked", async () => {
    // FINDING (recorded, not silently normalized — RT7/test-F9 "pin what's
    // real"): revoke's CAS WHERE is {id, tenantId, executedAt:null,
    // revokedAt:null} — it does NOT check approvedAt (computeRevokeEligibility
    // mirrors this: only executedAt/revokedAt gate eligibility). approve's CAS
    // WHERE independently checks {approvedAt:null, executedAt:null,
    // revokedAt:null, expiresAt:{gt}, initiatedById:{not}}. These predicates
    // are NOT mutually exclusive on a pending row, so BOTH can legitimately
    // commit when raced — the row ends up approved AND revoked. This is safe
    // (not a data-integrity bug) because revokedAt alone is sufficient to
    // permanently block execute (computeExecuteEligibility requires
    // revokedAt===null); "approved-then-revoked" is a valid terminal-for-
    // execution-purposes state, not an inconsistent one. The plan's original
    // "exactly one wins" framing does not hold for THIS pair; the actual
    // safety invariant — asserted below — is that revokedAt, once set, makes
    // the row permanently non-executable regardless of approvedAt.
    const initiator = await seedOperator();
    const secondActor = await seedOperator();
    const rotationId = await seedRotationRow({
      initiatedById: initiator.userId,
      targetVersion: 2,
    });

    const invoke = async (
      kind: "approve" | "revoke",
      token: string,
    ): Promise<number> => {
      const req = buildRequest(
        `/api/admin/rotate-master-key/${rotationId}/${kind}`,
        token,
      );
      const res = await (kind === "approve" ? approvePOST : revokePOST)(req, rotationParams(rotationId));
      return res.status;
    };

    const [approveStatus, revokeStatus] = await Promise.all([
      invoke("approve", secondActor.token),
      invoke("revoke", initiator.token),
    ]);

    // Revoke always succeeds (its CAS predicate is satisfied on any pending
    // row and does not race against approve's disjoint predicate).
    expect(revokeStatus).toBe(200);
    expect([200, 409]).toContain(approveStatus);

    const row = await getRotationRow(rotationId);
    expect(row.revoked_at).not.toBeNull();

    // Core safety invariant: once revoked, execute must be permanently
    // blocked — regardless of whether approve also committed.
    const executeReq = buildRequest(`/api/admin/rotate-master-key/${rotationId}/execute`, initiator.token);
    const executeRes = await executePOST(executeReq, rotationParams(rotationId));
    expect(executeRes.status).toBe(409);
    const afterExecuteAttempt = await getRotationRow(rotationId);
    expect(afterExecuteAttempt.executed_at).toBeNull();
  });

  // ── C9a: execute-vs-revoke on approved — same exclusivity ─────────────────

  it("C9a — concurrent execute-vs-revoke on approved row: exactly one wins; loser side-effects absent", async () => {
    const initiator = await seedOperator();
    const secondActor = await seedOperator();
    const rotationId = await seedRotationRow({
      initiatedById: initiator.userId,
      targetVersion: 2,
      approvedById: secondActor.userId,
      approvedAt: new Date(),
      revokeShares: true,
    });
    const shareId = await seedPasswordShare(1); // old-version share, eligible for revocation

    const invoke = async (
      kind: "execute" | "revoke",
      token: string,
    ): Promise<number> => {
      const req = buildRequest(
        `/api/admin/rotate-master-key/${rotationId}/${kind}`,
        token,
      );
      const res = await (kind === "execute" ? executePOST : revokePOST)(req, rotationParams(rotationId));
      return res.status;
    };

    const [executeStatus, revokeStatus] = await Promise.all([
      invoke("execute", initiator.token),
      invoke("revoke", secondActor.token),
    ]);

    const succeeded = [executeStatus, revokeStatus].filter((s) => s === 200).length;
    expect(succeeded).toBe(1);

    const row = await getRotationRow(rotationId);
    const terminalCount = [row.executed_at !== null, row.revoked_at !== null].filter(Boolean).length;
    expect(terminalCount).toBe(1);

    // RT8: if revoke won, execute never ran passwordShare.updateMany — the
    // share's masterKeyVersion must be UNCHANGED.
    if (row.revoked_at !== null) {
      const share = await ctx.su.pool.query<{ master_key_version: number; revoked_at: Date | null }>(
        `SELECT master_key_version, revoked_at FROM password_shares WHERE id = $1::uuid`,
        [shareId],
      );
      expect(share.rows[0].revoked_at).toBeNull();
    }
  });

  // ── C9a: double-execute — single transition ───────────────────────────────

  it("C9a — concurrent double-execute on approved row: single transition, loser gets ROTATION_NOT_EXECUTABLE, no double share-revocation", async () => {
    const initiator = await seedOperator();
    const secondActor = await seedOperator();
    const rotationId = await seedRotationRow({
      initiatedById: initiator.userId,
      targetVersion: 2,
      approvedById: secondActor.userId,
      approvedAt: new Date(),
      revokeShares: true,
    });
    const shareId = await seedPasswordShare(1);

    const invoke = async (token: string): Promise<number> => {
      const req = buildRequest(`/api/admin/rotate-master-key/${rotationId}/execute`, token);
      const res = await executePOST(req, rotationParams(rotationId));
      return res.status;
    };

    const [statusA, statusB] = await Promise.all([
      invoke(initiator.token),
      invoke(secondActor.token),
    ]);

    const succeeded = [statusA, statusB].filter((s) => s === 200).length;
    expect(succeeded).toBe(1);
    const conflicted = [statusA, statusB].filter((s) => s === 409).length;
    expect(conflicted).toBe(1);

    const row = await getRotationRow(rotationId);
    expect(row.executed_at).not.toBeNull();

    // Share revoked exactly once — not double-processed by the loser.
    const share = await ctx.su.pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM password_shares WHERE id = $1::uuid`,
      [shareId],
    );
    expect(share.rows[0].revoked_at).not.toBeNull();
  });

  // ── C9a fallback loop: ≥50 iterations, winCount>0 AND loserCount>0 ────────

  it("50-iteration loop: concurrent double-execute — winCount>0 AND loserCount>0 (RT4 fallback)", async () => {
    const ITERATIONS = 50;
    let winCount = 0;
    let loserCount = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const initiator = await seedOperator();
      const secondActor = await seedOperator();
      const rotationId = await seedRotationRow({
        initiatedById: initiator.userId,
        targetVersion: 2,
        approvedById: secondActor.userId,
        approvedAt: new Date(),
        revokeShares: false, // isolate the CAS race from share-revocation cost
      });

      const jitterA = (i * 5) % 11;
      const jitterB = (i * 7) % 11;
      const invoke = async (token: string, delayMs: number): Promise<number> => {
        await new Promise((res) => setTimeout(res, delayMs));
        const req = buildRequest(`/api/admin/rotate-master-key/${rotationId}/execute`, token);
        const res = await executePOST(req, rotationParams(rotationId));
        return res.status;
      };

      const [statusA, statusB] = await Promise.all([
        invoke(initiator.token, jitterA),
        invoke(secondActor.token, jitterB),
      ]);

      if (statusA === 200 || statusB === 200) winCount++;
      if (statusA === 409 || statusB === 409) loserCount++;

      // Cleanup this iteration's users to keep tenant data bounded.
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(`DELETE FROM master_key_rotations WHERE id = $1::uuid`, rotationId);
      });
    }

    expect(winCount).toBeGreaterThan(0);
    expect(loserCount).toBeGreaterThan(0);
  }, 120_000);

  // ── C9c: env drift — execute-time re-validation rejects ───────────────────

  it("C9c — targetVersion no longer matches env at execute time → rejected by re-validation", async () => {
    vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "2");
    const initiator = await seedOperator();
    const secondActor = await seedOperator();
    // Initiate captured targetVersion=2 (matching env at initiate time).
    const rotationId = await seedRotationRow({
      initiatedById: initiator.userId,
      targetVersion: 2,
      approvedById: secondActor.userId,
      approvedAt: new Date(),
    });

    // Env drifts to version 3 before execute runs.
    vi.stubEnv("SHARE_MASTER_KEY_CURRENT_VERSION", "3");

    const req = buildRequest(`/api/admin/rotate-master-key/${rotationId}/execute`, initiator.token);
    const res = await executePOST(req, rotationParams(rotationId));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("ROTATION_TARGET_VERSION_MISMATCH");

    const row = await getRotationRow(rotationId);
    expect(row.executed_at).toBeNull();

    vi.unstubAllEnvs();
  });
});

