/**
 * Integration test (real DB [+ real Redis for the I9b case]):
 * `sessions.auth_credential_id` — the FK that binds a step-up reauth ceremony
 * to the credential that established the session (bind-stepup-to-session-
 * credential plan, contracts C1/C4/C5).
 *
 * Follows require-recent-session.integration.test.ts's seeding pattern: raw
 * `INSERT INTO sessions` with `hashSessionToken(token)` for the digest
 * column, since the DB stores a digest and a seeder inserting the raw token
 * tests nothing.
 *
 * Run:
 *   docker compose up -d db redis
 *   npm run test:integration -- reauth-credential-binding.integration
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
import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { NextRequest } from "next/server";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import {
  createTestContext,
  setBypassRlsGucs,
  sqlStateOf,
  type TestContext,
} from "./helpers";
import {
  requireRecentCurrentAuthMethod,
  canRecoverSessionWithPasskey,
} from "@/lib/auth/session/recent-current-auth-method";
import { generateChallengeId } from "@/lib/auth/webauthn/webauthn-server";
import { getRedis } from "@/lib/redis";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";

const hasDatabase = !!process.env.DATABASE_URL;
const redisAvailable = !!process.env.REDIS_URL;

// ── Auth boundary + rate-limit bypass, for the route-level (C4) cases only ──
// Precedent: team-rotate-key.integration.test.ts. `auth()` reads next/headers,
// which has no request-scoped store outside real Next.js request handling, so
// it is mocked the same way every other DB-integration route test mocks it;
// everything downstream of it (session lookup, the credential FK, the
// verifier's Redis challenge, the audit outbox) is real.
const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({
    check: async () => ({ allowed: true, retryAfterMs: 0 }),
    clear: () => {},
  }),
}));

import { POST as reauthVerifyPOST } from "@/app/api/auth/passkey/reauth/verify/route";

describe.skipIf(!hasDatabase)("sessions.auth_credential_id binding (real DB)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  let redis: Redis | null = null;

  beforeAll(async () => {
    ctx = await createTestContext();
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    vi.stubEnv("WEBAUTHN_RP_ID", "localhost");
    if (redisAvailable) {
      const r = getRedis();
      if (!r) {
        throw new Error(
          "getRedis() returned null despite REDIS_URL being set — check redis.ts",
        );
      }
      redis = r;
    }
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
    mockAuth.mockResolvedValue({ user: { id: userId } });
  });

  afterEach(async () => {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM sessions WHERE tenant_id = $1::uuid`,
        tenantId,
      );
    });
    await ctx.deleteTestData(tenantId);
  });

  // ── Fixture helpers ─────────────────────────────────────────────

  async function insertCredential(
    ownerUserId: string,
    ownerTenantId: string,
    credentialId: string,
  ): Promise<string> {
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO webauthn_credentials (
           id, user_id, tenant_id, credential_id, public_key, device_type, created_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now())`,
        id,
        ownerUserId,
        ownerTenantId,
        credentialId,
        "test-public-key",
        "singleDevice",
      );
    });
    return id;
  }

  async function insertSession(opts: {
    provider: string | null;
    authCredentialId: string | null;
    passkeyVerifiedAt: Date | null;
  }): Promise<string> {
    // H4: the cookie carries the RAW token; the DB column stores its digest.
    const token = `sess-${randomUUID()}`;
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO sessions (
           id, session_token, user_id, tenant_id, expires, created_at, last_active_at,
           provider, auth_credential_id, passkey_verified_at
         ) VALUES (
           $1::uuid, $2, $3::uuid, $4::uuid,
           now() + interval '1 day', now(), now(), $5, $6::uuid, $7
         )`,
        randomUUID(),
        hashSessionToken(token),
        userId,
        tenantId,
        opts.provider,
        opts.authCredentialId,
        opts.passkeyVerifiedAt,
      );
    });
    return token;
  }

  function makeRequest(sessionToken?: string): NextRequest {
    const headers = new Headers();
    if (sessionToken) {
      headers.set("cookie", `authjs.session-token=${sessionToken}`);
    }
    return new NextRequest("http://localhost:3000/api/test-sensitive", {
      method: "POST",
      headers,
    });
  }

  function buildVerifyRequest(
    sessionToken: string,
    body: Record<string, unknown>,
  ): NextRequest {
    return new NextRequest(
      "http://localhost:3000/api/auth/passkey/reauth/verify",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          cookie: `authjs.session-token=${sessionToken}`,
        },
        body: JSON.stringify(body),
      },
    );
  }

  async function outboxRowsFor(action: string): Promise<Record<string, unknown>[]> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.auditOutbox.findMany({
        where: { tenantId },
        select: { payload: true },
      });
    });
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p.action === action);
  }

  // ── I1 / I2 — the FK itself ──────────────────────────────────────

  it("deleting the bound credential leaves the session row and nulls its binding (I2)", async () => {
    const credentialRowId = await insertCredential(
      userId,
      tenantId,
      `cred-${randomUUID()}`,
    );
    const token = await insertSession({
      provider: "webauthn",
      authCredentialId: credentialRowId,
      passkeyVerifiedAt: null,
    });

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM webauthn_credentials WHERE id = $1::uuid`,
        credentialRowId,
      );
    });

    const row = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.session.findFirst({
        where: { sessionToken: hashSessionToken(token) },
        select: { authCredentialId: true },
      });
    });
    expect(row).not.toBeNull();
    expect(row!.authCredentialId).toBeNull();
  });

  it.skipIf(!redisAvailable)(
    "the FK cascade's effect reaches the route: an outstanding ceremony on a deleted binding denies at step 3, verifier never called",
    async () => {
      // What this proves, precisely: the ON DELETE SET NULL cascade is visible to
      // reauth/verify through a real DB round-trip, so a ceremony admitted while
      // the binding was live denies at step 3 once the credential is gone, and
      // the verifier is never reached.
      //
      // What it does NOT prove, despite an earlier version of this test claiming
      // it (finding C1): substitution resistance at the verifier. The deletion
      // commits before the route runs, so the FK has already nulled the binding
      // and step 3 denies first — swapping the route's call to
      // verifyAssertionAnyCredential leaves this test green. That defense is
      // proven where it actually lives: verify-authentication-assertion.test.ts's
      // DENY case (real verifier, mismatched row id) and the "bound row present,
      // wrong credential presented" case below. I9's true concurrent
      // interleaving is not schedulable in this harness — see D9, same shape as
      // D2's precedent for `credential_missing`.
      const boundRowId = await insertCredential(userId, tenantId, `bound-${randomUUID()}`);
      const otherCredId = `other-${randomUUID()}`;
      await insertCredential(userId, tenantId, otherCredId);

      const verifiedBefore = new Date(Date.now() - 60_000);
      const token = await insertSession({
        provider: "webauthn",
        authCredentialId: boundRowId,
        passkeyVerifiedAt: verifiedBefore,
      });

      // The ceremony was admitted while the binding was live.
      const challengeId = generateChallengeId();
      await redis!.set(
        `webauthn:challenge:reauth:${userId}:${challengeId}`,
        "test-challenge",
        "EX",
        60,
      );

      // …then the bound credential goes away. The FK nulls the binding.
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `DELETE FROM webauthn_credentials WHERE id = $1::uuid`,
          boundRowId,
        );
      });

      const res = await reauthVerifyPOST(
        buildVerifyRequest(token, {
          credentialResponse: JSON.stringify({ id: otherCredId }),
          challengeId,
        }),
      );

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "PASSKEY_REAUTH_UNAVAILABLE" });

      // Pin the reason this denies, so the test cannot later be read as
      // evidence of verifier-level scoping: it is the step-3 binding gate.
      const denials = await outboxRowsFor(
        AUDIT_ACTION.AUTH_PASSKEY_REAUTH_UNAVAILABLE,
      );
      expect(denials).toHaveLength(1);
      expect((denials[0].metadata as Record<string, unknown>).reason).toBe("no_binding");
      // The challenge is still outstanding: step 3 returns before the verifier,
      // and redis.getdel lives inside the verifier (I9b).
      await expect(
        redis!.get(`webauthn:challenge:reauth:${userId}:${challengeId}`),
      ).resolves.toBe("test-challenge");

      const after = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.session.findFirst({
          where: { sessionToken: hashSessionToken(token) },
          select: { passkeyVerifiedAt: true, authCredentialId: true },
        });
      });
      expect(after!.authCredentialId).toBeNull();
      // Byte-identical: the denial moved nothing.
      expect(after!.passkeyVerifiedAt?.getTime()).toBe(verifiedBefore.getTime());
    },
  );

  it("rejects a session pointed at a nonexistent credential row (I1)", async () => {
    const token = await insertSession({
      provider: "webauthn",
      authCredentialId: null,
      passkeyVerifiedAt: null,
    });

    let caught: unknown;
    try {
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `UPDATE sessions SET auth_credential_id = gen_random_uuid() WHERE session_token = $1`,
          hashSessionToken(token),
        );
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(sqlStateOf(caught)).toBe("23503"); // foreign_key_violation
  });

  // ── C5 member 0 — the gate's own binding check ───────────────────

  it("requireRecentCurrentAuthMethod denies a fresh-timestamp session with a null binding, and allows once the binding is restored (C5 member 0)", async () => {
    const credentialRowId = await insertCredential(
      userId,
      tenantId,
      `cred-${randomUUID()}`,
    );
    const token = await insertSession({
      provider: "webauthn",
      authCredentialId: null,
      passkeyVerifiedAt: new Date(),
    });

    // Nulling the binding on an otherwise-fresh row is what must flip the
    // verdict (M4) — the timestamp alone would pass the pre-fix gate.
    const deny = await requireRecentCurrentAuthMethod(makeRequest(token));
    expect(deny).not.toBeNull();
    expect(deny!.status).toBe(403);
    const denyBody = await deny!.json();
    expect(denyBody.error).toBe("SESSION_STEP_UP_REQUIRED");

    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE sessions SET auth_credential_id = $1::uuid WHERE session_token = $2`,
        credentialRowId,
        hashSessionToken(token),
      );
    });

    const allow = await requireRecentCurrentAuthMethod(makeRequest(token));
    expect(allow).toBeNull();
  });

  // ── C5 member 1 — the recovery predicate ─────────────────────────

  it("canRecoverSessionWithPasskey: false when unbound, true when bound and live, false once the bound row is gone (C5 member 1)", async () => {
    const credentialRowId = await insertCredential(
      userId,
      tenantId,
      `cred-${randomUUID()}`,
    );

    const unboundToken = await insertSession({
      provider: "webauthn",
      authCredentialId: null,
      passkeyVerifiedAt: null,
    });
    expect(await canRecoverSessionWithPasskey(unboundToken, userId)).toBe(
      false,
    );

    const boundToken = await insertSession({
      provider: "webauthn",
      authCredentialId: credentialRowId,
      passkeyVerifiedAt: null,
    });
    expect(await canRecoverSessionWithPasskey(boundToken, userId)).toBe(true);

    // I2 does the unbinding — no application code touches this session row.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `DELETE FROM webauthn_credentials WHERE id = $1::uuid`,
        credentialRowId,
      );
    });
    expect(await canRecoverSessionWithPasskey(boundToken, userId)).toBe(
      false,
    );
  });

  // ── C5 member 2 — per-request, not per-user ──────────────────────

  it("answers per session, not per user — the predicate GET /api/user/auth-provider's canPasskeyReauth delegates to (C5 member 2)", async () => {
    // handleGET(req) resolves the session via auth(), which reads
    // next/headers — unavailable outside a real Next.js request and not
    // reproducible in this harness (matches every other file here: no
    // db-integration test drives auth() through next/headers). This exercises
    // the exact shared predicate the route computes canPasskeyReauth from for
    // its OWN request's session (I10), with two real session rows for one
    // user proving the answer is per-session rather than memoized per-user.
    const credentialRowId = await insertCredential(
      userId,
      tenantId,
      `cred-${randomUUID()}`,
    );
    const boundToken = await insertSession({
      provider: "webauthn",
      authCredentialId: credentialRowId,
      passkeyVerifiedAt: null,
    });
    const unboundToken = await insertSession({
      provider: "webauthn",
      authCredentialId: null,
      passkeyVerifiedAt: null,
    });

    const [boundAnswer, unboundAnswer] = await Promise.all([
      canRecoverSessionWithPasskey(boundToken, userId),
      canRecoverSessionWithPasskey(unboundToken, userId),
    ]);

    expect(boundAnswer).toBe(true);
    expect(unboundAnswer).toBe(false);
  });

  // ── I9b — the challenge survives a step-3 denial (real Redis) ────

  it.skipIf(!redisAvailable)(
    "a step-3 'no binding' denial at /reauth/verify does not consume the outstanding challenge (I9b)",
    async () => {
      const token = await insertSession({
        provider: "webauthn",
        authCredentialId: null,
        passkeyVerifiedAt: null,
      });
      const challengeId = generateChallengeId();
      const challengeKey = `webauthn:challenge:reauth:${userId}:${challengeId}`;
      await redis!.set(challengeKey, "outstanding-challenge", "EX", 60);

      const res = await reauthVerifyPOST(
        buildVerifyRequest(token, {
          credentialResponse: JSON.stringify({ id: `presented-${randomUUID()}` }),
          challengeId,
        }),
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("PASSKEY_REAUTH_UNAVAILABLE");

      // redis.getdel lives INSIDE verifyAssertionForCredential; step 3 denies
      // before the verifier is ever called, so the challenge must still be
      // readable. Red-proof: moving the challenge consumption ahead of the
      // binding check is the only mutation that reddens this assertion.
      const stillThere = await redis!.get(challengeKey);
      expect(stillThere).toBe("outstanding-challenge");

      await redis!.del(challengeKey);
    },
  );

  // ── Denial discrimination — the two states this tier can reach ──
  //
  // counter_mismatch and signature_invalid are deliberately NOT attempted
  // here: reaching the counter-CAS requires a validly-signed assertion this
  // tier cannot produce (VE1). Both are covered at the route tier, where the
  // verifier is mocked (see reauth/verify/route.test.ts).

  it.skipIf(!redisAvailable)(
    "bound row present, wrong credential presented -> 403 PASSKEY_REAUTH_CREDENTIAL_MISMATCH / presented_credential",
    async () => {
      const boundCredId = `bound-${randomUUID()}`;
      const credentialRowId = await insertCredential(
        userId,
        tenantId,
        boundCredId,
      );
      const token = await insertSession({
        provider: "webauthn",
        authCredentialId: credentialRowId,
        passkeyVerifiedAt: null,
      });

      const challengeId = generateChallengeId();
      await redis!.set(
        `webauthn:challenge:reauth:${userId}:${challengeId}`,
        "test-challenge",
        "EX",
        60,
      );
      const presentedCredId = `presented-${randomUUID()}`;

      const res = await reauthVerifyPOST(
        buildVerifyRequest(token, {
          credentialResponse: JSON.stringify({ id: presentedCredId }),
          challengeId,
        }),
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("PASSKEY_REAUTH_CREDENTIAL_MISMATCH");

      const sessionRow = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.session.findFirst({
          where: { sessionToken: hashSessionToken(token) },
          select: { passkeyVerifiedAt: true },
        });
      });
      expect(sessionRow?.passkeyVerifiedAt).toBeNull();

      const rows = await outboxRowsFor(
        AUDIT_ACTION.AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH,
      );
      expect(rows).toHaveLength(1);
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(metadata.reason).toBe("presented_credential");
      expect(metadata.boundCredentialId).toBe(boundCredId);
      expect(metadata.presentedCredentialId).toBe(presentedCredId);
    },
  );

  it.skipIf(!redisAvailable)(
    "an oversized bound credential id is truncated and the audit row survives the real truncateMetadata",
    async () => {
      // C7's "the row survives" clause, proven through the REAL audit pipeline.
      // The route-tier test only checks what buildDenialMetadata computes, with
      // logAuditAsync mocked — it never exercises truncateMetadata's own byte
      // budget, so it cannot show the row escaping the all-or-nothing collapse
      // to `{_truncated, _originalSize}` that this bound exists to prevent.
      const longBoundCredId = "a".repeat(600);
      const credentialRowId = await insertCredential(
        userId,
        tenantId,
        longBoundCredId,
      );
      const token = await insertSession({
        provider: "webauthn",
        authCredentialId: credentialRowId,
        passkeyVerifiedAt: null,
      });

      const challengeId = generateChallengeId();
      await redis!.set(
        `webauthn:challenge:reauth:${userId}:${challengeId}`,
        "test-challenge",
        "EX",
        60,
      );

      const res = await reauthVerifyPOST(
        buildVerifyRequest(token, {
          credentialResponse: JSON.stringify({ id: `presented-${randomUUID()}` }),
          challengeId,
        }),
      );
      expect(res.status).toBe(403);

      const rows = await outboxRowsFor(
        AUDIT_ACTION.AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH,
      );
      expect(rows).toHaveLength(1);
      const metadata = rows[0].metadata as Record<string, unknown>;
      // The row is intact: truncateMetadata did not fire.
      expect(metadata._truncated).toBeUndefined();
      expect(metadata._originalSize).toBeUndefined();
      // …and the field carries the first 512 characters plus its marker.
      expect(metadata.boundCredentialId).toBe("a".repeat(512));
      expect(metadata.boundCredentialIdTruncated).toBe(true);
      expect(metadata.reason).toBe("presented_credential");
    },
  );

  it.skipIf(!redisAvailable)(
    "a binding owned by another user denies as no_binding and records no credential id",
    async () => {
      // Route step 1 captures boundCredentialId via the session's
      // `authCredential` RELATION JOIN (Session.authCredentialId =
      // WebAuthnCredential.id — the FK spans no user predicate, because
      // referential integrity runs outside RLS), while every other query on
      // the path is {id, userId}-scoped. So a row owned by a DIFFERENT user is
      // reachable by the join and by nothing else — which is why the route
      // checks the relation's userId and fails closed here, keeping the other
      // user's identifier out of this row.
      //
      // This case used to assert `credential_missing` instead. That reason is
      // NOT reachable this way, and in fact is not deterministically reachable
      // at this tier at all: for a same-user binding, any deletion that commits
      // before step 1's read has already nulled auth_credential_id via
      // ON DELETE SET NULL (→ no_binding), so `credential_missing` requires the
      // deletion to land between step 1's read and the {id, userId} lookup
      // inside the same transaction — a window this suite cannot schedule. The
      // route tier covers that reason with a mocked verifier.
      const otherTenantId = await ctx.createTenant();
      const otherUserId = await ctx.createUser(otherTenantId);
      const boundCredId = `bound-${randomUUID()}`;
      const credentialRowId = await insertCredential(
        otherUserId,
        otherTenantId,
        boundCredId,
      );
      const token = await insertSession({
        provider: "webauthn",
        authCredentialId: credentialRowId,
        passkeyVerifiedAt: null,
      });

      const challengeId = generateChallengeId();
      await redis!.set(
        `webauthn:challenge:reauth:${userId}:${challengeId}`,
        "test-challenge",
        "EX",
        60,
      );

      const res = await reauthVerifyPOST(
        buildVerifyRequest(token, {
          credentialResponse: JSON.stringify({ id: `presented-${randomUUID()}` }),
          challengeId,
        }),
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("PASSKEY_REAUTH_UNAVAILABLE");

      const rows = await outboxRowsFor(
        AUDIT_ACTION.AUTH_PASSKEY_REAUTH_UNAVAILABLE,
      );
      expect(rows).toHaveLength(1);
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(metadata.reason).toBe("no_binding");
      expect(metadata.boundCredentialId).toBeNull();
      // The point of the guard: the other user's identifier appears nowhere.
      expect(JSON.stringify(metadata)).not.toContain(boundCredId);

      await ctx.deleteTestData(otherTenantId);
    },
  );
});
