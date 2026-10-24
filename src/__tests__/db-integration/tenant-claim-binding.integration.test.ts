/**
 * Real-DB coverage for claim provenance and the binding adjudicator — plan
 * sso-claim-connection-binding, C3 (schema), C4 and C5.
 *
 * Every sign-in cell runs through a production entry point on the app role:
 * the real signIn callback (captured from the `NextAuth(...)` config) for an
 * existing user, and the callback followed by the adapter's `createUser`, both
 * under `tenantClaimStorage.run`, for a first-ever sign-in — the order Auth.js
 * calls them in. The binding mode is never passed in: each cell stubs the env
 * and the code under test derives it, as production does.
 *
 * The outbox worker must be stopped (setup.ts refuses otherwise), so a denial's
 * audit row is read from `audit_outbox`, the upstream table.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const { nextAuthConfigs } = vi.hoisted(() => ({ nextAuthConfigs: [] as unknown[] }));

// See audit-sentinel-claim-denial.integration.test.ts for why `next-auth`
// itself is mocked. The config handed to it is kept: its signIn callback is
// the production entry point the existing-user cells drive.
vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    nextAuthConfigs.push(config);
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import {
  createPrismaForRole,
  createTestContext,
  raceTwoClients,
  setBypassRlsGucs,
  type PrismaWithPool,
  type TestContext,
} from "./helpers";
import { runToken } from "@/__tests__/helpers/tenant-claim-fixtures";
import "@/auth";
import { createCustomAdapter } from "@/lib/auth/session/auth-adapter";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";
import { sessionMetaStorage, type SessionMeta } from "@/lib/auth/session/session-meta";
import { findOrCreateTenantForClaim } from "@/lib/tenant/tenant-management";
import {
  CLAIM_BINDING_MODE,
  PROVIDER_ID_PATTERN,
  isProviderIdShape,
  type ClaimBindingMode,
} from "@/lib/auth/jackson-providers";
import { providerRef, resetIdentifierPepperForTests } from "@/lib/audit/identifier-pepper";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { DEREGISTER_ACTOR_LABEL, TENANT_CLAIM_EVENT_OPERATION } from "@/lib/tenant/tenant-claim-event";
import * as loggerModule from "@/lib/logger";

type SignInParams = {
  user: { id?: string; email?: string | null };
  account: { provider: string; type: "oidc"; providerAccountId: string } | null;
  profile: Record<string, unknown> | null;
};
type SignInCallback = (params: SignInParams) => Promise<boolean>;

function capturedSignIn(): SignInCallback {
  const config = nextAuthConfigs[0] as { callbacks?: { signIn?: SignInCallback } } | undefined;
  const signIn = config?.callbacks?.signIn;
  if (!signIn) throw new Error("src/auth.ts did not hand NextAuth a signIn callback");
  return signIn;
}

const PEPPER = "binding-integration-pepper-0123456789abcdef";
/** The provider every grid sign-in presents. */
const SIGN_IN_PROVIDER = "saml-jackson-alpha";
/** Another customer's connection: a row bound here is "bound-other". */
const OTHER_PROVIDER = "saml-jackson-bravo";

/** Env for a derived mode, with only the variables the derivation reads set. */
function stubModeEnv(mode: ClaimBindingMode): void {
  for (const key of [
    "AUTH_GOOGLE_ID",
    "AUTH_GOOGLE_SECRET",
    "AUTH_JACKSON_ID",
    "AUTH_JACKSON_SECRET",
    "AUTH_JACKSON_CONNECTIONS",
    "JACKSON_URL",
    "AUTH_CLAIM_BINDING",
  ]) {
    vi.stubEnv(key, "");
  }
  // One claim provider either way, so the mode is the variable's: strict is
  // opted into, off is the default.
  vi.stubEnv("AUTH_GOOGLE_ID", "binding-test-google-id");
  vi.stubEnv("AUTH_GOOGLE_SECRET", "binding-test-google-secret");
  if (mode === CLAIM_BINDING_MODE.STRICT) vi.stubEnv("AUTH_CLAIM_BINDING", "strict");
}

const ROW_STATE = {
  BOUND_SAME: "bound-same",
  BOUND_OTHER: "bound-other",
  UNBOUND: "unbound",
} as const;
type RowState = (typeof ROW_STATE)[keyof typeof ROW_STATE];

const ROW_PROVIDER = {
  "bound-same": SIGN_IN_PROVIDER,
  "bound-other": OTHER_PROVIDER,
  unbound: null,
} as const satisfies Record<RowState, string | null>;

type Expected =
  | { kind: "allow" }
  | { kind: "refuse"; reason: "tenant_claim_unbound" | "tenant_claim_provider_mismatch" };

/** The grid's verdicts (row state × mode); the path must not change them. */
const VERDICT = {
  off: {
    "bound-same": { kind: "allow" },
    "bound-other": { kind: "allow" },
    unbound: { kind: "allow" },
  },
  strict: {
    "bound-same": { kind: "allow" },
    "bound-other": { kind: "refuse", reason: "tenant_claim_provider_mismatch" },
    unbound: { kind: "refuse", reason: "tenant_claim_unbound" },
  },
} as const satisfies Record<ClaimBindingMode, Record<RowState, Expected>>;

const PATH = { EXISTING_USER: "existing-user", FIRST_SIGN_IN: "first-sign-in" } as const;
type Path = (typeof PATH)[keyof typeof PATH];

type OutboxRow = { tenant_id: string; metadata: Record<string, unknown>; row_text: string };

describe("tenant claim binding (C3/C4/C5)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", PEPPER);
    resetIdentifierPepperForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetIdentifierPepperForTests();
  });

  function freshClaim(arm: string): string {
    return `bind-${arm}-${runToken()}.example`;
  }

  async function bindClaim(tenantId: string, claim: string, provider: string | null): Promise<void> {
    await ctx.su.prisma.tenantClaim.create({
      data: { tenantId, claim, createdBy: "binding-integration-test", provider },
    });
  }

  async function outboxRowsForClaim(claim: string): Promise<OutboxRow[]> {
    return ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<OutboxRow[]>(
        `SELECT tenant_id::text, payload->'metadata' AS metadata, row_to_json(o)::text AS row_text
           FROM audit_outbox o
          WHERE payload->>'action' = 'AUTH_LOGIN_FAILURE'
            AND payload->'metadata'->>'claim' = $1`,
        claim,
      );
    });
  }

  /** Every row a sign-in could have written for this claim, user and owner. */
  async function snapshot(claim: string, email: string, ownerTenantId: string) {
    const [row] = await ctx.su.prisma.$queryRaw<
      { users: bigint; tenants: bigint; members: bigint; claims: bigint; events: bigint }[]
    >`
      SELECT
        (SELECT COUNT(*) FROM users WHERE email = ${email})::bigint AS users,
        (SELECT COUNT(*) FROM tenants WHERE name = ${claim})::bigint AS tenants,
        (SELECT COUNT(*) FROM tenant_members WHERE tenant_id = ${ownerTenantId}::uuid)::bigint AS members,
        (SELECT COUNT(*) FROM tenant_claims WHERE claim = ${claim})::bigint AS claims,
        (SELECT COUNT(*) FROM tenant_claim_events WHERE claim = ${claim})::bigint AS events
    `;
    return {
      users: Number(row!.users),
      tenants: Number(row!.tenants),
      members: Number(row!.members),
      claims: Number(row!.claims),
      events: Number(row!.events),
    };
  }

  async function emailOf(userId: string): Promise<string> {
    const user = await ctx.su.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    if (!user.email) throw new Error("fixture user has no email");
    return user.email;
  }

  function signInParams(email: string, claim: string, provider = SIGN_IN_PROVIDER): SignInParams {
    return {
      user: { id: "pre-generated-id", email },
      account: { provider, type: "oidc", providerAccountId: `subject-${randomUUID()}` },
      profile: { tenant_id: claim },
    };
  }

  /**
   * A first-ever sign-in as Auth.js runs it: the signIn callback stores the
   * claim, then the adapter creates the user. Returns whether it was allowed.
   */
  async function firstSignIn(email: string, claim: string, provider = SIGN_IN_PROVIDER): Promise<boolean> {
    const meta: SessionMeta = { ip: null, userAgent: null, acceptLanguage: null, provider: null };
    return sessionMetaStorage.run(meta, () =>
      tenantClaimStorage.run({ tenantClaim: null, provider: null }, async () => {
        const allowed = await capturedSignIn()(signInParams(email, claim, provider));
        if (!allowed) return false;
        const createUser = createCustomAdapter().createUser;
        if (!createUser) throw new Error("createCustomAdapter() did not implement createUser");
        try {
          await createUser({ id: "unused", name: null, email, emailVerified: null, image: null });
          return true;
        } catch (error) {
          if (error instanceof Error && error.message === "TENANT_CLAIM_UNUSABLE") return false;
          throw error;
        }
      }),
    );
  }

  async function signIn(path: Path, claim: string, ownerTenantId: string): Promise<{ allowed: boolean; email: string }> {
    if (path === PATH.EXISTING_USER) {
      const userId = await ctx.createUser(ownerTenantId);
      const email = await emailOf(userId);
      return { allowed: await capturedSignIn()(signInParams(email, claim)), email };
    }
    const email = `bind-${randomUUID()}@example.invalid`;
    return { allowed: await firstSignIn(email, claim), email };
  }

  const GRID = (Object.keys(VERDICT) as ClaimBindingMode[]).flatMap((mode) =>
    (Object.values(ROW_STATE) as RowState[]).flatMap((rowState) =>
      (Object.values(PATH) as Path[]).map((path) => [mode, rowState, path] as const),
    ),
  );

  it.each(GRID)("%s mode, %s row, %s", async (mode, rowState, path) => {
    stubModeEnv(mode);
    const owner = await ctx.createTenant();
    const claim = freshClaim(`${mode}-${rowState}-${path}`);
    await bindClaim(owner, claim, ROW_PROVIDER[rowState]);
    try {
      const expected: Expected = VERDICT[mode][rowState];
      if (expected.kind === "allow") {
        const { allowed, email } = await signIn(path, claim, owner);
        expect(allowed).toBe(true);
        const member = await ctx.su.prisma.$queryRaw<{ n: bigint }[]>`
          SELECT COUNT(*)::bigint AS n FROM tenant_members m JOIN users u ON u.id = m.user_id
           WHERE u.email = ${email} AND m.tenant_id = ${owner}::uuid AND m.deactivated_at IS NULL
        `;
        expect(Number(member[0]!.n)).toBe(1);
        expect(await outboxRowsForClaim(claim)).toHaveLength(0);
        return;
      }

      // The existing user is a fixture written before the sign-in; snapshot
      // after it exists so the delta measures the sign-in alone.
      const userId = path === PATH.EXISTING_USER ? await ctx.createUser(owner) : null;
      const email = userId ? await emailOf(userId) : `bind-${randomUUID()}@example.invalid`;
      const before = await snapshot(claim, email, owner);
      const allowed =
        path === PATH.EXISTING_USER
          ? await capturedSignIn()(signInParams(email, claim))
          : await firstSignIn(email, claim);
      expect(allowed).toBe(false);
      expect(await snapshot(claim, email, owner)).toEqual(before);

      const rows = await outboxRowsForClaim(claim);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.tenant_id).toBe(owner);
      expect(row.metadata.reason).toBe(expected.reason);
      expect(row.metadata.signInProviderRef).toBe(providerRef(SIGN_IN_PROVIDER, Buffer.from(PEPPER, "utf8")));
      expect(row.metadata).toHaveProperty("boundProvider", ROW_PROVIDER[rowState]);
      // The raw sign-in provider id appears nowhere in the row, while the
      // raw bound provider (that tenant's own binding) does — the control
      // that the text search can see a provider id at all.
      expect(row.row_text).not.toContain(SIGN_IN_PROVIDER);
      if (rowState === ROW_STATE.BOUND_OTHER) expect(row.row_text).toContain(OTHER_PROVIDER);
    } finally {
      await ctx.deleteTestData(owner);
    }
  });

  it("strict, Google: a row bound to google resolves a google sign-in", async () => {
    stubModeEnv(CLAIM_BINDING_MODE.STRICT);
    const owner = await ctx.createTenant();
    const claim = freshClaim("google-strict");
    await bindClaim(owner, claim, "google");
    try {
      const email = `bind-${randomUUID()}@example.invalid`;
      expect(await firstSignIn(email, claim, "google")).toBe(true);
      const user = await ctx.su.prisma.user.findUnique({ where: { email }, select: { tenantId: true } });
      expect(user?.tenantId).toBe(owner);
    } finally {
      await ctx.deleteTestData(owner);
    }
  });

  it.each([CLAIM_BINDING_MODE.OFF, CLAIM_BINDING_MODE.STRICT])(
    "%s mode: first registration binds the claim to the presenting provider, row and event",
    async (mode) => {
      stubModeEnv(mode);
      const claim = freshClaim(`register-${mode}`);
      const email = `bind-${randomUUID()}@example.invalid`;
      let created: string | null = null;
      try {
        expect(await firstSignIn(email, claim)).toBe(true);
        const row = await ctx.su.prisma.tenantClaim.findUniqueOrThrow({ where: { claim } });
        created = row.tenantId;
        ctx.trackTenant(created);
        expect(row.provider).toBe(SIGN_IN_PROVIDER);
        const events = await ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim } });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
          oldProvider: null,
          newProvider: SIGN_IN_PROVIDER,
        });
      } finally {
        if (created) await ctx.deleteTestData(created);
      }
    },
  );

  it("without a pepper the refusal row stores no ref, and still names the binding", async () => {
    stubModeEnv(CLAIM_BINDING_MODE.STRICT);
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", "");
    vi.stubEnv("AUTH_SECRET", "");
    resetIdentifierPepperForTests();
    const owner = await ctx.createTenant();
    const claim = freshClaim("no-pepper");
    await bindClaim(owner, claim, OTHER_PROVIDER);
    try {
      expect(await firstSignIn(`bind-${randomUUID()}@example.invalid`, claim)).toBe(false);
      const [row] = await outboxRowsForClaim(claim);
      expect(row?.metadata.reason).toBe("tenant_claim_provider_mismatch");
      expect(row?.metadata.boundProvider).toBe(OTHER_PROVIDER);
      expect(row?.metadata).not.toHaveProperty("signInProviderRef");
      expect(row?.row_text).not.toContain(SIGN_IN_PROVIDER);
    } finally {
      await ctx.deleteTestData(owner);
    }
  });

  describe("off-mode mismatch warning", () => {
    function spyWarn() {
      const warn = vi.fn();
      const real = loggerModule.getLogger();
      vi.spyOn(loggerModule, "getLogger").mockReturnValue(
        new Proxy(real, {
          get: (target, key) => (key === "warn" ? warn : Reflect.get(target, key)),
        }),
      );
      return warn;
    }

    it.each([
      [ROW_STATE.BOUND_OTHER, true],
      [ROW_STATE.BOUND_SAME, false],
      [ROW_STATE.UNBOUND, false],
    ] as const)("a %s row: warned=%s", async (rowState, warned) => {
      stubModeEnv(CLAIM_BINDING_MODE.OFF);
      const owner = await ctx.createTenant();
      const claim = freshClaim(`warn-${rowState}`);
      await bindClaim(owner, claim, ROW_PROVIDER[rowState]);
      const warn = spyWarn();
      try {
        expect(await firstSignIn(`bind-${randomUUID()}@example.invalid`, claim)).toBe(true);
        const calls = warn.mock.calls.filter(([, msg]) => msg === "auth.tenant_claim.provider_mismatch");
        if (!warned) {
          expect(calls).toHaveLength(0);
          return;
        }
        expect(calls).toHaveLength(1);
        // Provider ids and the tenant only — never the claim.
        expect(calls[0]![0]).toEqual({
          tenantId: owner,
          boundProvider: OTHER_PROVIDER,
          signInProvider: SIGN_IN_PROVIDER,
        });
      } finally {
        await ctx.deleteTestData(owner);
      }
    });
  });

  describe("C5: the provider travels with the claim", () => {
    async function createUserUnder(store: { tenantClaim: string; provider: string | null }, metaProvider: string | null) {
      const meta: SessionMeta = { ip: null, userAgent: null, acceptLanguage: null, provider: metaProvider };
      const createUser = createCustomAdapter().createUser;
      if (!createUser) throw new Error("createCustomAdapter() did not implement createUser");
      const email = `bind-${randomUUID()}@example.invalid`;
      let caught: unknown = null;
      await sessionMetaStorage.run(meta, () =>
        tenantClaimStorage.run(store, async () => {
          try {
            await createUser({ id: "unused", name: null, email, emailVerified: null, image: null });
          } catch (error) {
            caught = error;
          }
        }),
      );
      return { email, caught };
    }

    it.each([
      ["a claim with no provider", null, null],
      ["a session meta naming another provider", SIGN_IN_PROVIDER, OTHER_PROVIDER],
    ] as const)("refuses %s with provider_error and writes nothing", async (_label, storeProvider, metaProvider) => {
      stubModeEnv(CLAIM_BINDING_MODE.OFF);
      const owner = await ctx.createTenant();
      const claim = freshClaim("c5");
      await bindClaim(owner, claim, SIGN_IN_PROVIDER);
      try {
        const before = await snapshot(claim, "", owner);
        const { email, caught } = await createUserUnder({ tenantClaim: claim, provider: storeProvider }, metaProvider);
        expect((caught as Error | null)?.message).toBe("TENANT_CLAIM_UNUSABLE");
        expect(await ctx.su.prisma.user.count({ where: { email } })).toBe(0);
        expect(await snapshot(claim, "", owner)).toEqual(before);
        const [row] = await outboxRowsForClaim(claim);
        expect(row?.metadata.reason).toBe("provider_error");
      } finally {
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.$executeRawUnsafe(
            `UPDATE audit_outbox SET status = 'FAILED'::"AuditOutboxStatus"
              WHERE payload->'metadata'->>'claim' = $1 AND status IN ('PENDING', 'PROCESSING')`,
            claim,
          );
          await tx.$executeRawUnsafe(`DELETE FROM audit_outbox WHERE payload->'metadata'->>'claim' = $1`, claim);
        });
        await ctx.deleteTestData(owner);
      }
    });

    it.each([
      ["agrees", SIGN_IN_PROVIDER],
      ["is absent", null],
    ] as const)("allows when the session meta %s", async (_label, metaProvider) => {
      stubModeEnv(CLAIM_BINDING_MODE.STRICT);
      const owner = await ctx.createTenant();
      const claim = freshClaim("c5-allow");
      await bindClaim(owner, claim, SIGN_IN_PROVIDER);
      try {
        const { email, caught } = await createUserUnder({ tenantClaim: claim, provider: SIGN_IN_PROVIDER }, metaProvider);
        expect(caught).toBeNull();
        const user = await ctx.su.prisma.user.findUnique({ where: { email }, select: { tenantId: true } });
        expect(user?.tenantId).toBe(owner);
      } finally {
        await ctx.deleteTestData(owner);
      }
    });
  });

  describe("concurrent first registration through two providers", () => {
    let second: PrismaWithPool;

    beforeAll(() => {
      second = createPrismaForRole("app");
    });

    afterAll(async () => {
      await second.prisma.$disconnect().then(() => second.pool.end());
    });

    it("one tenant, one binding; the loser gets claim_provider_mismatch", async () => {
      const ITERATIONS = 50;
      const register = (provider: string, claim: string) => (c: PrismaClient) =>
        withBypassRls(
          c,
          (tx) => findOrCreateTenantForClaim(claim, provider, CLAIM_BINDING_MODE.STRICT, tx),
          BYPASS_GRANT.AUTH_CREATE_USER,
        );

      for (let i = 0; i < ITERATIONS; i++) {
        const claim = freshClaim(`race-${i}`);
        const [a, b] = await raceTwoClients(
          ctx.app.prisma,
          second.prisma,
          register(SIGN_IN_PROVIDER, claim),
          register(OTHER_PROVIDER, claim),
        );
        const winner = a.kind === "tenant" ? a : b.kind === "tenant" ? b : null;
        if (!winner || winner.kind !== "tenant") {
          throw new Error(`iteration ${i}: no registration won (${a.kind}, ${b.kind})`);
        }
        ctx.trackTenant(winner.id);
        try {
          const loser = winner === a ? b : a;
          const winnerProvider = winner === a ? SIGN_IN_PROVIDER : OTHER_PROVIDER;
          expect(loser).toEqual({
            kind: "claim_provider_mismatch",
            tenantId: winner.id,
            boundProvider: winnerProvider,
          });
          const rows = await ctx.su.prisma.tenantClaim.findMany({ where: { claim } });
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ tenantId: winner.id, provider: winnerProvider });
          expect(await ctx.su.prisma.tenant.count({ where: { name: claim } })).toBe(1);
          expect(await ctx.su.prisma.tenantClaimEvent.count({ where: { claim } })).toBe(1);
        } finally {
          await ctx.deleteTestData(winner.id);
        }
      }
    });
  });

  describe("schema", () => {
    it("passwd_app may INSERT the two provider columns of tenant_claim_events, and not seq", async () => {
      const [row] = await ctx.su.prisma.$queryRaw<{ old: boolean; new: boolean; seq: boolean }[]>`
        SELECT
          has_column_privilege('passwd_app', 'public.tenant_claim_events', 'old_provider', 'INSERT') AS old,
          has_column_privilege('passwd_app', 'public.tenant_claim_events', 'new_provider', 'INSERT') AS new,
          has_column_privilege('passwd_app', 'public.tenant_claim_events', 'seq', 'INSERT') AS seq
      `;
      expect(row).toEqual({ old: true, new: true, seq: false });
    });

    /**
     * One corpus through the TS predicate and through each live CHECK, by
     * attempting the write: the verdict is whatever PostgreSQL enforces, and
     * the constraint text is read back from pg_constraint to tie each verdict
     * to the pattern constant.
     */
    const LONGEST_GENERABLE = `saml-jackson-${"a".repeat(32)}`;
    const CORPUS: ReadonlyArray<readonly [string, string]> = [
      ["empty", ""],
      ["64 chars", "a".repeat(64)],
      ["65 chars", "a".repeat(65)],
      ["uppercase", "Saml-jackson"],
      ["underscore", "saml_jackson"],
      ["trailing newline", "saml-jackson\n"],
      ["non-ASCII", "saml-jackson-é"],
      ["longest generable id", LONGEST_GENERABLE],
      ["google", "google"],
    ];

    const CHECKS = [
      ["tenant_claims", "tenant_claims_provider_check", "provider"],
      ["tenant_claim_events", "tenant_claim_events_old_provider_check", "old_provider"],
      ["tenant_claim_events", "tenant_claim_events_new_provider_check", "new_provider"],
    ] as const;

    it.each(CHECKS)("%s.%s states PROVIDER_ID_PATTERN", async (table, constraint) => {
      const [row] = await ctx.su.prisma.$queryRaw<{ def: string }[]>`
        SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
         WHERE c.conname = ${constraint} AND c.conrelid = ${`public.${table}`}::regclass
      `;
      expect(row?.def).toContain(`'${PROVIDER_ID_PATTERN}'`);
    });

    it.each(CHECKS)("%s %s: the live CHECK agrees with isProviderIdShape on the corpus", async (table, _c, column) => {
      const tenantId = await ctx.createTenant();
      try {
        for (const [label, value] of CORPUS) {
          let accepted: boolean;
          try {
            await ctx.su.prisma.$transaction(async (tx) => {
              await setBypassRlsGucs(tx);
              if (table === "tenant_claims") {
                await tx.$executeRawUnsafe(
                  `INSERT INTO tenant_claims (id, tenant_id, claim, provider) VALUES ($1::uuid, $2::uuid, $3, $4)`,
                  randomUUID(),
                  tenantId,
                  freshClaim("parity"),
                  value,
                );
              } else {
                await tx.$executeRawUnsafe(
                  `INSERT INTO tenant_claim_events
                     (id, claim, operation, old_tenant_id, new_tenant_id, actor_label, ${column})
                   VALUES (gen_random_uuid(), $1, 'register', NULL, $2::uuid, 'binding-parity', $3)`,
                  freshClaim("parity"),
                  tenantId,
                  value,
                );
              }
              // Roll back every accepted write: the events table is
              // append-only, so nothing may commit.
              throw new RolledBack();
            });
            accepted = false;
          } catch (error) {
            accepted = error instanceof RolledBack;
          }
          expect(accepted, `${label} (${JSON.stringify(value)})`).toBe(isProviderIdShape(value));
        }
      } finally {
        await ctx.deleteTestData(tenantId);
      }
    });

    it("the deregister trigger copies the deleted row's provider", async () => {
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("deregister");
      await bindClaim(tenantId, claim, OTHER_PROVIDER);
      try {
        await ctx.su.prisma.tenantClaim.delete({ where: { claim } });
        const events = await ctx.su.prisma.tenantClaimEvent.findMany({
          where: { claim, operation: TENANT_CLAIM_EVENT_OPERATION.DEREGISTER },
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actorLabel: DEREGISTER_ACTOR_LABEL,
          oldTenantId: tenantId,
          oldProvider: OTHER_PROVIDER,
          newProvider: null,
        });
      } finally {
        await ctx.deleteTestData(tenantId);
      }
    });
  });

  /**
   * The production derivation with a freshly loaded module graph, once per
   * mode — the proof that nothing below the env caches the mode. Strict here
   * is the FORCED arm: two claim providers and the variable unset.
   */
  describe("derived mode, fresh modules", () => {
    it.each([
      [CLAIM_BINDING_MODE.STRICT, false],
      [CLAIM_BINDING_MODE.OFF, true],
    ] as const)("%s: a NULL row through createUser is allowed=%s", async (mode, allowed) => {
      for (const key of ["AUTH_CLAIM_BINDING", "AUTH_JACKSON_CONNECTIONS", "AUTH_JACKSON_ID", "AUTH_JACKSON_SECRET"]) {
        vi.stubEnv(key, "");
      }
      vi.stubEnv("AUTH_GOOGLE_ID", "binding-test-google-id");
      vi.stubEnv("AUTH_GOOGLE_SECRET", "binding-test-google-secret");
      if (mode === CLAIM_BINDING_MODE.STRICT) {
        vi.stubEnv("JACKSON_URL", "http://jackson.invalid");
        vi.stubEnv("AUTH_JACKSON_ID", "binding-test-client");
        vi.stubEnv("AUTH_JACKSON_SECRET", "binding-test-secret");
      }
      vi.resetModules();
      const { createCustomAdapter: freshAdapter } = await import("@/lib/auth/session/auth-adapter");
      const { tenantClaimStorage: freshStorage } = await import("@/lib/tenant/tenant-claim-storage");

      const owner = await ctx.createTenant();
      const claim = freshClaim(`derived-${mode}`);
      await bindClaim(owner, claim, null);
      const email = `bind-${randomUUID()}@example.invalid`;
      try {
        const createUser = freshAdapter().createUser;
        if (!createUser) throw new Error("createCustomAdapter() did not implement createUser");
        let caught: unknown = null;
        await freshStorage.run({ tenantClaim: claim, provider: "google" }, async () => {
          try {
            await createUser({ id: "unused", name: null, email, emailVerified: null, image: null });
          } catch (error) {
            caught = error;
          }
        });
        expect(caught === null).toBe(allowed);
        if (!allowed) {
          const [row] = await outboxRowsForClaim(claim);
          expect(row?.metadata.reason).toBe("tenant_claim_unbound");
        }
      } finally {
        await ctx.deleteTestData(owner);
      }
    });
  });
});

class RolledBack extends Error {}
