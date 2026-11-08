/**
 * Integration test (real DB): a revocation of a user's credentials and a mint
 * of a new one are serialized by the user's credential lock
 * (src/lib/auth/session/user-auth-serialization.ts). Each cell holds a
 * revocation open — the real `revokeUserAuthArtifactsInTx` run, uncommitted —
 * parks a mint behind it, observes the mint waiting on that transaction, and
 * commits. The mint must then find its proof gone and issue nothing. Its
 * control holds only the lock, no revocation, and the same mint must go
 * through: the refusal is the revocation's doing, not the parking's.
 *
 * Run (the outbox worker must not share this database — see CLAUDE.md):
 *   docker compose stop audit-outbox-worker retention-gc-worker
 *   npm run test:integration -- user-auth-serialization
 *   docker compose start audit-outbox-worker retention-gc-worker
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { createTestContext, Deferred, setBypassRlsGucs, type TestContext } from "./helpers";
import { createRaceHelpers } from "./race-helpers";

// No real mail from a sign-in's new-device check.
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));

import { revokeUserAuthArtifactsInTx } from "@/lib/auth/session/user-session-invalidation";
import {
  isSessionRowLive,
  lockUserAuthArtifacts,
  UserAuthRevokedError,
} from "@/lib/auth/session/user-auth-serialization";
import { createCappedSession } from "@/lib/auth/session/session-concurrency";
import { hashSessionToken } from "@/lib/auth/session/session-cache";
import { configuredSessionCookieName } from "@/lib/auth/session/cookie-name";
import { issueExtensionToken } from "@/lib/auth/tokens/extension-token";
import { createAuthorizationCode } from "@/lib/mcp/oauth-server";

describe("credential revocation vs. mint — real-DB integration", () => {
  let ctx: TestContext;
  let race: ReturnType<typeof createRaceHelpers>;
  let tenantId: string;
  let userId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    race = createRaceHelpers(ctx.su.pool);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    tenantId = await ctx.createTenant();
    userId = await ctx.createUser(tenantId);
  });

  afterEach(async () => {
    await ctx.deleteTestData(tenantId);
  });

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  /**
   * A transaction holding the user's credential lock — and, unless
   * `revoke: false`, having run the revocation (`before` first, as the admin
   * passkey revoke deletes the credential before it) — until `commit()`.
   */
  async function holdRevocation(opts: { revoke: boolean; before?: (tx: Prisma.TransactionClient) => Promise<void> }) {
    const entered = new Deferred<number>();
    const release = new Deferred();
    const done = ctx.su.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        await setBypassRlsGucs(tx);
        await lockUserAuthArtifacts(tx, userId);
        if (opts.revoke) {
          await opts.before?.(tx);
          await revokeUserAuthArtifactsInTx(tx, userId, { tenantFilter: {} });
        }
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        entered.resolve(pid);
        await release.promise;
      },
      { timeout: 30_000 },
    );
    done.catch((e: unknown) => entered.reject(e));
    const pid = await entered.promise;
    return {
      pid,
      async commit() {
        release.resolve();
        await done;
      },
    };
  }

  /** Start `mint`, see it wait on the held transaction, commit, and return how it settled. */
  async function mintBehind<T>(held: Awaited<ReturnType<typeof holdRevocation>>, mint: () => Promise<T>) {
    const pending = mint();
    pending.catch(() => {});
    await race.waitForBackendBlockedBy(held.pid);
    await held.commit();
    return pending;
  }

  // ─── Passkey sign-in vs. the passkey's revocation ───────────

  async function passkey(): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO webauthn_credentials (id, user_id, tenant_id, credential_id, public_key, device_type, created_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'pk', 'singleDevice', now())`,
      id, userId, tenantId, `cred-${randomUUID()}`,
    );
    return id;
  }

  const signIn = (credentialId: string, sessionToken: string) => () =>
    createCappedSession({
      userId,
      tenantId,
      sessionToken,
      expires: new Date(Date.now() + 60 * 60 * 1000),
      ip: null,
      userAgent: null,
      acceptLanguage: null,
      provider: "webauthn",
      passkeyVerifiedAt: new Date(),
      authCredentialId: credentialId,
    });

  async function sessionExists(rawToken: string): Promise<boolean> {
    const rows = await sql(`SELECT 1 FROM sessions WHERE session_token = $1`, hashSessionToken(rawToken));
    return rows.length > 0;
  }

  it("a passkey sign-in parked behind the passkey's revocation creates no session", async () => {
    const credentialId = await passkey();
    const token = randomUUID();
    const held = await holdRevocation({
      revoke: true,
      before: async (tx) => {
        await tx.webAuthnCredential.deleteMany({ where: { id: credentialId } });
      },
    });

    const settled = mintBehind(held, signIn(credentialId, token));
    await expect(settled).rejects.toBeInstanceOf(UserAuthRevokedError);
    expect(await sessionExists(token)).toBe(false);
  });

  it("control: the same sign-in parked behind the lock alone creates its session", async () => {
    const credentialId = await passkey();
    const token = randomUUID();
    const held = await holdRevocation({ revoke: false });

    await mintBehind(held, signIn(credentialId, token));
    expect(await sessionExists(token)).toBe(true);
  });

  // ─── Bridge-code exchange vs. the revocation consuming the code ─

  async function bridgeCode(): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO extension_bridge_codes (id, code_hash, user_id, tenant_id, scope, expires_at, created_at, cnf_jkt)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, 'passwords:read', now() + interval '5 min', now(), $5)`,
      id, randomUUID().replace(/-/g, ""), userId, tenantId, "j".repeat(43),
    );
    return id;
  }

  const exchange = (codeId: string) => () =>
    issueExtensionToken({
      userId,
      tenantId,
      scope: "passwords:read",
      cnfJkt: "j".repeat(43),
      // The exchange route's compare-and-set.
      consumeProof: async (tx) =>
        (await tx.extensionBridgeCode.updateMany({ where: { id: codeId, usedAt: null }, data: { usedAt: new Date() } }))
          .count === 1,
    });

  async function extensionTokenCount(): Promise<number> {
    const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM extension_tokens WHERE user_id = $1::uuid`, userId);
    return n;
  }

  it("a bridge-code exchange parked behind a revocation issues no token: the revocation consumed the code", async () => {
    const codeId = await bridgeCode();
    const held = await holdRevocation({ revoke: true });

    const settled = mintBehind(held, exchange(codeId));
    await expect(settled).rejects.toBeInstanceOf(UserAuthRevokedError);
    expect(await extensionTokenCount()).toBe(0);
  });

  it("control: the same exchange parked behind the lock alone issues its token", async () => {
    const codeId = await bridgeCode();
    const held = await holdRevocation({ revoke: false });

    await mintBehind(held, exchange(codeId));
    expect(await extensionTokenCount()).toBe(1);
  });

  // ─── Session-authenticated mint vs. the session's revocation ─

  async function sessionCookieRequest(): Promise<NextRequest> {
    const raw = randomUUID();
    await sql(
      `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires, created_at, last_active_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, now() + interval '1 day', now(), now())`,
      randomUUID(), hashSessionToken(raw), userId, tenantId,
    );
    return new NextRequest("http://localhost/api/mcp/authorize/consent", {
      method: "POST",
      headers: { cookie: `${configuredSessionCookieName()}=${raw}` },
    });
  }

  async function mcpClient(): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO mcp_clients (id, tenant_id, client_id, client_secret_hash, name, redirect_uris, allowed_scopes, is_active, created_by_id, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, '', $4, ARRAY['http://localhost/cb']::text[], 'credentials:list', true, $5::uuid, now(), now())`,
      id, tenantId, `cli-${id.slice(0, 16)}`, `test-mcp-client-${id.slice(0, 8)}`, userId,
    );
    return id;
  }

  const consent = (clientId: string, req: NextRequest) => () =>
    createAuthorizationCode({
      clientId,
      tenantId,
      userId,
      redirectUri: "http://localhost/cb",
      scope: "credentials:list",
      codeChallenge: "A".repeat(43),
      userProof: (tx) => isSessionRowLive(tx, req, userId),
    });

  async function authorizationCodeCount(): Promise<number> {
    const [{ n }] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM mcp_authorization_codes WHERE user_id = $1::uuid`, userId);
    return n;
  }

  it("an MCP consent parked behind a revocation creates no code: the consenting session is gone", async () => {
    const clientId = await mcpClient();
    const req = await sessionCookieRequest();
    const held = await holdRevocation({ revoke: true });

    const settled = mintBehind(held, consent(clientId, req));
    await expect(settled).rejects.toBeInstanceOf(UserAuthRevokedError);
    expect(await authorizationCodeCount()).toBe(0);
  });

  it("control: the same consent parked behind the lock alone creates its code", async () => {
    const clientId = await mcpClient();
    const req = await sessionCookieRequest();
    const held = await holdRevocation({ revoke: false });

    await mintBehind(held, consent(clientId, req));
    expect(await authorizationCodeCount()).toBe(1);
  });
});
