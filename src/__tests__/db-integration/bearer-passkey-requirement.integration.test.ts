/**
 * Bearer credentials under the tenant passkey requirement — real-DB
 * integration (api-key-passkey-requirement plan, acceptance criteria).
 *
 * In a tenant with `require_passkey = true` past its grace period, a member
 * without a WebAuthn credential is refused by every user-bound bearer
 * validator (API key, operator token, extension-row token) with 403
 * PASSKEY_REQUIRED, and each refused credential writes one
 * PASSKEY_ENFORCEMENT_BLOCKED outbox row per dedup window.
 *
 * Mocking policy:
 *   - Validators, `checkAuth`, `authOrToken`, DPoP verifier, audit: REAL.
 *   - `@/auth`: no session (the session boundary; next-auth's `auth()` does
 *     not run outside a Next.js request).
 *   - `@/lib/security/rate-limit`: REAL, except every limiter is constructed
 *     with `failClosedOnRedisError: false` — the fail-closed route limiters
 *     (metrics, refresh, AutoFill mint) would otherwise 503 without Redis.
 *     Route budgets are never reached: every test seeds fresh users and
 *     credentials, so no limiter key repeats across tests.
 *
 * Audit deltas are counted in `audit_outbox` by `tenant_id` and
 * `payload->>'action'`: logAuditAsync awaits the enqueue, so the row exists
 * once the handler resolves.
 *
 * Run (the outbox worker must not share this database — see CLAUDE.md):
 *   docker compose stop audit-outbox-worker retention-gc-worker
 *   npm run test:integration -- bearer-passkey-requirement
 *   docker compose start audit-outbox-worker retention-gc-worker
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
import { NextRequest } from "next/server";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { hashToken } from "@/lib/crypto/crypto-server";
import { computeAth } from "@/lib/auth/dpop/verify";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import {
  type TestKeypair,
  generateKeypair,
  makeProof,
} from "@/__tests__/helpers/dpop-test-keypair";
import { API_KEY_PREFIX } from "@/lib/constants/auth/api-key";
import { OPERATOR_TOKEN_PREFIX } from "@/lib/constants/auth/operator-token";
import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/constants/time";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";

vi.mock("@/auth", () => ({ auth: async () => null }));

vi.mock("@/lib/security/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security/rate-limit")>();
  return {
    ...actual,
    createRateLimiter: (options: Parameters<typeof actual.createRateLimiter>[0]) =>
      actual.createRateLimiter({ ...options, failClosedOnRedisError: false }),
  };
});

import { GET as v1PasswordsGET } from "@/app/api/v1/passwords/route";
import { GET as outboxMetricsGET } from "@/app/api/maintenance/audit-outbox-metrics/route";
import { GET as passwordsGET, POST as passwordsPOST } from "@/app/api/passwords/route";
import { GET as mobileFaviconGET } from "@/app/api/mobile/favicon/route";
import { POST as extensionRefreshPOST } from "@/app/api/extension/token/refresh/route";
import { DELETE as extensionTokenDELETE } from "@/app/api/extension/token/route";
import { POST as autofillTokenPOST } from "@/app/api/mobile/autofill-token/route";

const APP_URL = "https://app.example.test";
const GRACE_DAYS = 7;
const BLOCKED_ACTION = AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED;

type ClientKind = "BROWSER_EXTENSION" | "IOS_APP" | "IOS_AUTOFILL";

function makeOperatorTokenPlaintext(): string {
  // OPERATOR_TOKEN_PLAINTEXT_RE: /^op_[A-Za-z0-9_-]{43}$/
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let body = "";
  for (let i = 0; i < 43; i++) {
    body += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${OPERATOR_TOKEN_PREFIX}${body}`;
}

function bearerRequest(path: string, token: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** A DPoP-signed request with a fresh proof and jti on every call. */
async function dpopRequest(args: {
  kp: TestKeypair;
  token: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: string;
  body?: unknown;
}): Promise<NextRequest> {
  const htu = canonicalHtu({ route: args.path });
  const proof = await makeProof(args.kp, {
    jti: randomUUID(),
    htm: args.method,
    htu,
    iat: Math.floor(Date.now() / 1000),
    ath: computeAth(args.token),
  });
  return new NextRequest(args.query ? `${htu}?${args.query}` : htu, {
    method: args.method,
    headers: {
      authorization: `Bearer ${args.token}`,
      dpop: proof,
      ...(args.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  });
}

async function expectPasskeyRequired(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "PASSKEY_REQUIRED" });
}

describe("bearer credentials under the tenant passkey requirement (real DB)", () => {
  let ctx: TestContext;
  let tenantId: string;
  let userId: string;
  // Every tenant/user a test brought into existence, for afterEach.
  let tenantIds: string[];
  let userIds: string[];

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    vi.stubEnv("APP_URL", APP_URL);
    // T-10: reset first, then register each id immediately after it is
    // created — a throw from createUser (after createTenant succeeded)
    // must not leak a tenant that afterEach never learns about.
    tenantIds = [];
    userIds = [];
    tenantId = await ctx.createTenant();
    tenantIds.push(tenantId);
    userId = await ctx.createUser(tenantId);
    userIds.push(userId);
    // Default fixture: required, grace period expired one day ago.
    await setTenantPolicy(tenantId, {
      requirePasskey: true,
      enabledAt: new Date(Date.now() - (GRACE_DAYS + 1) * MS_PER_DAY),
      graceDays: GRACE_DAYS,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    // api_keys, extension_tokens and webauthn_credentials FK-Restrict their
    // tenant and are not removed by deleteTestData; a passkey seeded under a
    // second tenant names that tenant but a user of the first.
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      for (const table of ["extension_tokens", "api_keys", "webauthn_credentials"]) {
        await tx.$executeRawUnsafe(
          `DELETE FROM ${table}
            WHERE tenant_id = ANY($1::uuid[]) OR user_id = ANY($2::uuid[])`,
          tenantIds,
          userIds,
        );
      }
    });
    for (const id of tenantIds) {
      await ctx.deleteTestData(id);
    }
  });

  // ─── Seeders ─────────────────────────────────────────────────

  async function setTenantPolicy(
    id: string,
    policy: { requirePasskey: boolean; enabledAt: Date | null; graceDays: number | null },
  ): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenants
            SET require_passkey = $2,
                require_passkey_enabled_at = $3,
                passkey_grace_period_days = $4
          WHERE id = $1::uuid`,
        id,
        policy.requirePasskey,
        policy.enabledAt,
        policy.graceDays,
      );
    });
  }

  /** The `c13-deactivated-user-api-key` seeder. */
  async function seedApiKey(ownerId: string): Promise<{ id: string; token: string }> {
    const token = `${API_KEY_PREFIX}bpkr${randomUUID().replace(/-/g, "")}`;
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO api_keys
           (id, user_id, tenant_id, token_hash, prefix, name, scope, expires_at, created_at)
         VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, now())`,
        id,
        ownerId,
        tenantId,
        hashToken(token),
        token.slice(0, 8),
        "integration-test-key",
        "passwords:read",
        new Date(Date.now() + MS_PER_HOUR),
      );
    });
    return { id, token };
  }

  /** The `master-key-rotation-races` seeder. */
  async function seedOperatorToken(subjectId: string): Promise<{ id: string; token: string }> {
    const token = makeOperatorTokenPlaintext();
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO operator_tokens (
           id, token_hash, prefix, name, tenant_id, subject_user_id, created_by_user_id,
           scope, expires_at, created_at
         ) VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $6::uuid, 'maintenance', now() + interval '30 days', now())`,
        id,
        hashToken(token),
        token.slice(0, 8),
        `test-operator-${subjectId.slice(0, 8)}`,
        tenantId,
        subjectId,
      );
    });
    return { id, token };
  }

  /** The `cache-rollback-report-audit` insert, generalised over client kind. */
  async function seedExtensionToken(
    ownerId: string,
    clientKind: ClientKind,
    scope: string,
  ): Promise<{ id: string; token: string; kp: TestKeypair }> {
    const kp = await generateKeypair();
    const token = `ext_${randomUUID().replace(/-/g, "")}`;
    const id = randomUUID();
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO extension_tokens (
           id, user_id, tenant_id, token_hash, scope, expires_at,
           created_at, family_id, family_created_at,
           client_kind, device_pubkey, cnf_jkt
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now(), $7::uuid, now(),
           $8::"ExtensionTokenClientKind", $9, $10
         )`,
        id,
        ownerId,
        tenantId,
        hashToken(token),
        scope,
        new Date(Date.now() + MS_PER_DAY),
        randomUUID(),
        clientKind,
        clientKind === "IOS_APP" ? "test-device-pubkey-base64url" : null,
        kp.jkt,
      );
    });
    return { id, token, kp };
  }

  /** The `reauth-credential-binding` seeder. */
  async function seedPasskey(ownerId: string, credentialTenantId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO webauthn_credentials (
           id, user_id, tenant_id, credential_id, public_key, device_type, created_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, now())`,
        randomUUID(),
        ownerId,
        credentialTenantId,
        `cred-${randomUUID()}`,
        "test-public-key",
        "singleDevice",
      );
    });
  }

  async function deactivateMember(memberId: string): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now()
          WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        tenantId,
        memberId,
      );
    });
  }

  /** PASSKEY_ENFORCEMENT_BLOCKED rows in this tenant, optionally for one credential. */
  async function blockedRows(credentialId?: string): Promise<number> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM audit_outbox
          WHERE tenant_id = $1::uuid
            AND payload->>'action' = $2
            AND ($3::text IS NULL OR payload->'metadata'->>'credentialId' = $3::text)`,
        tenantId,
        BLOCKED_ACTION,
        credentialId ?? null,
      );
    });
    return rows[0].count;
  }

  async function extensionTokenCount(ownerId: string, clientKind: ClientKind): Promise<number> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM extension_tokens
          WHERE user_id = $1::uuid AND client_kind = $2::"ExtensionTokenClientKind"`,
        ownerId,
        clientKind,
      );
    });
    return rows[0].count;
  }

  async function revokedAtOf(tokenId: string): Promise<Date | null> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<{ revoked_at: Date | null }[]>(
        `SELECT revoked_at FROM extension_tokens WHERE id = $1::uuid`,
        tokenId,
      );
    });
    return rows[0].revoked_at;
  }

  // ─── API key ─────────────────────────────────────────────────

  describe("API key — GET /api/v1/passwords", () => {
    const callV1 = (token: string) =>
      v1PasswordsGET(bearerRequest("/api/v1/passwords", token));

    it("refuses a member without a passkey with 403 PASSKEY_REQUIRED", async () => {
      const key = await seedApiKey(userId);
      await expectPasskeyRequired(await callV1(key.token));
    });

    it("writes one blocked row per key, deduplicating a repeat and counting a second key", async () => {
      const key = await seedApiKey(userId);

      await expectPasskeyRequired(await callV1(key.token));
      expect(await blockedRows(key.id)).toBe(1);

      await expectPasskeyRequired(await callV1(key.token));
      expect(await blockedRows(key.id)).toBe(1);

      const second = await seedApiKey(userId);
      await expectPasskeyRequired(await callV1(second.token));
      expect(await blockedRows(second.id)).toBe(1);
      expect(await blockedRows()).toBe(2);
    });

    it("allows a member with a passkey", async () => {
      await seedPasskey(userId, tenantId);
      const key = await seedApiKey(userId);
      expect((await callV1(key.token)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("allows a member whose passkey is registered under another tenant", async () => {
      const otherTenantId = await ctx.createTenant();
      tenantIds.push(otherTenantId);
      await seedPasskey(userId, otherTenantId);
      const key = await seedApiKey(userId);
      expect((await callV1(key.token)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("allows inside the grace period (now − (grace−1) d)", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: true,
        enabledAt: new Date(Date.now() - (GRACE_DAYS - 1) * MS_PER_DAY),
        graceDays: GRACE_DAYS,
      });
      const key = await seedApiKey(userId);
      expect((await callV1(key.token)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("refuses past the grace period (now − (grace+1) d)", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: true,
        enabledAt: new Date(Date.now() - (GRACE_DAYS + 1) * MS_PER_DAY),
        graceDays: GRACE_DAYS,
      });
      const key = await seedApiKey(userId);
      await expectPasskeyRequired(await callV1(key.token));
    });

    it("allows when the tenant does not require a passkey", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: false,
        enabledAt: null,
        graceDays: null,
      });
      const key = await seedApiKey(userId);
      expect((await callV1(key.token)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("enforces immediately when require_passkey_enabled_at is NULL", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: true,
        enabledAt: null,
        graceDays: GRACE_DAYS,
      });
      const key = await seedApiKey(userId);
      await expectPasskeyRequired(await callV1(key.token));
    });
  });

  // ─── Operator token ──────────────────────────────────────────

  describe("operator token — GET /api/maintenance/audit-outbox-metrics", () => {
    const callMetrics = (token: string) =>
      outboxMetricsGET(bearerRequest("/api/maintenance/audit-outbox-metrics", token));

    it("refuses an operator without a passkey with 403 PASSKEY_REQUIRED", async () => {
      const op = await seedOperatorToken(userId);
      await expectPasskeyRequired(await callMetrics(op.token));
    });

    it("writes one blocked row per token, deduplicating a repeat and counting a second token", async () => {
      const op = await seedOperatorToken(userId);

      await expectPasskeyRequired(await callMetrics(op.token));
      expect(await blockedRows(op.id)).toBe(1);

      await expectPasskeyRequired(await callMetrics(op.token));
      expect(await blockedRows(op.id)).toBe(1);

      const second = await seedOperatorToken(userId);
      await expectPasskeyRequired(await callMetrics(second.token));
      expect(await blockedRows(second.id)).toBe(1);
      expect(await blockedRows()).toBe(2);
    });

    it("refuses a departed operator with 401 and writes no blocked row", async () => {
      const op = await seedOperatorToken(userId);
      await deactivateMember(userId);
      const res = await callMetrics(op.token);
      expect(res.status).toBe(401);
      expect(await blockedRows()).toBe(0);
    });

    it("allows an operator with a passkey", async () => {
      await seedPasskey(userId, tenantId);
      const op = await seedOperatorToken(userId);
      expect((await callMetrics(op.token)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    // T-5: the grace/off/other-tenant cells below are the API key describe
    // block's equivalents, run for the operator token too.

    it("allows an operator whose passkey is registered under another tenant", async () => {
      const otherTenantId = await ctx.createTenant();
      tenantIds.push(otherTenantId);
      await seedPasskey(userId, otherTenantId);
      const op = await seedOperatorToken(userId);
      expect((await callMetrics(op.token)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("allows inside the grace period (now − (grace−1) d)", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: true,
        enabledAt: new Date(Date.now() - (GRACE_DAYS - 1) * MS_PER_DAY),
        graceDays: GRACE_DAYS,
      });
      const op = await seedOperatorToken(userId);
      expect((await callMetrics(op.token)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("allows when the tenant does not require a passkey", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: false,
        enabledAt: null,
        graceDays: null,
      });
      const op = await seedOperatorToken(userId);
      expect((await callMetrics(op.token)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("enforces immediately when require_passkey_enabled_at is NULL", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: true,
        enabledAt: null,
        graceDays: GRACE_DAYS,
      });
      const op = await seedOperatorToken(userId);
      await expectPasskeyRequired(await callMetrics(op.token));
    });
  });

  // ─── Extension-row tokens ────────────────────────────────────

  describe("extension token", () => {
    const listPasswords = async (ext: { token: string; kp: TestKeypair }) =>
      passwordsGET(
        await dpopRequest({ ...ext, method: "GET", path: "/api/passwords" }),
      );

    it("refuses a vault API call through checkAuth (GET /api/passwords) with 403 PASSKEY_REQUIRED", async () => {
      const ext = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");
      await expectPasskeyRequired(await listPasswords(ext));
    });

    it("writes one blocked row per token, deduplicating a repeat and counting a second token", async () => {
      const ext = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");

      await expectPasskeyRequired(await listPasswords(ext));
      expect(await blockedRows(ext.id)).toBe(1);

      // A fresh proof and jti: a replayed jti would be refused before the
      // gate and keep the count at one without the limiter.
      await expectPasskeyRequired(await listPasswords(ext));
      expect(await blockedRows(ext.id)).toBe(1);

      const second = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");
      await expectPasskeyRequired(await listPasswords(second));
      expect(await blockedRows(second.id)).toBe(1);
      expect(await blockedRows()).toBe(2);
    });

    it("refuses GET /api/mobile/favicon with 403 PASSKEY_REQUIRED", async () => {
      const ext = await seedExtensionToken(userId, "IOS_APP", "passwords:read,passwords:write");
      const res = await mobileFaviconGET(
        await dpopRequest({
          ...ext,
          method: "GET",
          path: "/api/mobile/favicon",
          query: "host=example.com&size=32",
        }),
      );
      await expectPasskeyRequired(res);
    });

    it("refuses POST /api/extension/token/refresh with 403 PASSKEY_REQUIRED and mints nothing", async () => {
      const ext = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");
      const before = await extensionTokenCount(userId, "BROWSER_EXTENSION");
      const res = await extensionRefreshPOST(
        await dpopRequest({ ...ext, method: "POST", path: "/api/extension/token/refresh" }),
      );
      await expectPasskeyRequired(res);
      expect(await extensionTokenCount(userId, "BROWSER_EXTENSION")).toBe(before);
      // T-6: the refusal must not revoke the presented token — only the
      // self-revocation route (below) does that.
      expect(await revokedAtOf(ext.id)).toBeNull();
    });

    it("lets a blocked member revoke their own token (DELETE /api/extension/token)", async () => {
      const ext = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");
      const res = await extensionTokenDELETE(
        await dpopRequest({ ...ext, method: "DELETE", path: "/api/extension/token" }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await revokedAtOf(ext.id)).not.toBeNull();
      // The exemption skips the gate entirely, so nothing is audited as blocked.
      expect(await blockedRows()).toBe(0);
    });

    it("allows a member with a passkey through checkAuth and refresh", async () => {
      await seedPasskey(userId, tenantId);
      const ext = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");
      expect((await listPasswords(ext)).status).toBe(200);

      const res = await extensionRefreshPOST(
        await dpopRequest({ ...ext, method: "POST", path: "/api/extension/token/refresh" }),
      );
      expect(res.status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    // T-5: the grace/off/other-tenant cells below are the API key describe
    // block's equivalents, run for the extension token too.

    it("allows a member whose passkey is registered under another tenant", async () => {
      const otherTenantId = await ctx.createTenant();
      tenantIds.push(otherTenantId);
      await seedPasskey(userId, otherTenantId);
      const ext = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");
      expect((await listPasswords(ext)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("allows inside the grace period (now − (grace−1) d)", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: true,
        enabledAt: new Date(Date.now() - (GRACE_DAYS - 1) * MS_PER_DAY),
        graceDays: GRACE_DAYS,
      });
      const ext = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");
      expect((await listPasswords(ext)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("allows when the tenant does not require a passkey", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: false,
        enabledAt: null,
        graceDays: null,
      });
      const ext = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");
      expect((await listPasswords(ext)).status).toBe(200);
      expect(await blockedRows()).toBe(0);
    });

    it("enforces immediately when require_passkey_enabled_at is NULL", async () => {
      await setTenantPolicy(tenantId, {
        requirePasskey: true,
        enabledAt: null,
        graceDays: GRACE_DAYS,
      });
      const ext = await seedExtensionToken(userId, "BROWSER_EXTENSION", "passwords:read");
      await expectPasskeyRequired(await listPasswords(ext));
    });
  });

  // ─── iOS AutoFill ────────────────────────────────────────────

  describe("iOS AutoFill", () => {
    const mint = async (host: { token: string; kp: TestKeypair }) => {
      // A real JWK: with the gate removed, this request reaches the mint.
      const extensionKey = await generateKeypair();
      return autofillTokenPOST(
        await dpopRequest({
          ...host,
          method: "POST",
          path: "/api/mobile/autofill-token",
          body: { jwk: extensionKey.publicJwk },
        }),
      );
    };

    it("refuses the mint with an IOS_APP token with 403 PASSKEY_REQUIRED and mints nothing", async () => {
      const host = await seedExtensionToken(userId, "IOS_APP", "passwords:read,passwords:write");
      const before = await extensionTokenCount(userId, "IOS_AUTOFILL");
      await expectPasskeyRequired(await mint(host));
      expect(await extensionTokenCount(userId, "IOS_AUTOFILL")).toBe(before);
    });

    it("refuses an upload (POST /api/passwords) with an IOS_AUTOFILL token with 403 PASSKEY_REQUIRED", async () => {
      const upload = await seedExtensionToken(userId, "IOS_AUTOFILL", "passwords:write");
      const res = await passwordsPOST(
        await dpopRequest({ ...upload, method: "POST", path: "/api/passwords", body: {} }),
      );
      await expectPasskeyRequired(res);
    });

    it("mints for a member with a passkey", async () => {
      await seedPasskey(userId, tenantId);
      const host = await seedExtensionToken(userId, "IOS_APP", "passwords:read,passwords:write");
      const before = await extensionTokenCount(userId, "IOS_AUTOFILL");
      expect((await mint(host)).status).toBe(201);
      expect(await extensionTokenCount(userId, "IOS_AUTOFILL")).toBe(before + 1);
    });
  });
});
