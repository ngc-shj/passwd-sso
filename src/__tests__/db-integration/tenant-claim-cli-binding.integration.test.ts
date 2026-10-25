/**
 * Real-DB coverage for `tenant-domain`'s claim-binding commands — plan
 * sso-claim-connection-binding, C3 (CLI) and the CLI half of C4's ref mapping.
 *
 * The commands are imported and called the way the existing CLI suite calls
 * them (tenant-claim-cli.integration.test.ts), on MIGRATION_DATABASE_URL. The
 * app env is the process env the CLI reads per call: each cell stubs the SSO
 * provider variables it needs, and "without the app env" means none of them is
 * set — which is the dev database's own `.env`.
 *
 * Sign-in cells drive the production entry points as
 * tenant-claim-binding.integration.test.ts does: the signIn callback captured
 * from the real `NextAuth(...)` config, then the adapter's `createUser`, under
 * `tenantClaimStorage.run`.
 *
 * `bind --from-members --out` reads every unbound claim in the (shared) dev
 * database, so every `--apply` here first keeps only this run's own lines — the
 * operator's review step, and what keeps a test from binding another working
 * copy's rows. Bind files are written under `os.tmpdir()`, never the worktree,
 * except the refusal cells, which assert that nothing was created.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { nextAuthConfigs } = vi.hoisted(() => ({ nextAuthConfigs: [] as unknown[] }));

// See tenant-claim-binding.integration.test.ts: the config handed to NextAuth
// is kept, and its signIn callback is the production entry point.
vi.mock("next-auth", () => ({
  default: (config: unknown) => {
    nextAuthConfigs.push(config);
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));

import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import {
  runToken,
  stubClaimProviderEnv,
  type ProviderEnvSpec,
} from "@/__tests__/helpers/tenant-claim-fixtures";
import "@/auth";
import { createCustomAdapter } from "@/lib/auth/session/auth-adapter";
import { tenantClaimStorage } from "@/lib/tenant/tenant-claim-storage";
import { sessionMetaStorage, type SessionMeta } from "@/lib/auth/session/session-meta";
import {
  CLAIM_BINDING_MODE,
  JACKSON_LEGACY_PROVIDER_ID,
  assertClaimBindingBootConfig,
  deriveClaimBindingMode,
} from "@/lib/auth/jackson-providers";
import { deriveIdentifierPepper, providerRef, resetIdentifierPepperForTests } from "@/lib/audit/identifier-pepper";
import {
  BACKFILL_CREATED_BY_LABEL,
  DEREGISTER_ACTOR_LABEL,
  SIGNIN_ACTOR_LABEL,
  TENANT_CLAIM_EVENT_OPERATION,
} from "@/lib/tenant/tenant-claim-event";
import {
  BIND_LINE_OUTCOME,
  cmdAdd,
  cmdBind,
  cmdBindApply,
  cmdBindFromMembers,
  cmdHistory,
  cmdLegacyAccounts,
  cmdList,
  cmdRemove,
  cmdUnmapped,
  migrationClientFactory,
} from "../../../scripts/tenant-domain";
import { BIND_FILE_HEADER, SIGN_IN_REF_LABEL } from "../../../scripts/lib/tenant-domain-binding";

const SKIP = !process.env.DATABASE_URL;

const GOOGLE = "google";
const ALPHA = "saml-jackson-alpha";
const BRAVO = "saml-jackson-bravo";
const PEPPER = "cli-binding-integration-pepper-0123456789abcdef";

/** Two Jackson connections: the derived mode is strict whatever the variable says. */
const TWO_CONNECTIONS: ProviderEnvSpec = { connections: [ALPHA, BRAVO], mode: "strict" };
/** One claim provider, strict not opted into: the derived mode is off. */
const ONE_PROVIDER_OFF: ProviderEnvSpec = { connections: [ALPHA] };

function captureOutput() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "warn").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return { text: () => lines.join("\n"), lines };
}

type SignInCallback = (params: {
  user: { id?: string; email?: string | null };
  account: { provider: string; type: "oidc"; providerAccountId: string } | null;
  profile: Record<string, unknown> | null;
}) => Promise<boolean>;

function capturedSignIn(): SignInCallback {
  const config = nextAuthConfigs[0] as { callbacks?: { signIn?: SignInCallback } } | undefined;
  const signIn = config?.callbacks?.signIn;
  if (!signIn) throw new Error("src/auth.ts did not hand NextAuth a signIn callback");
  return signIn;
}

/** A first-ever sign-in as Auth.js runs it; returns whether it was allowed and the user's tenant. */
async function firstSignIn(claim: string, provider: string): Promise<{ allowed: boolean; email: string }> {
  const email = `cli-bind-${randomUUID()}@example.invalid`;
  const meta: SessionMeta = { ip: null, userAgent: null, acceptLanguage: null, provider: null };
  const allowed = await sessionMetaStorage.run(meta, () =>
    tenantClaimStorage.run({ tenantClaim: null, provider: null }, async () => {
      const ok = await capturedSignIn()({
        user: { id: "pre-generated-id", email },
        account: { provider, type: "oidc", providerAccountId: `subject-${randomUUID()}` },
        profile: { tenant_id: claim },
      });
      if (!ok) return false;
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
  return { allowed, email };
}


describe.skipIf(SKIP)("tenant-domain claim binding (C3)", () => {
  let ctx: TestContext;
  let scratch: string;
  const REPO_TOP = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: resolve(__dirname),
    encoding: "utf8",
  }).trim();

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(() => {
    if (!process.env.MIGRATION_DATABASE_URL) {
      vi.stubEnv("MIGRATION_DATABASE_URL", process.env.DATABASE_URL as string);
    }
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", PEPPER);
    resetIdentifierPepperForTests();
    scratch = mkdtempSync(join(tmpdir(), "cli-bind-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetIdentifierPepperForTests();
    rmSync(scratch, { recursive: true, force: true });
  });

  function freshClaim(arm: string): string {
    return `${runToken()}-${arm}.bind.example`;
  }

  /** An active member of `tenantId` holding one account per provider. */
  async function member(tenantId: string, providers: readonly string[], opts: { deactivated?: boolean } = {}) {
    const userId = await ctx.createUser(tenantId);
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      for (const provider of providers) {
        await tx.$executeRawUnsafe(
          `INSERT INTO accounts (id, user_id, tenant_id, type, provider, provider_account_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'oidc', $4, $5)`,
          randomUUID(),
          userId,
          tenantId,
          provider,
          `subject-${randomUUID()}`,
        );
      }
      if (opts.deactivated) {
        await tx.$executeRawUnsafe(
          `UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`,
          userId,
        );
      }
    });
    return userId;
  }

  async function tenantWith(...members: ReadonlyArray<readonly string[]>): Promise<string> {
    const tenantId = await ctx.createTenant();
    for (const providers of members) await member(tenantId, providers);
    return tenantId;
  }

  async function seedClaim(
    tenantId: string,
    claim: string,
    over: { provider?: string | null; createdBy?: string | null; revokedAt?: Date | null } = {},
  ) {
    await ctx.su.prisma.tenantClaim.create({
      data: {
        tenantId,
        claim,
        createdBy: over.createdBy === undefined ? "cli-binding-test" : over.createdBy,
        provider: over.provider ?? null,
        revokedAt: over.revokedAt ?? null,
      },
    });
  }

  const claimRow = (claim: string) => ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
  const events = (claim: string) =>
    ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim }, orderBy: { seq: "asc" } });

  // ─── add: every writer arm, with and without --provider ────────────────

  describe("add", () => {
    it("create with --provider binds the row and the register event", async () => {
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("create-bound");
      const out = captureOutput();
      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: ALPHA, yes: true });
      expect(result).toMatchObject({ ok: true, code: 0 });
      expect((await claimRow(claim))?.provider).toBe(ALPHA);
      expect(await events(claim)).toEqual([
        expect.objectContaining({ operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER, oldProvider: null, newProvider: ALPHA }),
      ]);
      // A tenant nobody has signed in to yet: no evidence, and it proceeds.
      expect(out.text()).toContain("No evidence: the tenant has no active members yet");
      await ctx.deleteTestData(tenantId);
    });

    it("create with --unbound writes a NULL row and event outside strict", async () => {
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("create-unbound");
      captureOutput();
      expect(await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", unbound: true, yes: true })).toMatchObject({ ok: true });
      expect((await claimRow(claim))?.provider).toBeNull();
      expect((await events(claim))[0]).toMatchObject({ newProvider: null });
      await ctx.deleteTestData(tenantId);
    });

    it("create with neither --provider nor --unbound is refused outside strict, writing nothing", async () => {
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("create-neither");
      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", yes: true });
      expect(result).toMatchObject({ ok: false, code: 1 });
      expect(result.message).toContain("--unbound");
      expect(await claimRow(claim)).toBeNull();
      await ctx.deleteTestData(tenantId);
    });

    it("refuses --provider together with --unbound", async () => {
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("create-both");
      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: ALPHA, unbound: true, yes: true });
      expect(result.message).toContain("contradict");
      expect(await claimRow(claim)).toBeNull();
      await ctx.deleteTestData(tenantId);
    });

    it("refuses --accept-unused-provider together with --unbound", async () => {
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("create-unbound-accept");
      const result = await cmdAdd({
        tenant: tenantId,
        domain: claim,
        by: "ops",
        unbound: true,
        acceptUnusedProvider: true,
        yes: true,
      });
      expect(result).toMatchObject({ ok: false, code: 1 });
      expect(result.message).toContain("--accept-unused-provider");
      expect(await claimRow(claim)).toBeNull();
      await ctx.deleteTestData(tenantId);
    });

    it.each([
      ["--provider", { provider: ALPHA }, ALPHA],
      ["--unbound", { unbound: true }, null],
    ] as const)("unrevoke with %s sets the row's provider and records it", async (_label, flags, expected) => {
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("unrevoke");
      await seedClaim(tenantId, claim, { provider: null, revokedAt: new Date() });
      captureOutput();
      expect(await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", ...flags, yes: true })).toMatchObject({ ok: true });
      expect(await claimRow(claim)).toMatchObject({ revokedAt: null, provider: expected });
      expect(await events(claim)).toEqual([
        expect.objectContaining({ operation: TENANT_CLAIM_EVENT_OPERATION.UNREVOKE, oldProvider: null, newProvider: expected }),
      ]);
      await ctx.deleteTestData(tenantId);
    });

    it.each([
      // Strict (two providers): the re-point must name the provider.
      ["--provider", TWO_CONNECTIONS, { provider: BRAVO }, BRAVO],
      // --unbound exists only outside strict, so this arm has one provider.
      ["--unbound", ONE_PROVIDER_OFF, { unbound: true }, null],
    ] as const)("re-point with --from and %s moves the row and its binding together", async (_label, spec, flags, expected) => {
      stubClaimProviderEnv(spec);
      const losing = await ctx.createTenant();
      const gaining = await ctx.createTenant();
      const claim = freshClaim("repoint");
      await seedClaim(losing, claim, { provider: ALPHA });
      captureOutput();
      const result = await cmdAdd({ tenant: gaining, domain: claim, by: "ops", from: losing, ...flags, yes: true });
      expect(result).toMatchObject({ ok: true });
      expect(await claimRow(claim)).toMatchObject({ tenantId: gaining, provider: expected });
      expect(await events(claim)).toEqual([
        expect.objectContaining({
          operation: TENANT_CLAIM_EVENT_OPERATION.REASSIGN,
          oldTenantId: losing,
          newTenantId: gaining,
          oldProvider: ALPHA,
          newProvider: expected,
        }),
      ]);
      await ctx.deleteTestData(losing);
      await ctx.deleteTestData(gaining);
    });

    it("re-point without --provider is refused outside strict, leaving the row where it was", async () => {
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      const losing = await ctx.createTenant();
      const gaining = await ctx.createTenant();
      const claim = freshClaim("repoint-neither");
      await seedClaim(losing, claim, { provider: ALPHA });
      const result = await cmdAdd({ tenant: gaining, domain: claim, by: "ops", from: losing, yes: true });
      expect(result).toMatchObject({ ok: false });
      expect(await claimRow(claim)).toMatchObject({ tenantId: losing, provider: ALPHA });
      expect(await events(claim)).toHaveLength(0);
      await ctx.deleteTestData(losing);
      await ctx.deleteTestData(gaining);
    });

    it("an already-registered claim: the same binding is a no-op, a different one is refused with bind named", async () => {
      stubClaimProviderEnv({ connections: [ALPHA, BRAVO], mode: "strict" });
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("idempotent");
      await seedClaim(tenantId, claim, { provider: ALPHA });
      captureOutput();
      expect(await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: ALPHA, yes: true })).toMatchObject({
        ok: true,
        message: "already registered (idempotent)",
      });
      const other = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: BRAVO, yes: true });
      expect(other).toMatchObject({ ok: false });
      expect(other.message).toContain("tenant-domain bind");
      expect((await claimRow(claim))?.provider).toBe(ALPHA);
      expect(await events(claim)).toHaveLength(0);
      await ctx.deleteTestData(tenantId);
    });
  });

  // ─── the derived-strict window ──────────────────────────────────────────

  describe("derived mode", () => {
    it.each([
      ["unset", undefined],
      ["off", "off"],
    ] as const)(
      "Google + Jackson with AUTH_CLAIM_BINDING %s: strict, boot refused, and add needs --provider",
      async (_label, mode) => {
        stubClaimProviderEnv({ google: true, connections: [ALPHA], ...(mode ? { mode } : {}) });
        expect(deriveClaimBindingMode()).toBe(CLAIM_BINDING_MODE.STRICT);
        expect(() => assertClaimBindingBootConfig()).toThrow(/AUTH_CLAIM_BINDING/);

        const tenantId = await ctx.createTenant();
        const refusedClaim = freshClaim("window-refused");
        for (const flags of [{}, { unbound: true }]) {
          const refused = await cmdAdd({ tenant: tenantId, domain: refusedClaim, by: "ops", ...flags, yes: true });
          expect(refused.message).toContain("strict");
        }
        expect(await claimRow(refusedClaim)).toBeNull();

        const allowedClaim = freshClaim("window-allowed");
        captureOutput();
        expect(
          await cmdAdd({ tenant: tenantId, domain: allowedClaim, by: "ops", provider: GOOGLE, yes: true }),
        ).toMatchObject({ ok: true });
        expect((await claimRow(allowedClaim))?.provider).toBe(GOOGLE);
        await ctx.deleteTestData(tenantId);
      },
    );

    it("one provider and the variable unset: off, and add --unbound is allowed", async () => {
      stubClaimProviderEnv({ google: true });
      expect(deriveClaimBindingMode()).toBe(CLAIM_BINDING_MODE.OFF);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("one-off");
      captureOutput();
      expect(await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", unbound: true, yes: true })).toMatchObject({ ok: true });
      await ctx.deleteTestData(tenantId);
    });
  });

  // ─── --provider validation, with and without the app env ────────────────

  describe("--provider validation", () => {
    it("with the app env: an unconfigured provider is refused, a configured one allowed", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("validate");
      const refused = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: "saml-jackson-gone", yes: true });
      expect(refused.message).toContain("is not a configured claim provider");
      expect(await claimRow(claim)).toBeNull();
      captureOutput();
      expect(await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: BRAVO, yes: true })).toMatchObject({ ok: true });
      await ctx.deleteTestData(tenantId);
    });

    it("without the app env: checked against the pattern with a warning; a malformed id is refused", async () => {
      stubClaimProviderEnv({});
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("pattern");
      const refused = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: "Saml_Jackson", yes: true });
      expect(refused.message).toContain("is not a provider id");
      const out = captureOutput();
      expect(await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: ALPHA, yes: true })).toMatchObject({ ok: true });
      expect(out.text()).toContain("checked against the provider-id pattern only");
      expect((await claimRow(claim))?.provider).toBe(ALPHA);
      await ctx.deleteTestData(tenantId);
    });
  });

  // ─── --by reserves every engine-written label ───────────────────────────

  describe("--by", () => {
    it.each([SIGNIN_ACTOR_LABEL, BACKFILL_CREATED_BY_LABEL, DEREGISTER_ACTOR_LABEL, " Backfill ", "DB-Delete"])(
      "refuses %j on add and bind, before writing",
      async (label) => {
        stubClaimProviderEnv(ONE_PROVIDER_OFF);
        const tenantId = await ctx.createTenant();
        const claim = freshClaim("reserved");
        const added = await cmdAdd({ tenant: tenantId, domain: claim, by: label, unbound: true, yes: true });
        expect(added.message).toMatch(/--by must not be "(signin|backfill|db-delete)"/);
        expect(await claimRow(claim)).toBeNull();
        const bound = await cmdBind({ claim, provider: ALPHA, by: label, yes: true });
        expect(bound.message).toMatch(/--by must not be/);
        await ctx.deleteTestData(tenantId);
      },
    );

    it("accepts a label that only contains a reserved one (the adjacent allow)", async () => {
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("label-allow");
      captureOutput();
      expect(await cmdAdd({ tenant: tenantId, domain: claim, by: "backfill-ops", unbound: true, yes: true })).toMatchObject({ ok: true });
      await ctx.deleteTestData(tenantId);
    });
  });

  // ─── the evidence check ─────────────────────────────────────────────────

  describe("evidence majority", () => {
    it("exactly half is refused; half plus one is allowed", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const half = await tenantWith([ALPHA], [ALPHA], [BRAVO], []);
      const halfPlusOne = await tenantWith([ALPHA], [ALPHA], [ALPHA], [BRAVO]);
      const claimHalf = freshClaim("half");
      const claimMore = freshClaim("more");
      captureOutput();
      const refused = await cmdAdd({ tenant: half, domain: claimHalf, by: "ops", provider: ALPHA, yes: true });
      expect(refused.message).toContain("only 2 of the tenant's 4 active member(s)");
      expect(await claimRow(claimHalf)).toBeNull();
      expect(await cmdAdd({ tenant: halfPlusOne, domain: claimMore, by: "ops", provider: ALPHA, yes: true })).toMatchObject({ ok: true });
      await ctx.deleteTestData(half);
      await ctx.deleteTestData(halfPlusOne);
    });

    it("--accept-unused-provider overrides the refusal (the override allow pair)", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([ALPHA], [BRAVO], [BRAVO]);
      const claim = freshClaim("override");
      captureOutput();
      expect((await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: ALPHA, yes: true })).ok).toBe(false);
      expect(
        await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: ALPHA, acceptUnusedProvider: true, yes: true }),
      ).toMatchObject({ ok: true });
      expect((await claimRow(claim))?.provider).toBe(ALPHA);
      await ctx.deleteTestData(tenantId);
    });

    it("counts only this tenant's ACTIVE members", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([ALPHA], []);
      await member(tenantId, [BRAVO], { deactivated: true });
      const neighbour = await tenantWith([BRAVO], [BRAVO], [BRAVO]);
      const claim = freshClaim("scoped");
      await seedClaim(tenantId, claim);
      const out = captureOutput();
      await cmdBind({ claim, provider: ALPHA, by: "ops", confirm: async () => false });
      expect(out.text()).toContain(`members:    ${ALPHA}=1;none=1;total=2`);
      await ctx.deleteTestData(tenantId);
      await ctx.deleteTestData(neighbour);
    });
  });

  // ─── CAS: only the provider changed ─────────────────────────────────────

  describe("compare-and-swap on the provider", () => {
    /** A confirmation that rebinds the row behind the command's back. */
    const rebindDuring = (claim: string, provider: string) => async () => {
      await ctx.su.prisma.tenantClaim.update({ where: { claim }, data: { provider } });
      return true;
    };

    it("re-point: a concurrent change of the provider alone is a refusal", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const losing = await ctx.createTenant();
      const gaining = await ctx.createTenant();
      const claim = freshClaim("cas-repoint");
      await seedClaim(losing, claim, { provider: ALPHA });
      captureOutput();
      const result = await cmdAdd({
        tenant: gaining,
        domain: claim,
        by: "ops",
        from: losing,
        provider: BRAVO,
        confirm: rebindDuring(claim, BRAVO),
      });
      expect(result.message).toContain("modified concurrently");
      expect(await claimRow(claim)).toMatchObject({ tenantId: losing, provider: BRAVO });
      expect(await events(claim)).toHaveLength(0);
      await ctx.deleteTestData(losing);
      await ctx.deleteTestData(gaining);
    });

    it("unrevoke: a concurrent change of the provider alone is a refusal", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("cas-unrevoke");
      const revokedAt = new Date();
      await seedClaim(tenantId, claim, { provider: ALPHA, revokedAt });
      captureOutput();
      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: ALPHA, confirm: rebindDuring(claim, BRAVO) });
      expect(result.message).toContain("modified concurrently");
      expect(await claimRow(claim)).toMatchObject({ provider: BRAVO, revokedAt });
      await ctx.deleteTestData(tenantId);
    });

    // The revoke event records the row's provider, so the provider is part of
    // remove's CAS: without it a rebind committed during the prompt is revoked
    // under an event naming the provider it replaced.
    it.each([
      ["an unbound", null],
      ["a bound", ALPHA],
    ] as const)("remove: a concurrent rebind of %s row is a refusal and records no event", async (_label, provider) => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("cas-remove");
      await seedClaim(tenantId, claim, { provider });
      captureOutput();
      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "ops", confirm: rebindDuring(claim, BRAVO) });
      expect(result).toMatchObject({ ok: false, code: 1 });
      expect(result.message).toContain("modified concurrently");
      expect(await claimRow(claim)).toMatchObject({ provider: BRAVO, revokedAt: null });
      expect(await events(claim)).toHaveLength(0);
      await ctx.deleteTestData(tenantId);
    });

    it.each([
      ["an unbound", null],
      ["a bound", ALPHA],
    ] as const)("remove: %s row with no concurrent change is revoked under its own provider", async (_label, provider) => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("cas-remove-allow");
      await seedClaim(tenantId, claim, { provider });
      captureOutput();
      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "ops", confirm: async () => true });
      expect(result).toMatchObject({ ok: true });
      expect((await claimRow(claim))?.revokedAt).not.toBeNull();
      expect(await events(claim)).toEqual([
        expect.objectContaining({
          operation: TENANT_CLAIM_EVENT_OPERATION.REVOKE,
          oldProvider: provider,
          newProvider: provider,
        }),
      ]);
      await ctx.deleteTestData(tenantId);
    });
  });

  // ─── bind --claim ───────────────────────────────────────────────────────

  describe("bind --claim", () => {
    it("binds a NULL row and records a rebind with both providers", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([ALPHA]);
      const claim = freshClaim("bind-null");
      await seedClaim(tenantId, claim);
      captureOutput();
      expect(await cmdBind({ claim, provider: ALPHA, by: "ops", yes: true })).toMatchObject({ ok: true });
      expect((await claimRow(claim))?.provider).toBe(ALPHA);
      expect(await events(claim)).toEqual([
        expect.objectContaining({
          operation: TENANT_CLAIM_EVENT_OPERATION.REBIND,
          oldTenantId: tenantId,
          newTenantId: tenantId,
          oldRevokedAt: null,
          newRevokedAt: null,
          oldProvider: null,
          newProvider: ALPHA,
          actorLabel: "ops",
        }),
      ]);
      await ctx.deleteTestData(tenantId);
    });

    it("moves a binding, and the same provider again is a no-op", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([BRAVO]);
      const claim = freshClaim("bind-move");
      await seedClaim(tenantId, claim, { provider: ALPHA });
      captureOutput();
      expect(await cmdBind({ claim, provider: BRAVO, by: "ops", yes: true })).toMatchObject({ ok: true });
      expect((await events(claim))[0]).toMatchObject({ oldProvider: ALPHA, newProvider: BRAVO });
      const again = await cmdBind({ claim, provider: BRAVO, by: "ops", yes: true });
      expect(again).toMatchObject({ ok: true });
      expect(again.message).toContain("already bound");
      expect(await events(claim)).toHaveLength(1);
      await ctx.deleteTestData(tenantId);
    });

    it("refuses a revoked claim and an absent one", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await ctx.createTenant();
      const revoked = freshClaim("bind-revoked");
      await seedClaim(tenantId, revoked, { revokedAt: new Date() });
      expect((await cmdBind({ claim: revoked, provider: ALPHA, by: "ops", yes: true })).message).toContain("is revoked");
      expect((await claimRow(revoked))?.provider).toBeNull();
      expect((await cmdBind({ claim: freshClaim("bind-absent"), provider: ALPHA, by: "ops", yes: true })).message).toContain(
        "is registered",
      );
      await ctx.deleteTestData(tenantId);
    });

    it("refuses an unconfigured provider with the app env", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("bind-unconfigured");
      await seedClaim(tenantId, claim);
      expect((await cmdBind({ claim, provider: "saml-jackson-gone", by: "ops", yes: true })).message).toContain(
        "not a configured claim provider",
      );
      expect((await claimRow(claim))?.provider).toBeNull();
      await ctx.deleteTestData(tenantId);
    });

    it("runs without the app env, against the pattern with a warning", async () => {
      stubClaimProviderEnv({});
      const tenantId = await tenantWith([ALPHA]);
      const claim = freshClaim("bind-noenv");
      await seedClaim(tenantId, claim);
      const out = captureOutput();
      expect(await cmdBind({ claim, provider: ALPHA, by: "ops", yes: true })).toMatchObject({ ok: true });
      expect(out.text()).toContain("checked against the provider-id pattern only");
      await ctx.deleteTestData(tenantId);
    });

    it("refuses a minority provider unless --accept-unused-provider", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([ALPHA], [BRAVO], [BRAVO]);
      const claim = freshClaim("bind-override");
      await seedClaim(tenantId, claim);
      captureOutput();
      expect((await cmdBind({ claim, provider: ALPHA, by: "ops", yes: true })).message).toContain("not a majority");
      expect((await claimRow(claim))?.provider).toBeNull();
      expect(await cmdBind({ claim, provider: ALPHA, by: "ops", acceptUnusedProvider: true, yes: true })).toMatchObject({ ok: true });
      await ctx.deleteTestData(tenantId);
    });

    it("a concurrent rebind while the operator reads is a CAS refusal", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("bind-cas");
      await seedClaim(tenantId, claim);
      captureOutput();
      const result = await cmdBind({
        claim,
        provider: ALPHA,
        by: "ops",
        confirm: async () => {
          await ctx.su.prisma.tenantClaim.update({ where: { claim }, data: { provider: BRAVO } });
          return true;
        },
      });
      expect(result.message).toContain("modified concurrently");
      expect((await claimRow(claim))?.provider).toBe(BRAVO);
      expect(await events(claim)).toHaveLength(0);
      await ctx.deleteTestData(tenantId);
    });
  });

  // ─── list, list --unbound, history ──────────────────────────────────────

  describe("list and history", () => {
    it("list shows each row's provider", async () => {
      stubClaimProviderEnv({});
      const tenantId = await ctx.createTenant();
      const bound = freshClaim("list-bound");
      const unbound = freshClaim("list-unbound");
      await seedClaim(tenantId, bound, { provider: ALPHA });
      await seedClaim(tenantId, unbound);
      const out = captureOutput();
      expect(await cmdList({ tenant: tenantId })).toMatchObject({ ok: true });
      expect(out.lines.find((l) => l.startsWith(`${bound}\t`))).toContain(`provider=${ALPHA}`);
      expect(out.lines.find((l) => l.startsWith(`${unbound}\t`))).toContain("provider=-");
      await ctx.deleteTestData(tenantId);
    });

    it("list --unbound with the app env: NULL and unconfigured rows, never a bound one, with a suggestion", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([BRAVO], [BRAVO]);
      const nullClaim = freshClaim("unbound-null");
      const goneClaim = freshClaim("unbound-gone");
      const boundClaim = freshClaim("unbound-bound");
      const revokedClaim = freshClaim("unbound-revoked");
      await seedClaim(tenantId, nullClaim);
      await seedClaim(tenantId, goneClaim, { provider: "saml-jackson-gone" });
      await seedClaim(tenantId, boundClaim, { provider: ALPHA });
      await seedClaim(tenantId, revokedClaim, { revokedAt: new Date() });
      const out = captureOutput();
      const result = await cmdList({ tenant: tenantId, unbound: true });
      const listed = (result.rows as Array<{ claim: string }>).map((r) => r.claim).sort();
      expect(listed).toEqual([goneClaim, nullClaim].sort());
      expect(out.lines.find((l) => l.startsWith(`${nullClaim}\t`))).toContain(`suggest=${BRAVO}`);
      expect(result.message).toContain("strict mode");
      await ctx.deleteTestData(tenantId);
    });

    it("list --unbound without the app env: NULL rows only, and says the rest were not evaluated", async () => {
      stubClaimProviderEnv({});
      const tenantId = await ctx.createTenant();
      const nullClaim = freshClaim("noenv-null");
      const goneClaim = freshClaim("noenv-gone");
      await seedClaim(tenantId, nullClaim);
      await seedClaim(tenantId, goneClaim, { provider: "saml-jackson-gone" });
      captureOutput();
      const result = await cmdList({ tenant: tenantId, unbound: true });
      expect((result.rows as Array<{ claim: string }>).map((r) => r.claim)).toEqual([nullClaim]);
      expect(result.message).toContain("were NOT evaluated");
      await ctx.deleteTestData(tenantId);
    });

    it("history prints old and new provider on every row", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([BRAVO]);
      const claim = freshClaim("history");
      await seedClaim(tenantId, claim, { provider: ALPHA });
      captureOutput();
      await cmdBind({ claim, provider: BRAVO, by: "ops", yes: true });
      const out = captureOutput();
      expect(await cmdHistory({ domain: claim })).toMatchObject({ ok: true });
      const line = out.lines.find((l) => l.includes(`\t${TENANT_CLAIM_EVENT_OPERATION.REBIND}\t`));
      expect(line).toContain(`oldProvider=${ALPHA}\tnewProvider=${BRAVO}`);
      await ctx.deleteTestData(tenantId);
    });

    it.each([
      ["with", TWO_CONNECTIONS],
      ["without", {}],
    ] as const)("list, history and remove run %s the app env", async (_label, spec) => {
      stubClaimProviderEnv(spec);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("each-command");
      await seedClaim(tenantId, claim, { provider: ALPHA });
      captureOutput();
      expect((await cmdList({ tenant: tenantId })).ok).toBe(true);
      expect((await cmdHistory({ domain: claim })).ok).toBe(true);
      expect((await cmdRemove({ tenant: tenantId, domain: claim, by: "ops", yes: true })).ok).toBe(true);
      expect((await events(claim))[0]).toMatchObject({ oldProvider: ALPHA, newProvider: ALPHA });
      await ctx.deleteTestData(tenantId);
    });
  });

  // ─── bind --from-members --out ──────────────────────────────────────────

  /** The file's lines for `claims` only: what a reviewing operator keeps. */
  function keepOnly(text: string, claims: readonly string[], edit: (claim: string, provider: string) => string = (_c, p) => p) {
    const lines = text.split("\n").filter((line) => line !== "");
    const [header, ...body] = lines;
    const kept = body.filter((line) => {
      if (line.startsWith("#")) return true;
      return claims.includes(line.split("\t")[0]);
    });
    return [
      header,
      ...kept.map((line) => {
        if (line.startsWith("#")) return line;
        const [claim, tenant, provider, evidence] = line.split("\t");
        return [claim, tenant, edit(claim, provider), evidence].join("\t");
      }),
      "",
    ].join("\n");
  }

  function dataLine(text: string, claim: string): string[] | undefined {
    return text
      .split("\n")
      .find((line) => line.startsWith(`${claim}\t`))
      ?.split("\t");
  }

  describe("bind --from-members --out", () => {
    it("writes the review file, mode 0600, and nothing to the database", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([ALPHA]);
      const claim = freshClaim("out-nowrite");
      await seedClaim(tenantId, claim);
      const before = { row: await claimRow(claim), events: await events(claim) };
      const file = join(scratch, "bind.tsv");
      captureOutput();
      expect(await cmdBindFromMembers({ out: file })).toMatchObject({ ok: true });
      // One descriptor for both reads, so the mode and the content are of the
      // same file.
      const fd = openSync(file, "r");
      try {
        expect(fstatSync(fd).mode & 0o777).toBe(0o600);
        expect(readFileSync(fd, "utf8").split("\n")[0]).toBe(BIND_FILE_HEADER);
      } finally {
        closeSync(fd);
      }
      expect({ row: await claimRow(claim), events: await events(claim) }).toEqual(before);
      await ctx.deleteTestData(tenantId);
    });

    it("names a stored claim starting with # as not written, and writes the others as lines", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([ALPHA]);
      const hashed = `#${freshClaim("out-hash")}`;
      const plain = freshClaim("out-plain");
      await seedClaim(tenantId, hashed);
      await seedClaim(tenantId, plain);
      const file = join(scratch, "bind.tsv");
      captureOutput();
      const result = await cmdBindFromMembers({ out: file });
      expect(result).toMatchObject({ ok: true });
      expect(result.message).toContain(`NOT WRITTEN`);
      expect(result.message).toContain(`"${hashed}"`);
      const text = readFileSync(file, "utf8");
      expect(text).toContain(`#   ${hashed} (tenant ${tenantId})`);
      expect(dataLine(text, plain)?.[0]).toBe(plain);
      expect(dataLine(text, hashed)).toBeUndefined();
      await ctx.deleteTestData(tenantId);
    });

    it("refuses an existing path and leaves it untouched", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const file = join(scratch, "exists.tsv");
      writeFileSync(file, "operator notes\n");
      const result = await cmdBindFromMembers({ out: file });
      expect(result.message).toContain("already exists");
      expect(readFileSync(file, "utf8")).toBe("operator notes\n");
    });

    it.each([
      ["the worktree itself", () => join(REPO_TOP, `bind-${runToken()}.tsv`)],
      ["a `..` that climbs into it", () => join(REPO_TOP, "scripts", "..", `bind-${runToken()}.tsv`)],
      [
        "a symlinked parent",
        () => {
          const link = join(scratch, "into-repo");
          symlinkSync(REPO_TOP, link);
          return join(link, `bind-${runToken()}.tsv`);
        },
      ],
    ])("refuses %s, creating nothing", async (_label, target) => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const file = target();
      // Every target resolves into the real repository: registered before the
      // call, so a regression that writes the file cannot leave it there.
      onTestFinished(() => rmSync(file, { force: true }));
      const result = await cmdBindFromMembers({ out: file });
      expect(result).toMatchObject({ ok: false });
      expect(result.message).toContain("inside the git worktree");
      expect(existsSync(file)).toBe(false);
    });

    it("allows a path outside the repository (the adjacent allow)", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      captureOutput();
      expect(await cmdBindFromMembers({ out: join(scratch, "outside.tsv") })).toMatchObject({ ok: true });
    });

    it("refuses without the app env, creating nothing", async () => {
      stubClaimProviderEnv({});
      const file = join(scratch, "noenv.tsv");
      const result = await cmdBindFromMembers({ out: file });
      expect(result.message).toContain("needs the app's environment");
      expect(existsSync(file)).toBe(false);
    });

    it("suggests a provider for unanimous tenants, including the shapes an upgrade holds, and none for a minority intruder", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const unanimous = await tenantWith([ALPHA], [ALPHA]);
      const backfilled = await tenantWith([BRAVO]);
      const preChange = await tenantWith([ALPHA]);
      const intruded = await tenantWith([ALPHA], [ALPHA], [BRAVO]);
      const empty = await ctx.createTenant();
      const claims = {
        unanimous: freshClaim("sugg-unanimous"),
        // The backfill shape: created_by "backfill", the claim is the tenant id, no event.
        backfilled,
        preChange: freshClaim("sugg-prechange"),
        intruded: freshClaim("sugg-intruded"),
        empty: freshClaim("sugg-empty"),
      };
      await seedClaim(unanimous, claims.unanimous, { createdBy: SIGNIN_ACTOR_LABEL });
      await seedClaim(backfilled, claims.backfilled, { createdBy: BACKFILL_CREATED_BY_LABEL });
      // A pre-change register event: written by `add --unbound`, new_provider NULL.
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      captureOutput();
      expect((await cmdAdd({ tenant: preChange, domain: claims.preChange, by: "ops", unbound: true, yes: true })).ok).toBe(true);
      stubClaimProviderEnv(TWO_CONNECTIONS);
      await seedClaim(intruded, claims.intruded);
      await seedClaim(empty, claims.empty);

      const file = join(scratch, "suggest.tsv");
      expect((await cmdBindFromMembers({ out: file })).ok).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(dataLine(text, claims.unanimous)?.[2]).toBe(ALPHA);
      expect(dataLine(text, claims.backfilled)?.[2]).toBe(BRAVO);
      expect(dataLine(text, claims.preChange)?.[2]).toBe(ALPHA);
      expect(dataLine(text, claims.intruded)?.slice(2)).toEqual(["", `${ALPHA}=2;${BRAVO}=1;none=0;total=3`]);
      expect(dataLine(text, claims.empty)?.slice(2)).toEqual(["", "none=0;total=0"]);
      expect(text).toContain(`# ${claims.backfilled}: created_by=backfill; uuid_claim=yes;`);
      expect(text).toContain(`# ${claims.preChange}: created_by=ops; uuid_claim=no; operator_events=none; register_provider=unknown`);
      for (const tenantId of [unanimous, backfilled, preChange, intruded, empty]) await ctx.deleteTestData(tenantId);
    });

    it("flags operator-declared, re-pointed and unrevoked rows", async () => {
      stubClaimProviderEnv(ONE_PROVIDER_OFF);
      const losing = await ctx.createTenant();
      const tenantId = await tenantWith([ALPHA]);
      const repointed = freshClaim("flag-repointed");
      const unrevoked = freshClaim("flag-unrevoked");
      await seedClaim(losing, repointed, { createdBy: "ops-declared" });
      await seedClaim(tenantId, unrevoked, { revokedAt: new Date() });
      captureOutput();
      expect((await cmdAdd({ tenant: tenantId, domain: repointed, by: "ops", from: losing, unbound: true, yes: true })).ok).toBe(true);
      expect((await cmdAdd({ tenant: tenantId, domain: unrevoked, by: "ops", unbound: true, yes: true })).ok).toBe(true);
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const file = join(scratch, "flags.tsv");
      expect((await cmdBindFromMembers({ out: file })).ok).toBe(true);
      const text = readFileSync(file, "utf8");
      expect(text).toContain(`# ${repointed}: created_by=ops-declared; uuid_claim=no; operator_events=reassign;`);
      expect(text).toContain(`# ${unrevoked}: created_by=cli-binding-test; uuid_claim=no; operator_events=unrevoke;`);
      await ctx.deleteTestData(losing);
      await ctx.deleteTestData(tenantId);
    });

    it.each([
      ["a newline and a valid TSV line", (t: string) => `x\nforged.bind.example\t${t}\t${ALPHA}\t${ALPHA}=1;none=0;total=1`],
      ["a tab", () => "ops\tadmin"],
      ["a bidi override", () => `ops${String.fromCodePoint(0x202e)}admin`],
    ])("a created_by holding %s yields exactly one data line for its row", async (_label, createdBy) => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([ALPHA]);
      const claim = freshClaim("poisoned");
      await seedClaim(tenantId, claim, { createdBy: createdBy(tenantId) });
      try {
        const file = join(scratch, "poisoned.tsv");
        captureOutput();
        expect((await cmdBindFromMembers({ out: file })).ok).toBe(true);
        const text = readFileSync(file, "utf8");
        // Scoped to this row's tenant: the file lists every unbound claim in
        // the shared database.
        const own = text.split("\n").filter((l) => l.includes(tenantId) || l.startsWith(`# ${claim}:`));
        expect(own.filter((l) => !l.startsWith("#")).map((l) => l.split("\t")[0])).toEqual([claim]);
        // The flag line is one line with no tab and no unsafe character in it.
        expect(own.filter((l) => l.startsWith("#"))).toEqual([expect.not.stringMatching(/[\t\u202e]/)]);
        expect(text).not.toContain(String.fromCodePoint(0x202e));
      } finally {
        await ctx.deleteTestData(tenantId);
      }
    });
  });

  // ─── bind --apply ───────────────────────────────────────────────────────

  describe("bind --apply", () => {
    async function writeReviewed(name: string, claims: readonly string[], edit?: (c: string, p: string) => string) {
      const full = join(scratch, `${name}.full.tsv`);
      captureOutput();
      const written = await cmdBindFromMembers({ out: full });
      if (!written.ok) throw new Error(written.message);
      const reviewed = join(scratch, `${name}.tsv`);
      writeFileSync(reviewed, keepOnly(readFileSync(full, "utf8"), claims, edit));
      return reviewed;
    }

    it("--out then --apply with no change binds every eligible line; a rerun reports them already bound", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const a = await tenantWith([ALPHA], [ALPHA]);
      const b = await tenantWith([BRAVO]);
      const claimA = freshClaim("apply-a");
      const claimB = freshClaim("apply-b");
      await seedClaim(a, claimA);
      await seedClaim(b, claimB);
      const file = await writeReviewed("nochange", [claimA, claimB]);
      expect(await cmdBindApply({ file, by: "ops", yes: true })).toMatchObject({ ok: true, code: 0 });
      expect((await claimRow(claimA))?.provider).toBe(ALPHA);
      expect((await claimRow(claimB))?.provider).toBe(BRAVO);
      expect((await events(claimA))[0]).toMatchObject({ operation: TENANT_CLAIM_EVENT_OPERATION.REBIND, newProvider: ALPHA });

      const rerun = await cmdBindApply({ file, by: "ops", yes: true });
      expect(rerun).toMatchObject({ ok: true, code: 0 });
      expect((rerun.rows as Array<{ outcome: string }>).map((r) => r.outcome)).toEqual([
        BIND_LINE_OUTCOME.ALREADY_BOUND,
        BIND_LINE_OUTCOME.ALREADY_BOUND,
      ]);
      expect(await events(claimA)).toHaveLength(1);
      await ctx.deleteTestData(a);
      await ctx.deleteTestData(b);
    });

    it("binds only the kept lines and lists operator-chosen ones apart", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const kept = await tenantWith([ALPHA]);
      const blanked = await tenantWith([ALPHA]);
      const chosen = await tenantWith([BRAVO], [BRAVO], [ALPHA]);
      const claims = { kept: freshClaim("kept"), blanked: freshClaim("blanked"), chosen: freshClaim("chosen") };
      await seedClaim(kept, claims.kept);
      await seedClaim(blanked, claims.blanked);
      await seedClaim(chosen, claims.chosen);
      const file = await writeReviewed("kept", Object.values(claims), (claim, provider) =>
        claim === claims.blanked ? "" : claim === claims.chosen ? BRAVO : provider,
      );
      const out = captureOutput();
      expect(await cmdBindApply({ file, by: "ops", yes: true })).toMatchObject({ ok: true });
      expect((await claimRow(claims.kept))?.provider).toBe(ALPHA);
      expect((await claimRow(claims.blanked))?.provider).toBeNull();
      expect((await claimRow(claims.chosen))?.provider).toBe(BRAVO);
      const text = out.text();
      const chosenHeading = text.indexOf("Operator-chosen lines");
      expect(text.indexOf(claims.kept)).toBeLessThan(chosenHeading);
      expect(text.indexOf(claims.chosen)).toBeGreaterThan(chosenHeading);
      expect(text).toContain("Lines left with an empty provider, not applied: 1.");
      for (const t of [kept, blanked, chosen]) await ctx.deleteTestData(t);
    });

    it("refuses lines whose row or evidence changed, a zero-member tenant and a minority; the rest commit; exit non-zero", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const ok = await tenantWith([ALPHA]);
      const casLost = await tenantWith([ALPHA]);
      const changed = await tenantWith([ALPHA]);
      const empty = await ctx.createTenant();
      const minority = await tenantWith([ALPHA], [ALPHA], [BRAVO]);
      const claims = {
        ok: freshClaim("p-ok"),
        casLost: freshClaim("p-cas"),
        changed: freshClaim("p-changed"),
        empty: freshClaim("p-empty"),
        minority: freshClaim("p-minority"),
      };
      for (const [key, tenantId] of [["ok", ok], ["casLost", casLost], ["changed", changed], ["empty", empty], ["minority", minority]] as const) {
        await seedClaim(tenantId, claims[key]);
      }
      const file = await writeReviewed("partial", Object.values(claims), (claim, provider) =>
        claim === claims.empty ? ALPHA : claim === claims.minority ? BRAVO : provider,
      );
      // After the file was written: the row is bound elsewhere, and a member joins.
      await ctx.su.prisma.tenantClaim.update({ where: { claim: claims.casLost }, data: { provider: BRAVO } });
      await member(changed, [ALPHA]);

      captureOutput();
      const result = await cmdBindApply({ file, by: "ops", yes: true });
      expect(result).toMatchObject({ ok: false, code: 1 });
      const outcome = Object.fromEntries((result.rows as Array<{ claim: string; outcome: string }>).map((r) => [r.claim, r.outcome]));
      expect(outcome).toEqual({
        [claims.ok]: BIND_LINE_OUTCOME.BOUND,
        [claims.casLost]: BIND_LINE_OUTCOME.CAS_LOST,
        [claims.changed]: BIND_LINE_OUTCOME.EVIDENCE_CHANGED,
        [claims.empty]: BIND_LINE_OUTCOME.EVIDENCE_REFUSED,
        [claims.minority]: BIND_LINE_OUTCOME.EVIDENCE_REFUSED,
      });
      expect((await claimRow(claims.ok))?.provider).toBe(ALPHA);
      expect((await claimRow(claims.casLost))?.provider).toBe(BRAVO);
      for (const key of ["changed", "empty", "minority"] as const) {
        expect((await claimRow(claims[key]))?.provider).toBeNull();
      }
      for (const t of [ok, casLost, changed, empty, minority]) await ctx.deleteTestData(t);
    });

    it.each([
      ["a malformed line", (t: string) => `extra.example\t${t}\t${ALPHA}`],
      ["a duplicate claim", null],
      ["an unknown header version", "header"],
      ["an unconfigured provider", (t: string) => `gone.bind.example\t${t}\tsaml-jackson-gone\t${ALPHA}=1;none=0;total=1`],
      ["an escaped control character", (t: string) => `ctl${String.fromCodePoint(0x7f)}.example\t${t}\t${ALPHA}\t${ALPHA}=1;none=0;total=1`],
    ] as const)("refuses the whole file on %s, applying nothing; without the defect it applies", async (_label, defect) => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenantWith([ALPHA]);
      const claim = freshClaim("contract");
      await seedClaim(tenantId, claim);
      const file = await writeReviewed("contract", [claim]);
      const clean = readFileSync(file, "utf8");
      const broken =
        defect === "header"
          ? clean.replace(BIND_FILE_HEADER, BIND_FILE_HEADER.replace("v1", "v9"))
          : defect === null
            ? `${clean}${clean.split("\n").find((l) => l.startsWith(`${claim}\t`))}\n`
            : `${clean}${defect(tenantId)}\n`;
      const brokenFile = join(scratch, "broken.tsv");
      writeFileSync(brokenFile, broken);
      const out = captureOutput();
      const refused = await cmdBindApply({ file: brokenFile, by: "ops", yes: true });
      expect(refused).toMatchObject({ ok: false, code: 1 });
      expect(refused.message).toContain("Nothing was applied");
      expect(out.text()).not.toMatch(/[\u007f]/);
      expect((await claimRow(claim))?.provider).toBeNull();

      expect(await cmdBindApply({ file, by: "ops", yes: true })).toMatchObject({ ok: true });
      expect((await claimRow(claim))?.provider).toBe(ALPHA);
      await ctx.deleteTestData(tenantId);
    });

    it("refuses without the app env", async () => {
      stubClaimProviderEnv({});
      const file = join(scratch, "noenv-apply.tsv");
      writeFileSync(file, `${BIND_FILE_HEADER}\n`);
      expect((await cmdBindApply({ file, by: "ops", yes: true })).message).toContain("needs the app's environment");
    });
  });

  // ─── sign-in through the bound provider ─────────────────────────────────

  describe("sign-in after the CLI binds", () => {
    it("add --provider X: a strict sign-in through X resolves, through another provider is refused", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("signin-x");
      captureOutput();
      expect((await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: ALPHA, yes: true })).ok).toBe(true);
      expect((await firstSignIn(claim, BRAVO)).allowed).toBe(false);
      const { allowed, email } = await firstSignIn(claim, ALPHA);
      expect(allowed).toBe(true);
      expect((await ctx.su.prisma.user.findUnique({ where: { email }, select: { tenantId: true } }))?.tenantId).toBe(tenantId);
      await ctx.deleteTestData(tenantId);
    });

    it("upgrade: NULL rows under Google + Jackson refuse boot; after --out/--apply and strict, sign-ins resolve", async () => {
      const googleTenant = await tenantWith([GOOGLE], [GOOGLE]);
      const jacksonTenant = await tenantWith([ALPHA]);
      const googleClaim = freshClaim("upgrade-google");
      const jacksonClaim = freshClaim("upgrade-jackson");
      await seedClaim(googleTenant, googleClaim, { createdBy: SIGNIN_ACTOR_LABEL });
      await seedClaim(jacksonTenant, jacksonClaim, { createdBy: SIGNIN_ACTOR_LABEL });

      stubClaimProviderEnv({ google: true, connections: [ALPHA] });
      vi.resetModules();
      await expect(import("@/auth.config")).rejects.toThrow(/AUTH_CLAIM_BINDING/);

      const file = await (async () => {
        const full = join(scratch, "upgrade.full.tsv");
        captureOutput();
        expect((await cmdBindFromMembers({ out: full })).ok).toBe(true);
        const reviewed = join(scratch, "upgrade.tsv");
        writeFileSync(reviewed, keepOnly(readFileSync(full, "utf8"), [googleClaim, jacksonClaim]));
        return reviewed;
      })();

      stubClaimProviderEnv({ google: true, connections: [ALPHA], mode: "strict" });
      // Strict before the binding lands: the NULL rows refuse — the state the boot refusal prevents.
      expect((await firstSignIn(googleClaim, GOOGLE)).allowed).toBe(false);
      expect(await cmdBindApply({ file, by: "ops", yes: true })).toMatchObject({ ok: true });

      vi.resetModules();
      await expect(import("@/auth.config")).resolves.toBeDefined();
      for (const [claim, provider, tenantId] of [
        [googleClaim, GOOGLE, googleTenant],
        [jacksonClaim, ALPHA, jacksonTenant],
      ] as const) {
        const { allowed, email } = await firstSignIn(claim, provider);
        expect(allowed).toBe(true);
        expect((await ctx.su.prisma.user.findUnique({ where: { email }, select: { tenantId: true } }))?.tenantId).toBe(tenantId);
      }
      await ctx.deleteTestData(googleTenant);
      await ctx.deleteTestData(jacksonTenant);
    });
  });

  // ─── unmapped: a real strict denial, and its ref ────────────────────────

  describe("unmapped", () => {
    const HEADING = "Claims strict binding REFUSED for the presenting provider";

    async function deniedThrough(provider: string): Promise<{ tenantId: string; claim: string; ref: unknown }> {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await ctx.createTenant();
      const claim = freshClaim("unmapped");
      await seedClaim(tenantId, claim, { provider: provider === ALPHA ? BRAVO : ALPHA });
      expect((await firstSignIn(claim, provider)).allowed).toBe(false);
      const [row] = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<Array<{ ref: unknown }>>(
          `SELECT payload->'metadata'->>'signInProviderRef' AS ref FROM audit_outbox
            WHERE payload->>'action' = 'AUTH_LOGIN_FAILURE' AND payload->'metadata'->>'claim' = $1`,
          claim,
        );
      });
      return { tenantId, claim, ref: row?.ref };
    }

    function lineFor(text: string, claim: string): string | undefined {
      const lines = text.split("\n");
      const heading = lines.findIndex((l) => l.startsWith(HEADING));
      const line = lines.findIndex((l) => l.includes(`claim="${claim}"`));
      return heading !== -1 && line > heading ? lines[line] : undefined;
    }

    it("prints the denial under the binding heading with the presenting provider mapped back; app and CLI refs agree", async () => {
      const { tenantId, claim, ref } = await deniedThrough(ALPHA);
      // The app's stored ref is the CLI's own computation under the same env.
      expect(ref).toBe(providerRef(ALPHA, deriveIdentifierPepper(process.env) as Buffer));
      const out = captureOutput();
      expect((await cmdUnmapped({ days: 1 })).ok).toBe(true);
      expect(lineFor(out.text(), claim)).toContain(`boundProvider="${BRAVO}"  signInProvider="${ALPHA}"`);
      await ctx.deleteTestData(tenantId);
    });

    it("names a ref of a removed provider unknown", async () => {
      const { tenantId, claim, ref } = await deniedThrough(ALPHA);
      stubClaimProviderEnv({ connections: [BRAVO], mode: "strict" });
      const out = captureOutput();
      await cmdUnmapped({ days: 1 });
      expect(lineFor(out.text(), claim)).toContain(`signInProvider="${SIGN_IN_REF_LABEL.UNKNOWN} (ref ${String(ref)})"`);
      await ctx.deleteTestData(tenantId);
    });

    it("says unmappable without a pepper", async () => {
      const { tenantId, claim } = await deniedThrough(ALPHA);
      vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", "");
      vi.stubEnv("AUTH_SECRET", "");
      const out = captureOutput();
      await cmdUnmapped({ days: 1 });
      expect(lineFor(out.text(), claim)).toContain(`signInProvider="${SIGN_IN_REF_LABEL.NO_PEPPER}`);
      await ctx.deleteTestData(tenantId);
    });

    it("says unmappable without the app env", async () => {
      const { tenantId, claim } = await deniedThrough(ALPHA);
      stubClaimProviderEnv({});
      const out = captureOutput();
      await cmdUnmapped({ days: 1 });
      expect(lineFor(out.text(), claim)).toContain(`signInProvider="${SIGN_IN_REF_LABEL.NO_PROVIDERS}`);
      await ctx.deleteTestData(tenantId);
    });
  });

  // ─── legacy-accounts: the upgrade check for the Known lockout class ────

  /**
   * The command counts every `saml-jackson` account in the database, so each
   * cell needs the shared dev database to hold none but its own: checked first,
   * and a leftover fails the cell by name rather than as a wrong verdict. Every
   * cell seeds inside its `try` through `seedTenant`, so a seed that throws
   * part-way still has its tenants removed in `finally` and cannot turn the
   * next cell, or the next run, red on this precondition.
   */
  describe("legacy-accounts", () => {
    const LEGACY = JACKSON_LEGACY_PROVIDER_ID;
    const LEGACY_AND_CONNECTION: ProviderEnvSpec = { legacy: true, connections: [ALPHA], mode: "strict" };
    const INSPECT_SQL = `SELECT tenant_id, user_id, id FROM accounts WHERE provider = '${LEGACY}' ORDER BY tenant_id, user_id;`;

    let seeded: string[] = [];

    beforeEach(async () => {
      seeded = [];
      const foreign = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM (SELECT DISTINCT tenant_id, user_id FROM accounts WHERE provider = $1) t`,
          LEGACY,
        );
      });
      expect(
        foreign[0]!.n,
        `the dev database already holds ${LEGACY} accounts in ${foreign[0]!.n} (tenant_id, user_id) pair(s), and ` +
          "legacy-accounts counts every one, so these cells cannot run. Inspect them with: " +
          `${INSPECT_SQL} A dev database with pre-upgrade legacy sign-ins must be cleaned of those accounts ` +
          "first; one left by this suite names a cell whose cleanup did not run.",
      ).toBe(0);
    });

    /** A tenant with one member per entry, each holding an account at every listed provider; tracked first. */
    async function seedTenant(...members: ReadonlyArray<readonly string[]>): Promise<string> {
      const tenantId = await ctx.createTenant();
      seeded.push(tenantId);
      for (const providers of members) await member(tenantId, providers);
      return tenantId;
    }

    async function cleanUpSeeded(): Promise<void> {
      for (const tenantId of seeded) await ctx.deleteTestData(tenantId);
    }

    async function auditRowsFor(tenantIds: readonly string[]): Promise<number> {
      return ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.auditOutbox.count({ where: { tenantId: { in: [...tenantIds] } } });
      });
    }

    it.each([false, true])("passes with no account at the legacy provider (--single-connection %s)", async (singleConnection) => {
      stubClaimProviderEnv(LEGACY_AND_CONNECTION);
      captureOutput();
      expect(await cmdLegacyAccounts({ singleConnection })).toMatchObject({
        ok: true,
        code: 0,
        rows: [],
        message: expect.stringContaining(`No account records ${LEGACY}`),
      });
    });

    it("passes when the legacy provider is not configured, telling the operator to confirm the app's own env", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const out = captureOutput();
      try {
        await seedTenant([LEGACY]);
        await seedTenant([LEGACY]);
        const result = await cmdLegacyAccounts();
        expect(result).toMatchObject({ ok: true, code: 0, message: expect.stringContaining("it is not configured") });
        expect(result.message).toMatch(
          /confirm that the app's runtime env \(its task definition and secrets\) sets neither AUTH_JACKSON_ID nor AUTH_JACKSON_SECRET\.$/,
        );
        expect(out.text()).toContain(`${LEGACY} is not configured in this process`);
      } finally {
        await cleanUpSeeded();
      }
    });

    it("refuses --single-connection when the legacy provider is not configured: run it with the app's env", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const out = captureOutput();
      try {
        const tenantId = await seedTenant([LEGACY]);
        const result = await cmdLegacyAccounts({ singleConnection: true });
        expect(result).toMatchObject({ ok: false, code: 1, rows: [{ tenantId, users: 1, accounts: 1 }] });
        expect(result.message).toContain(`this process's env does not configure ${LEGACY}`);
        expect(result.message).toContain("Run this check with the app's env loaded");
        expect(out.text()).toContain(`${LEGACY} is not configured in this process`);
        expect(await auditRowsFor([tenantId])).toBe(0);
      } finally {
        await cleanUpSeeded();
      }
    });

    it("refuses accounts of one tenant's users without --single-connection, in terms of connections, writing nothing", async () => {
      stubClaimProviderEnv(LEGACY_AND_CONNECTION);
      const out = captureOutput();
      try {
        const tenantId = await seedTenant([LEGACY], [LEGACY, ALPHA]);
        const result = await cmdLegacyAccounts();
        expect(result).toMatchObject({ ok: false, code: 1, rows: [{ tenantId, users: 2, accounts: 2 }] });
        expect(result.message).toContain("does not record which Jackson connection its user came through");
        expect(result.message).toContain("unset AUTH_JACKSON_ID and AUTH_JACKSON_SECRET");
        expect(result.message).toContain("That remedy applies only then");
        expect(result.message).toContain("re-run with --single-connection");
        expect(out.text()).toContain(`tenant=${tenantId}`);
        expect(await auditRowsFor([tenantId])).toBe(0);
      } finally {
        await cleanUpSeeded();
      }
    });

    it("refuses accounts spanning two tenants without --single-connection, writing nothing", async () => {
      stubClaimProviderEnv(LEGACY_AND_CONNECTION);
      captureOutput();
      try {
        const first = await seedTenant([LEGACY]);
        const second = await seedTenant([LEGACY]);
        const result = await cmdLegacyAccounts();
        expect(result).toMatchObject({ ok: false, code: 1, message: expect.stringContaining("Refusing") });
        expect(result.rows).toHaveLength(2);
        expect(await auditRowsFor([first, second])).toBe(0);
      } finally {
        await cleanUpSeeded();
      }
    });

    it("refuses accounts whose users are all active nowhere without --single-connection", async () => {
      stubClaimProviderEnv(LEGACY_AND_CONNECTION);
      const out = captureOutput();
      try {
        const departedHome = await seedTenant();
        await member(departedHome, [LEGACY], { deactivated: true });
        const result = await cmdLegacyAccounts();
        expect(result).toMatchObject({ ok: false, code: 1, rows: [{ tenantId: null, users: 1, accounts: 1 }] });
        expect(out.text()).toContain("(no active tenant)");
      } finally {
        await cleanUpSeeded();
      }
    });

    it("passes accounts of one tenant's users on --single-connection, stating what was attested", async () => {
      stubClaimProviderEnv(LEGACY_AND_CONNECTION);
      const out = captureOutput();
      try {
        const tenantId = await seedTenant([LEGACY], [LEGACY, ALPHA]);
        const result = await cmdLegacyAccounts({ singleConnection: true });
        expect(result).toMatchObject({ ok: true, code: 0, rows: [{ tenantId, users: 2, accounts: 2 }] });
        expect(result.message).toContain(
          "--single-connection attestation: before the upgrade, Jackson held exactly one connection behind saml-jackson",
        );
        expect(out.text()).toContain(`tenant=${tenantId}`);
      } finally {
        await cleanUpSeeded();
      }
    });

    it("passes accounts whose users are all active nowhere on --single-connection, printing them as their own group", async () => {
      stubClaimProviderEnv(LEGACY_AND_CONNECTION);
      const out = captureOutput();
      try {
        const departedHome = await seedTenant();
        await member(departedHome, [LEGACY], { deactivated: true });
        const result = await cmdLegacyAccounts({ singleConnection: true });
        expect(result).toMatchObject({ ok: true, code: 0, rows: [{ tenantId: null, users: 1, accounts: 1 }] });
        expect(out.text()).toContain("tenant=-\t(no active tenant)\tusers=1\taccounts=1");
      } finally {
        await cleanUpSeeded();
      }
    });

    it("passes accounts spanning two tenants on --single-connection: the flag is the decision, the grouping is evidence", async () => {
      stubClaimProviderEnv(LEGACY_AND_CONNECTION);
      const out = captureOutput();
      try {
        const first = await seedTenant([LEGACY]);
        const second = await seedTenant([LEGACY]);
        const result = await cmdLegacyAccounts({ singleConnection: true });
        expect(result).toMatchObject({ ok: true, code: 0 });
        expect(result.rows).toHaveLength(2);
        expect(out.text()).toContain(`tenant=${first}`);
        expect(out.text()).toContain(`tenant=${second}`);
      } finally {
        await cleanUpSeeded();
      }
    });

    it("groups a user active in one tenant under that tenant only, not under a tenant holding their deactivated row", async () => {
      stubClaimProviderEnv(LEGACY_AND_CONNECTION);
      const out = captureOutput();
      try {
        const active = await seedTenant();
        const userId = await member(active, [LEGACY]);
        const former = await seedTenant();
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await tx.$executeRawUnsafe(
            `INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now(), now())`,
            randomUUID(),
            former,
            userId,
          );
        });
        const result = await cmdLegacyAccounts({ singleConnection: true });
        expect(result).toMatchObject({ ok: true, code: 0, rows: [{ tenantId: active, users: 1, accounts: 1 }] });
        expect(out.text()).not.toContain(`tenant=${former}`);
      } finally {
        await cleanUpSeeded();
      }
    });

    it.each([
      ["no SSO provider is configured", () => stubClaimProviderEnv({}), "needs the app's environment"],
      [
        "the provider configuration is refused",
        () => {
          stubClaimProviderEnv({});
          vi.stubEnv("AUTH_JACKSON_CONNECTIONS", "not json");
        },
        "configuration in this process's env is refused",
      ],
    ] as const)("refuses, building no client, when %s, with or without --single-connection", async (_case, stub, text) => {
      stub();
      const create = vi.spyOn(migrationClientFactory, "create");
      for (const singleConnection of [false, true]) {
        const result = await cmdLegacyAccounts({ singleConnection });
        expect(result).toMatchObject({ ok: false, code: 1, message: expect.stringContaining(text) });
        expect(result.message).toContain("legacy-accounts");
      }
      expect(create).not.toHaveBeenCalled();
    });
  });
});
