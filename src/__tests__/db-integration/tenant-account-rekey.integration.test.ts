/**
 * Real-DB coverage for `tenant-domain rekey-accounts` — plan
 * saml-jackson-account-rekey (#954), contracts C1, C2, C3, C6 and the
 * Integration cells of its Testing strategy.
 *
 * Production `cmdRekeyAccounts` and production token crypto against the
 * worktree's own database. Tokens are seeded through `encryptAccountTokenTriple`
 * under the legacy AAD; operator bindings through `cmdAdd`/`cmdBind`; engine
 * bindings by creating the claim row and appending the event with
 * `recordTenantClaimEvent` (the label is what C2 reads).
 *
 * Races write through `ctx.su` from inside the `confirm` seam (or, for the
 * insert race, the second `shareMasterKeyWarmer.warm` call). The command takes
 * no row lock before the write, so the second connection commits immediately;
 * each race asserts the write happened (`raced`, row count 1) before it asserts
 * the refusal, so a refusal that came from anywhere else cannot pass.
 *
 * `tenant_claim_events` rows are not tenant-cascaded; `ctx.deleteTestData`
 * purges them through the sanctioned routine, and every tenant a cell creates
 * is registered for it in `afterEach`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, setBypassRlsGucs, type TestContext } from "./helpers";
import { runToken, stubClaimProviderEnv, type ProviderEnvSpec } from "@/__tests__/helpers/tenant-claim-fixtures";
import {
  BACKFILL_CREATED_BY_LABEL,
  DEREGISTER_ACTOR_LABEL,
  SIGNIN_ACTOR_LABEL,
  TENANT_CLAIM_EVENT_OPERATION,
  recordTenantClaimEvent,
  type TenantClaimEventOperation,
} from "@/lib/tenant/tenant-claim-event";
import { decryptAccountTokenTriple, encryptAccountTokenTriple } from "@/lib/crypto/account-token-crypto";
import { getCurrentMasterKeyVersion } from "@/lib/crypto/crypto-server";
import { JACKSON_LEGACY_PROVIDER_ID } from "@/lib/auth/jackson-providers";
import { SYSTEM_ACTOR_ID, SYSTEM_TENANT_ID } from "@/lib/constants/app";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";
import {
  REKEY_AUDIT_MAX_CLAIMS,
  cmdAdd,
  cmdBind,
  cmdRekeyAccounts,
  cmdRemove,
  migrationClientFactory,
  shareMasterKeyWarmer,
} from "../../../scripts/tenant-domain";

const SKIP = !process.env.DATABASE_URL;

const TO = "saml-jackson-rekey-to";
const OTHER = "saml-jackson-rekey-other";
const LEGACY = JACKSON_LEGACY_PROVIDER_ID;
const GOOGLE = "google";
const ACTION = "ACCOUNT_PROVIDER_REKEYED";

const BASE_ENV: ProviderEnvSpec = { connections: [TO] };
const LEGACY_ENV: ProviderEnvSpec = { legacy: true, connections: [TO], mode: "strict" };

type Triple = { refresh_token: string | null; access_token: string | null; id_token: string | null };
type Seeded = { accountId: string; userId: string; memberId: string; pid: string; plain: Triple };
type RunArgs = { to?: string; by?: string; apply?: boolean; yes?: boolean; confirm?: () => Promise<boolean> };

describe.skipIf(SKIP)("tenant-domain rekey-accounts (#954)", () => {
  let ctx: TestContext;
  let marker: string;
  let tenants: string[];
  let tracked: string[];
  let lines: string[];

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
    stubClaimProviderEnv(BASE_ENV);
    marker = `MK${runToken()}`;
    tenants = [];
    tracked = [];
    lines = [];
    const push = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(push);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const tenantId of tenants) await ctx.deleteTestData(tenantId);
  });

  const text = () => lines.join("\n");

  // ─── fixtures ──────────────────────────────────────────────────────────

  async function newTenant(): Promise<string> {
    const id = await ctx.createTenant();
    tenants.push(id);
    return id;
  }

  const freshClaim = (arm: string) => `${runToken()}-${arm}.rekey.example`;

  const aadOf = (userId: string, provider: string, providerAccountId: string) => ({ userId, provider, providerAccountId });

  /** A member of `tenantId`: the user, its membership row, and optionally an account at `provider`. */
  async function seedMember(tenantId: string): Promise<{ userId: string; memberId: string }> {
    const userId = await ctx.createUser(tenantId);
    const row = await ctx.su.prisma.tenantMember.findFirstOrThrow({ where: { tenantId, userId }, select: { id: true } });
    return { userId, memberId: row.id };
  }

  /**
   * One account row for `userId`, tokens encrypted through the production
   * helper under `provider`'s AAD unless `raw` overrides a field's stored value.
   */
  async function seedAccount(
    tenantId: string,
    userId: string,
    over: { provider?: string; pid?: string; plain?: Partial<Triple>; raw?: Partial<Triple> } = {},
  ): Promise<{ accountId: string; pid: string; plain: Triple }> {
    const provider = over.provider ?? LEGACY;
    const pid = over.pid ?? `pid-${marker}-${randomUUID().slice(0, 8)}`;
    const plain: Triple = {
      refresh_token: `${marker}-refresh-${pid}`,
      access_token: `${marker}-access-${pid}`,
      id_token: `${marker}-id-${pid}`,
      ...over.plain,
    };
    const enc = encryptAccountTokenTriple(plain, aadOf(userId, provider, pid));
    const row = await ctx.su.prisma.account.create({
      data: {
        userId,
        tenantId,
        type: "oidc",
        provider,
        providerAccountId: pid,
        ...enc,
        ...over.raw,
        expires_at: 1_900_000_000,
        scope: "openid email",
        token_type: "Bearer",
        session_state: `ss-${marker}`,
      },
    });
    tracked.push(row.id);
    return { accountId: row.id, pid, plain };
  }

  async function seedCandidate(
    tenantId: string,
    over: Parameters<typeof seedAccount>[2] = {},
  ): Promise<Seeded> {
    const m = await seedMember(tenantId);
    const a = await seedAccount(tenantId, m.userId, over);
    return { ...a, ...m };
  }

  async function seedClaimRow(
    tenantId: string,
    claim: string,
    over: { provider?: string | null; revokedAt?: Date | null; createdBy?: string } = {},
  ) {
    await ctx.su.prisma.tenantClaim.create({
      data: {
        tenantId,
        claim,
        createdBy: over.createdBy ?? "rekey-test",
        provider: over.provider === undefined ? null : over.provider,
        revokedAt: over.revokedAt ?? null,
      },
    });
  }

  async function recordEvent(
    claim: string,
    tenantId: string,
    label: string,
    newProvider: string | null,
    opts: { operation?: TenantClaimEventOperation; oldProvider?: string | null } = {},
  ): Promise<void> {
    await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await recordTenantClaimEvent(tx, {
        claim,
        operation: opts.operation ?? TENANT_CLAIM_EVENT_OPERATION.REGISTER,
        oldTenantId: tenantId,
        newTenantId: tenantId,
        oldRevokedAt: null,
        newRevokedAt: null,
        actorLabel: label,
        oldProvider: opts.oldProvider ?? null,
        newProvider,
      });
    });
  }

  /** A live claim bound to `provider` whose only event carries `label`. */
  async function engineBound(tenantId: string, claim: string, label: string, provider: string = TO) {
    await seedClaimRow(tenantId, claim, { provider });
    await recordEvent(claim, tenantId, label, provider);
  }

  /** The operator path: `add --provider` records a register event under the label `ops`. */
  async function operatorBound(tenantId: string, claim: string, provider: string = TO) {
    const r = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider, yes: true });
    expect(r, r.message).toMatchObject({ ok: true });
  }

  type Scenario = {
    tenantId: string;
    claim: string;
    accounts: Seeded[];
    extraUserId: string | null;
    googleClaim: string | null;
    revokedClaim: string | null;
  };

  /**
   * A tenant with an operator-bound claim, `accounts` members each holding a
   * legacy account with real tokens, and optionally: an active member holding no
   * legacy account (race b), a Google-bound claim, and a revoked claim bound to
   * another connection. Claims are set up before the members so `add`'s
   * evidence check sees an empty tenant.
   */
  async function scenario(
    opts: {
      accounts?: number;
      extraMember?: boolean;
      extraClaims?: boolean;
      claimSetup?: (tenantId: string, claim: string) => Promise<void>;
    } = {},
  ): Promise<Scenario> {
    const tenantId = await newTenant();
    const claim = freshClaim("main");
    await (opts.claimSetup ?? ((t, c) => operatorBound(t, c)))(tenantId, claim);
    let googleClaim: string | null = null;
    let revokedClaim: string | null = null;
    if (opts.extraClaims) {
      googleClaim = freshClaim("google");
      revokedClaim = freshClaim("revoked");
      await seedClaimRow(tenantId, googleClaim, { provider: GOOGLE });
      await seedClaimRow(tenantId, revokedClaim, { provider: OTHER, revokedAt: new Date() });
    }
    const accounts: Seeded[] = [];
    for (let i = 0; i < (opts.accounts ?? 2); i++) accounts.push(await seedCandidate(tenantId));
    const extraUserId = opts.extraMember ? (await seedMember(tenantId)).userId : null;
    return { tenantId, claim, accounts, extraUserId, googleClaim, revokedClaim };
  }

  const run = (s: { tenantId: string }, over: RunArgs = {}) =>
    cmdRekeyAccounts({ tenant: s.tenantId, to: TO, by: "ops", ...over });

  const snapshot = () =>
    ctx.su.prisma.account.findMany({ where: { id: { in: tracked } }, orderBy: { id: "asc" } });

  async function rekeyOutbox(tenantId: string) {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.auditOutbox.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } });
    });
    return rows.filter((r) => (r.payload as { action?: string }).action === ACTION);
  }

  async function allOutboxPayloads(tenantId: string): Promise<string> {
    const rows = await ctx.su.prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      return tx.auditOutbox.findMany({ where: { tenantId } });
    });
    return JSON.stringify(rows.map((r) => r.payload));
  }

  /** A change the CAS must see: the stored access_token replaced by another valid ciphertext of the same account. */
  const rewriteAccessToken = (a: Seeded) =>
    ctx.su.prisma.account.updateMany({
      where: { id: a.accountId },
      data: {
        access_token: encryptAccountTokenTriple(
          { refresh_token: null, access_token: `other-${marker}`, id_token: null },
          aadOf(a.userId, LEGACY, a.pid),
        ).access_token,
      },
    });

  const events = (claim: string) => ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim }, orderBy: { seq: "asc" } });

  const rowIds = (r: { rows?: unknown[] }) => (r.rows as { accountId: string }[]).map((x) => x.accountId);

  /** Preview and apply both refuse with code 1 and leave the accounts and the tenant's outbox as they were. */
  async function expectRefusedBoth(s: { tenantId: string }, fragments: readonly (string | RegExp)[]) {
    const before = await snapshot();
    for (const flags of [{}, { apply: true, yes: true }] as RunArgs[]) {
      lines.length = 0;
      const r = await run(s, flags);
      expect(r, r.message).toMatchObject({ ok: false, code: 1 });
      for (const f of fragments) {
        if (typeof f === "string") expect(text()).toContain(f);
        else expect(text()).toMatch(f);
      }
      expect(await snapshot()).toEqual(before);
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
    }
  }

  async function expectPreviewAllowed(s: { tenantId: string }) {
    const r = await run(s);
    expect(r, r.message).toMatchObject({ ok: true, code: 0 });
    return r;
  }

  /** The value a stored token must not be seen as in any output. */
  function expectNoLeak(output: string, s: Scenario, extra: readonly string[] = []) {
    expect(output).not.toContain(marker);
    for (const a of s.accounts) {
      expect(output).not.toContain(a.pid);
      for (const v of Object.values(a.plain)) if (v) expect(output).not.toContain(v);
    }
    for (const v of extra) expect(output).not.toContain(v);
  }

  // ─── C1 steps 1-4 ──────────────────────────────────────────────────────

  describe("C1 steps 1-4: refusals before any client is built", () => {
    it("missing MIGRATION_DATABASE_URL: refuses and builds no client; the paired run with it set passes", async () => {
      const s = await scenario();
      const create = vi.spyOn(migrationClientFactory, "create");
      vi.stubEnv("MIGRATION_DATABASE_URL", "");
      const refused = await run(s);
      expect(refused).toMatchObject({ ok: false, code: 1, message: expect.stringContaining("MIGRATION_DATABASE_URL is required") });
      expect(create).not.toHaveBeenCalled();
      vi.unstubAllEnvs();
      stubClaimProviderEnv(BASE_ENV);
      if (!process.env.MIGRATION_DATABASE_URL) vi.stubEnv("MIGRATION_DATABASE_URL", process.env.DATABASE_URL as string);
      await expectPreviewAllowed(s);
      expect(create).toHaveBeenCalled();
    });

    it.each(["", "   ", " SignIn ", "backfill", "db-delete"])("bad --by %j: refuses and builds no client", async (by) => {
      const s = await scenario();
      const create = vi.spyOn(migrationClientFactory, "create");
      const refused = await run(s, { by, apply: true, yes: true });
      expect(refused).toMatchObject({ ok: false, code: 1 });
      expect(create).not.toHaveBeenCalled();
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
      await expectPreviewAllowed(s);
    });

    it("no app env: refuses naming the command and builds no client", async () => {
      const s = await scenario();
      stubClaimProviderEnv({});
      const create = vi.spyOn(migrationClientFactory, "create");
      const refused = await run(s);
      expect(refused).toMatchObject({ ok: false, code: 1, message: expect.stringContaining("rekey-accounts needs the app's environment") });
      expect(create).not.toHaveBeenCalled();
    });

    it.each([
      ["saml-jackson", LEGACY_ENV],
      ["google", { google: true, connections: [TO], mode: "strict" } as ProviderEnvSpec],
      ["saml-jackson-x", BASE_ENV],
    ] as const)("--to %s is refused as not a configured connection provider, with nothing written", async (to, env) => {
      const s = await scenario();
      stubClaimProviderEnv(env);
      const before = await snapshot();
      const create = vi.spyOn(migrationClientFactory, "create");
      for (const flags of [{}, { apply: true, yes: true }] as RunArgs[]) {
        const refused = await run(s, { to, ...flags });
        expect(refused).toMatchObject({ ok: false, code: 1, message: expect.stringContaining("is not a configured Jackson connection provider") });
        expect(refused.message).toContain(`Configured: ${TO}`);
      }
      expect(create).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
      // Paired allow: the configured connection passes under the same env.
      await expectPreviewAllowed(s);
    });

    it("prints the step-4 caveat, and the legacy reminder only when saml-jackson is configured", async () => {
      const s = await scenario();
      await expectPreviewAllowed(s);
      expect(text()).toContain(`"${TO}" is configured in this process's env`);
      expect(text()).toContain("AUTH_JACKSON_CONNECTIONS too");
      expect(text()).not.toContain("run `legacy-accounts` after this");

      lines.length = 0;
      stubClaimProviderEnv(LEGACY_ENV);
      await expectPreviewAllowed(s);
      expect(text()).toContain(`${LEGACY} is configured in this process's env`);
      expect(text()).toContain("run `legacy-accounts` after this");
    });

    it("refuses an unknown tenant and the sentinel tenant", async () => {
      const unknown = await run({ tenantId: randomUUID() });
      expect(unknown).toMatchObject({ ok: false, code: 1, message: expect.stringContaining("Tenant not found") });
      const sentinel = await run({ tenantId: SYSTEM_TENANT_ID });
      expect(sentinel).toMatchObject({ ok: false, code: 1, message: expect.stringContaining("sentinel tenant") });
    });
  });

  // ─── C2 ────────────────────────────────────────────────────────────────

  describe("C2: claim-binding consistency check", () => {
    const REASON_NOT_OPERATOR = "not bound by an operator";
    const REASON_OTHER = "bound to another provider";
    const REASON_UNBOUND = "unbound";

    it("allow baseline: one operator-bound claim passes, and the preview shows its provider and deciding label", async () => {
      const s = await scenario({ extraClaims: true });
      await expectPreviewAllowed(s);
      expect(text()).toContain(`claim=${s.claim}\tprovider=${TO}`);
      expect(text()).toContain('by "ops"');
      expect(text()).toContain(`claim=${s.googleClaim}\tprovider=${GOOGLE}`);
      expect(text()).not.toContain("engine-written");
      expect(text()).not.toContain("attested after sign-in registration");
    });

    it("refuses a tenant with no claim, even with candidates", async () => {
      const s = await scenario({ claimSetup: async () => {} });
      await expectRefusedBoth(s, ["no live claim of the tenant is bound to"]);
    });

    it("refuses when the only live claim is unbound", async () => {
      const s = await scenario({ claimSetup: (t, c) => seedClaimRow(t, c, { provider: null }) });
      await expectRefusedBoth(s, [`claim ${s.claim} (provider none): ${REASON_UNBOUND}`, "no live claim of the tenant is bound to"]);
    });

    it("refuses an unbound Google-domain claim beside an operator-bound claim to the target (R-b)", async () => {
      const s = await scenario({
        claimSetup: async (t, c) => {
          await operatorBound(t, c);
          await seedClaimRow(t, `${runToken()}-g.rekey.example`, { provider: null });
        },
      });
      await expectRefusedBoth(s, [`(provider none): ${REASON_UNBOUND}`]);
    });

    it.each([
      [OTHER, `provider "${OTHER}"`],
      [LEGACY, `provider "${LEGACY}"`],
    ])("refuses a live claim bound to %s beside a claim bound to the target (R-b)", async (other, fragment) => {
      const s = await scenario({
        claimSetup: async (t, c) => {
          await operatorBound(t, c);
          await engineBound(t, `${runToken()}-o.rekey.example`, "ops", other);
        },
      });
      await expectRefusedBoth(s, [fragment, REASON_OTHER]);
    });

    it.each([
      ["signin", SIGNIN_ACTOR_LABEL, TENANT_CLAIM_EVENT_OPERATION.REGISTER],
      ["backfill", BACKFILL_CREATED_BY_LABEL, TENANT_CLAIM_EVENT_OPERATION.REGISTER],
      ["db-delete", DEREGISTER_ACTOR_LABEL, TENANT_CLAIM_EVENT_OPERATION.DEREGISTER],
    ] as const)("refuses a claim bound to the target whose deciding event is labelled %s (R-c)", async (_name, label, operation) => {
      const s = await scenario({
        claimSetup: async (t, c) => {
          await seedClaimRow(t, c, { provider: TO });
          await recordEvent(c, t, label, TO, { operation });
        },
      });
      await expectRefusedBoth(s, [REASON_NOT_OPERATOR, `by "${label}" (engine-written)`]);
    });

    it("refuses an operator binding followed by a later signin event carrying new_provider = target (R-c)", async () => {
      const s = await scenario({
        claimSetup: async (t, c) => {
          await operatorBound(t, c);
          await recordEvent(c, t, SIGNIN_ACTOR_LABEL, TO, { operation: TENANT_CLAIM_EVENT_OPERATION.REBIND, oldProvider: TO });
        },
      });
      await expectRefusedBoth(s, [REASON_NOT_OPERATOR]);
    });

    it("refuses a claim bound to the target with no events at all (R-c)", async () => {
      const s = await scenario({ claimSetup: (t, c) => seedClaimRow(t, c, { provider: TO }) });
      await expectRefusedBoth(s, [REASON_NOT_OPERATOR, "no binding event"]);
    });

    it("refuses a revoked claim bound to the target as the only one (R-a)", async () => {
      const s = await scenario({
        claimSetup: async (t, c) => {
          await seedClaimRow(t, c, { provider: TO, revokedAt: new Date() });
          await recordEvent(c, t, "ops", TO);
        },
      });
      await expectRefusedBoth(s, ["no live claim of the tenant is bound to"]);
    });

    it("allows: a bind --accept-unused-provider binding", async () => {
      const s = await scenario({
        claimSetup: async (t, c) => {
          await seedClaimRow(t, c);
          const r = await cmdBind({ claim: c, provider: TO, by: "ops", acceptUnusedProvider: true, yes: true });
          expect(r, r.message).toMatchObject({ ok: true });
        },
      });
      await expectPreviewAllowed(s);
    });

    it("allows: a signin binding followed by the operator's attestation, and marks it", async () => {
      const s = await scenario({
        claimSetup: async (t, c) => {
          await engineBound(t, c, SIGNIN_ACTOR_LABEL);
        },
      });
      await expectRefusedBoth(s, [REASON_NOT_OPERATOR]);
      const attested = await cmdBind({ claim: s.claim, provider: TO, by: "ops", acceptUnusedProvider: true, yes: true });
      expect(attested, attested.message).toMatchObject({ ok: true });
      lines.length = 0;
      await expectPreviewAllowed(s);
      expect(text()).toContain(`claim=${s.claim}`);
      expect(text()).toContain("attested after sign-in registration");
    });

    it("allows: a Google-bound claim beside the operator-bound one", async () => {
      const s = await scenario({ extraClaims: false });
      await seedClaimRow(s.tenantId, freshClaim("g"), { provider: GOOGLE });
      await expectPreviewAllowed(s);
    });

    it("allows: a revoked claim bound elsewhere beside a live operator binding", async () => {
      const s = await scenario({ extraClaims: true });
      expect((await ctx.su.prisma.tenantClaim.findUniqueOrThrow({ where: { claim: s.revokedClaim! } })).revokedAt).not.toBeNull();
      await expectPreviewAllowed(s);
    });

    it("allows: an operator binding followed by an operator revoke and add --provider (un-revoke)", async () => {
      const s = await scenario({
        accounts: 0,
        claimSetup: async (t, c) => {
          await operatorBound(t, c);
          const removed = await cmdRemove({ tenant: t, domain: c, by: "ops", yes: true });
          expect(removed, removed.message).toMatchObject({ ok: true });
          await operatorBound(t, c);
        },
      });
      await seedCandidate(s.tenantId);
      const r = await expectPreviewAllowed(s);
      expect(r.rows).toHaveLength(1);
      expect(text()).toContain('by "ops"');
    });

    it("a C2 refusal with zero candidates exits 1, preview and apply alike", async () => {
      const s = await scenario({ accounts: 0, claimSetup: (t, c) => seedClaimRow(t, c, { provider: null }) });
      await expectRefusedBoth(s, [REASON_UNBOUND]);
    });
  });

  // ─── decrypt ───────────────────────────────────────────────────────────

  describe("token decryption", () => {
    async function withBadAccount(raw: (good: Seeded, userId: string) => Partial<Triple>) {
      const s = await scenario({ accounts: 1 });
      const bad = await seedCandidate(s.tenantId);
      s.accounts.push(bad);
      const patch = raw(bad, bad.userId);
      await ctx.su.prisma.account.update({ where: { id: bad.accountId }, data: patch });
      return { s, bad };
    }

    it("a bad tag is refused as TAMPERED, naming the account and field; the paired good tenant passes", async () => {
      const { s, bad } = await withBadAccount((a) => ({
        // A valid envelope sealed under a different AAD: structurally fine, tag fails.
        access_token: encryptAccountTokenTriple(
          { refresh_token: null, access_token: "x", id_token: null },
          aadOf(randomUUID(), LEGACY, a.pid),
        ).access_token,
      }));
      await expectRefusedBoth(s, [`account ${bad.accountId}: access_token does not decrypt (TAMPERED)`]);
      expect(text()).not.toContain("(CORRUPT)");
      const good = await scenario({ accounts: 1 });
      await expectPreviewAllowed(good);
    });

    it("an unknown key version is refused as KEY_UNAVAILABLE", async () => {
      const { s, bad } = await withBadAccount((a) => ({
        refresh_token: encryptAccountTokenTriple(
          a.plain,
          aadOf(a.userId, LEGACY, a.pid),
        ).refresh_token!.replace(/^psoenc1:\d+:/, "psoenc1:9999:"),
      }));
      await expectRefusedBoth(s, [`account ${bad.accountId}: refresh_token does not decrypt (KEY_UNAVAILABLE)`]);
    });

    it("a non-envelope value is refused as CORRUPT", async () => {
      const { s, bad } = await withBadAccount(() => ({ id_token: "plain-text-not-an-envelope" }));
      await expectRefusedBoth(s, [`account ${bad.accountId}: id_token does not decrypt (CORRUPT)`]);
    });

    it("a triple mixing one CORRUPT field with valid ones refuses as CORRUPT for that field only", async () => {
      const { s, bad } = await withBadAccount(() => ({ access_token: "psoenc1:no-delimiter-here" }));
      await expectRefusedBoth(s, [`account ${bad.accountId}: access_token does not decrypt (CORRUPT)`]);
      expect((await run(s)).message).toContain("1 reason(s)");
      expect(text()).not.toContain(`account ${bad.accountId}: refresh_token`);
      expect(text()).not.toContain(`account ${bad.accountId}: id_token`);
    });

    it("a null access_token beside non-null fields moves and stays null", async () => {
      const s = await scenario({ accounts: 1 });
      const a = await seedCandidate(s.tenantId, { plain: { access_token: null } });
      expect((await ctx.su.prisma.account.findUniqueOrThrow({ where: { id: a.accountId } })).access_token).toBeNull();
      const r = await run(s, { apply: true, yes: true });
      expect(r, r.message).toMatchObject({ ok: true, code: 0 });
      const row = await ctx.su.prisma.account.findUniqueOrThrow({ where: { id: a.accountId } });
      expect(row).toMatchObject({ provider: TO, access_token: null });
      expect(decryptAccountTokenTriple(row, aadOf(a.userId, TO, a.pid))).toEqual(a.plain);
    });
  });

  // ─── conflicts ─────────────────────────────────────────────────────────

  describe("conflicts at the target", () => {
    it("an existing row at (target, providerAccountId) is refused", async () => {
      const s = await scenario();
      const other = await seedMember(s.tenantId);
      const clash = await seedAccount(s.tenantId, other.userId, { provider: TO, pid: s.accounts[0]!.pid });
      await expectRefusedBoth(s, [`account ${s.accounts[0]!.accountId}: account ${clash.accountId} at the target already has its account id`]);
      await ctx.su.prisma.account.delete({ where: { id: clash.accountId } });
      await expectPreviewAllowed(s);
    });

    it("a candidate whose user already holds another row at the target is refused", async () => {
      const s = await scenario();
      const held = await seedAccount(s.tenantId, s.accounts[0]!.userId, { provider: TO });
      await expectRefusedBoth(s, [`its user already holds account ${held.accountId} at the target`]);
      await ctx.su.prisma.account.delete({ where: { id: held.accountId } });
      await expectPreviewAllowed(s);
    });
  });

  // ─── flow ──────────────────────────────────────────────────────────────

  describe("preview, apply and confirmation", () => {
    it("preview lists the candidates, exits 0 and writes nothing", async () => {
      const s = await scenario({ accounts: 3 });
      const before = await snapshot();
      const r = await run(s);
      expect(r).toMatchObject({ ok: true, code: 0, message: expect.stringContaining("Dry run") });
      expect(rowIds(r)).toEqual(expect.arrayContaining(s.accounts.map((a) => a.accountId)));
      expect(rowIds(r)).toHaveLength(3);
      expect(r.rows).toEqual(
        expect.arrayContaining(s.accounts.map((a) => ({ accountId: a.accountId, userId: a.userId, memberId: a.memberId, tokens: ["refresh_token", "access_token", "id_token"] }))),
      );
      expect(await snapshot()).toEqual(before);
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
    });

    it("declining at the confirmation writes nothing and exits 1", async () => {
      const s = await scenario();
      const before = await snapshot();
      let asked = false;
      const r = await run(s, {
        apply: true,
        confirm: async () => {
          asked = true;
          return false;
        },
      });
      expect(asked).toBe(true);
      expect(r).toMatchObject({ ok: false, code: 1, message: "Aborted: not confirmed." });
      expect(await snapshot()).toEqual(before);
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
    });

    it("zero candidates with a passing check: apply exits 0 with nothing to do", async () => {
      const s = await scenario({ accounts: 0 });
      const r = await run(s, { apply: true, yes: true });
      expect(r).toMatchObject({ ok: true, code: 0, rows: [], message: expect.stringContaining("nothing to apply") });
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
    });

    it("re-running apply after success finds zero candidates, exits 0 and moves nothing", async () => {
      const s = await scenario();
      expect(await run(s, { apply: true, yes: true })).toMatchObject({ ok: true, code: 0 });
      const after = await snapshot();
      const outbox = await rekeyOutbox(s.tenantId);
      expect(outbox).toHaveLength(2);
      const again = await run(s, { apply: true, yes: true });
      expect(again).toMatchObject({ ok: true, code: 0, rows: [] });
      expect(await snapshot()).toEqual(after);
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(2);
    });
  });

  // ─── moved-set boundaries ──────────────────────────────────────────────

  describe("who moves", () => {
    it("moves exactly the active members' legacy accounts; every other account is byte-identical", async () => {
      const s = await scenario({ accounts: 2 });
      // Same users' accounts at another provider: untouched.
      const sameUserOther = await seedAccount(s.tenantId, s.accounts[0]!.userId, { provider: GOOGLE });
      // An inactive member's legacy account.
      const inactive = await seedCandidate(s.tenantId);
      await ctx.su.prisma.tenantMember.updateMany({ where: { tenantId: s.tenantId, userId: inactive.userId }, data: { deactivatedAt: new Date() } });
      // Another tenant's active member's legacy account.
      const otherTenant = await newTenant();
      const foreign = await seedCandidate(otherTenant);

      const before = await snapshot();
      const byId = (rows: Awaited<ReturnType<typeof snapshot>>) => new Map(rows.map((r) => [r.id, r]));
      const r = await run(s, { apply: true, yes: true });
      expect(r, r.message).toMatchObject({ ok: true, code: 0 });
      expect(rowIds(r).sort()).toEqual(s.accounts.map((a) => a.accountId).sort());

      const after = byId(await snapshot());
      const prior = byId(before);
      for (const a of s.accounts) expect(after.get(a.accountId)).toMatchObject({ provider: TO });
      for (const id of [sameUserOther.accountId, inactive.accountId, foreign.accountId]) {
        expect(after.get(id)).toEqual(prior.get(id));
      }
      expect(after.get(inactive.accountId)!.provider).toBe(LEGACY);
      expect(after.get(foreign.accountId)!.provider).toBe(LEGACY);
      expect(after.get(sameUserOther.accountId)!.provider).toBe(GOOGLE);
    });

    it("after the move the tokens decrypt under the new AAD only, and every other column is unchanged", async () => {
      const s = await scenario({ accounts: 1 });
      const a = s.accounts[0]!;
      const [before] = await snapshot();
      const r = await run(s, { apply: true, yes: true });
      expect(r, r.message).toMatchObject({ ok: true });
      const row = await ctx.su.prisma.account.findUniqueOrThrow({ where: { id: a.accountId } });

      expect(decryptAccountTokenTriple(row, aadOf(a.userId, TO, a.pid))).toEqual(a.plain);
      expect(() => decryptAccountTokenTriple(row, aadOf(a.userId, LEGACY, a.pid))).toThrow();
      expect(row.provider).toBe(TO);
      const { provider: _p, refresh_token: _r, access_token: _a, id_token: _i, ...rest } = row;
      const { provider: _bp, refresh_token: _br, access_token: _ba, id_token: _bi, ...restBefore } = before!;
      expect(rest).toEqual(restBefore);
      expect(row.expires_at).toBe(1_900_000_000);
      expect(row.scope).toBe("openid email");
      expect(row.token_type).toBe("Bearer");
      expect(row.session_state).toBe(`ss-${marker}`);
      expect(row.type).toBe("oidc");
      // Re-encrypted, not copied.
      expect(row.refresh_token).not.toBe(before!.refresh_token);
    });
  });

  // ─── audit ─────────────────────────────────────────────────────────────

  describe("audit rows (C3)", () => {
    it("writes one row per moved account with the C3 shape and one runId across the run", async () => {
      const s = await scenario({ accounts: 3 });
      const r = await run(s, { apply: true, yes: true, by: "ops-oncall" });
      expect(r, r.message).toMatchObject({ ok: true });
      const rows = await rekeyOutbox(s.tenantId);
      expect(rows).toHaveLength(3);
      const payloads = rows.map((x) => x.payload as Record<string, unknown> & { metadata: Record<string, unknown> });
      const runIds = new Set(payloads.map((p) => p.metadata.runId));
      expect(runIds.size).toBe(1);
      expect([...runIds][0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.message).toContain(String([...runIds][0]));
      for (const a of s.accounts) {
        const p = payloads.find((x) => x.targetId === a.memberId)!;
        expect(p).toMatchObject({
          scope: "TENANT",
          action: ACTION,
          userId: SYSTEM_ACTOR_ID,
          actorType: "SYSTEM",
          targetType: AUDIT_TARGET_TYPE.TENANT_MEMBER,
          targetId: a.memberId,
        });
        expect(Object.keys(p.metadata).sort()).toEqual(
          ["by", "claims", "claimsOmitted", "movedUserId", "previousProvider", "provider", "runId"],
        );
        expect(p.metadata).toMatchObject({
          movedUserId: a.userId,
          previousProvider: LEGACY,
          provider: TO,
          claims: [s.claim],
          claimsOmitted: 0,
          by: "ops-oncall",
        });
      }
    });

    it("12 max-length claims bound to the target: the metadata names 10, counts 2 omitted, and keeps movedUserId and runId", async () => {
      const prefix = runToken();
      const claims = Array.from({ length: 12 }, (_, i) => {
        const head = `${prefix}-${String(i).padStart(2, "0")}-`;
        return head + "a".repeat(255 - head.length);
      });
      const s = await scenario({
        accounts: 1,
        claimSetup: async (t) => {
          for (const c of claims) {
            expect(c).toHaveLength(255);
            await seedClaimRow(t, c, { provider: TO });
            await recordEvent(c, t, "ops", TO);
          }
        },
      });
      const r = await run(s, { apply: true, yes: true });
      expect(r, r.message).toMatchObject({ ok: true });
      const [row] = await rekeyOutbox(s.tenantId);
      const metadata = (row!.payload as { metadata: Record<string, unknown> }).metadata;
      expect(metadata.claims).toEqual(claims.slice(0, REKEY_AUDIT_MAX_CLAIMS));
      expect(metadata).toMatchObject({ claimsOmitted: 2, movedUserId: s.accounts[0]!.userId, runId: expect.any(String), provider: TO, by: "ops" });
    });

    it("writes no row after a preview, a refusal, a decline or a rollback", async () => {
      const s = await scenario({ accounts: 2, extraClaims: true });
      await run(s);
      await run(s, { to: "saml-jackson-x", apply: true, yes: true });
      await run(s, { apply: true, confirm: async () => false });
      const victim = s.accounts[1]!;
      let raced = false;
      const r = await run(s, {
        apply: true,
        confirm: async () => {
          expect((await rewriteAccessToken(victim)).count).toBe(1);
          raced = true;
          return true;
        },
      });
      expect(raced).toBe(true);
      expect(r.ok).toBe(false);
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
    });
  });

  // ─── key warming (C6) ──────────────────────────────────────────────────

  describe("key warming seam", () => {
    it("is called before the verify pass with the snapshot's versions, and again after the confirmation", async () => {
      const s = await scenario();
      const realWarm = shareMasterKeyWarmer.warm;
      const calls: { versions: number[]; confirmed: boolean; listed: boolean }[] = [];
      let confirmed = false;
      const spy = vi.spyOn(shareMasterKeyWarmer, "warm").mockImplementation(async (versions) => {
        calls.push({ versions: [...versions], confirmed, listed: text().includes("Accounts at saml-jackson") });
        return realWarm(versions);
      });
      const r = await run(s, {
        apply: true,
        confirm: async () => {
          confirmed = true;
          return true;
        },
      });
      expect(r, r.message).toMatchObject({ ok: true });
      expect(spy).toHaveBeenCalledTimes(2);
      const current = getCurrentMasterKeyVersion();
      expect(calls[0]).toEqual({ versions: [current], confirmed: false, listed: false });
      expect(calls[1]).toEqual({ versions: [current], confirmed: true, listed: true });
    });

    it("a version reported unavailable in the verify pass refuses as KEY_UNAVAILABLE", async () => {
      const s = await scenario();
      const current = getCurrentMasterKeyVersion();
      // Every call: expectRefusedBoth runs the preview and the apply, and the
      // apply refuses in its verify pass, before a second call could happen.
      vi.spyOn(shareMasterKeyWarmer, "warm").mockResolvedValue(new Map([[current, "unavailable" as const]]));
      await expectRefusedBoth(s, ["(KEY_UNAVAILABLE)"]);
    });

    it("a version reported unavailable only by the second call aborts the apply with nothing written", async () => {
      const s = await scenario();
      const before = await snapshot();
      const realWarm = shareMasterKeyWarmer.warm;
      const current = getCurrentMasterKeyVersion();
      let n = 0;
      vi.spyOn(shareMasterKeyWarmer, "warm").mockImplementation(async (versions) => {
        n += 1;
        return n === 2 ? new Map([[current, "unavailable" as const]]) : realWarm(versions);
      });
      const r = await run(s, { apply: true, yes: true });
      expect(n).toBe(2);
      expect(r).toMatchObject({ ok: false, code: 1, message: expect.stringContaining("could not be loaded after the confirmation") });
      expect(await snapshot()).toEqual(before);
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
    });
  });

  // ─── NF3 ───────────────────────────────────────────────────────────────

  describe("NF3: no token, ciphertext or providerAccountId in any output", () => {
    async function ciphertexts(): Promise<string[]> {
      return (await snapshot()).flatMap((r) => [r.refresh_token, r.access_token, r.id_token].filter((v): v is string => v !== null));
    }

    it("allow path: stdout, stderr and the outbox payload carry none of them", async () => {
      const s = await scenario();
      const olds = await ciphertexts();
      const r = await run(s, { apply: true, yes: true });
      expect(r, r.message).toMatchObject({ ok: true });
      const news = await ciphertexts();
      expect(news).not.toEqual(olds);
      const output = `${text()}\n${r.message}\n${await allOutboxPayloads(s.tenantId)}`;
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(2);
      expectNoLeak(output, s, [...olds, ...news]);
    });

    it("TAMPERED refusal path", async () => {
      const s = await scenario({ accounts: 2 });
      const victim = s.accounts[1]!;
      await ctx.su.prisma.account.update({
        where: { id: victim.accountId },
        data: {
          access_token: encryptAccountTokenTriple({ refresh_token: null, access_token: "x", id_token: null }, aadOf(randomUUID(), LEGACY, victim.pid)).access_token,
        },
      });
      const olds = await ciphertexts();
      const r = await run(s, { apply: true, yes: true });
      expect(r).toMatchObject({ ok: false, code: 1 });
      expect(text()).toContain("(TAMPERED)");
      expectNoLeak(`${text()}\n${r.message}\n${await allOutboxPayloads(s.tenantId)}`, s, olds);
    });

    it("race path", async () => {
      const s = await scenario({ accounts: 2 });
      const victim = s.accounts[1]!;
      let olds: string[] = [];
      const r = await run(s, {
        apply: true,
        confirm: async () => {
          expect((await rewriteAccessToken(victim)).count).toBe(1);
          olds = await ciphertexts();
          return true;
        },
      });
      expect(r.ok).toBe(false);
      expect(olds.length).toBeGreaterThan(0);
      expectNoLeak(`${text()}\n${r.message}\n${await allOutboxPayloads(s.tenantId)}`, s, olds);
    });

    it.each([1, 2])("unexpected error from warm call %i: a generic message by class, without the error's text", async (failingCall) => {
      const s = await scenario();
      const realWarm = shareMasterKeyWarmer.warm;
      const pid = s.accounts[0]!.pid;
      let n = 0;
      vi.spyOn(shareMasterKeyWarmer, "warm").mockImplementation(async (versions) => {
        n += 1;
        if (n === failingCall) throw new Error(`driver quoted the row: provider_account_id=${pid} ${s.accounts[0]!.plain.refresh_token}`);
        return realWarm(versions);
      });
      const before = await snapshot();
      const r = await run(s, { apply: true, yes: true });
      expect(n).toBe(failingCall);
      expect(r).toMatchObject({ ok: false, code: 1, message: "rekey-accounts failed; nothing was moved (Error)." });
      expectNoLeak(`${text()}\n${r.message}\n${await allOutboxPayloads(s.tenantId)}`, s);
      expect(await snapshot()).toEqual(before);
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
    });
  });

  // ─── races ─────────────────────────────────────────────────────────────

  describe("races during the confirmation", () => {
    const CHANGED = "changed during the confirmation; nothing was moved";

    async function raceScenario() {
      const s = await scenario({ accounts: 3, extraMember: true, extraClaims: true });
      const preview = await expectPreviewAllowed(s);
      // The database's order, not a test-side sort: ids mix CUID and UUID.
      const victim = rowIds(preview).at(-1)!;
      return { s, victim, victimSeed: s.accounts.find((a) => a.accountId === victim)! };
    }

    /**
     * Run apply with `write` happening mid-run and assert the shared outcome:
     * the race happened, its row count was 1, every account row equals what the
     * second connection left (earlier rows were written, then rolled back), and
     * no audit row exists.
     */
    async function applyWithRace(
      s: Scenario,
      write: () => Promise<number>,
      via: "confirm" | "second-warm" = "confirm",
    ) {
      let raced = false;
      let written = -1;
      let after: Awaited<ReturnType<typeof snapshot>> = [];
      const doRace = async () => {
        written = await write();
        after = await snapshot();
        raced = true;
      };
      let result;
      if (via === "confirm") {
        result = await run(s, {
          apply: true,
          confirm: async () => {
            await doRace();
            return true;
          },
        });
      } else {
        const realWarm = shareMasterKeyWarmer.warm;
        let n = 0;
        vi.spyOn(shareMasterKeyWarmer, "warm").mockImplementation(async (versions) => {
          n += 1;
          if (n === 2) await doRace();
          return realWarm(versions);
        });
        result = await run(s, { apply: true, yes: true });
      }
      expect(raced, "the concurrent write did not run").toBe(true);
      expect(written).toBe(1);
      expect(result).toMatchObject({ ok: false, code: 1 });
      expect(await snapshot()).toEqual(after);
      const candidateIds = new Set(s.accounts.map((a) => a.accountId));
      expect(after.filter((r) => candidateIds.has(r.id) && r.provider === TO)).toHaveLength(0);
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(0);
      return result;
    }

    const casMessage = (id: string) => `Account ${id} changed after it was read; nothing was moved.`;

    it("(a) ciphertext CAS: a rewritten access_token fails the write naming the account, rolling back the earlier rows", async () => {
      const { s, victim, victimSeed } = await raceScenario();
      const result = await applyWithRace(s, async () => (await rewriteAccessToken(victimSeed)).count);
      expect(result.message).toContain(casMessage(victim));
    });

    it("(b) user_id CAS: re-pointing the victim to another active member fails the write, not the re-read", async () => {
      const { s, victim } = await raceScenario();
      const result = await applyWithRace(s, async () =>
        (await ctx.su.prisma.account.updateMany({ where: { id: victim }, data: { userId: s.extraUserId! } })).count,
      );
      expect(result.message).toContain(casMessage(victim));
    });

    it("(c) insert at the target key via the second warm call: the unique violation maps to its message, with no pid", async () => {
      const { s, victim, victimSeed } = await raceScenario();
      const result = await applyWithRace(
        s,
        async () => {
          const u = await ctx.createUser(s.tenantId);
          await seedAccount(s.tenantId, u, { provider: TO, pid: victimSeed.pid });
          return 1;
        },
        "second-warm",
      );
      expect(result.message).toContain(`Another account at "${TO}" appeared during the run`);
      expect(result.message).toContain("nothing was moved");
      expect(`${result.message}\n${text()}`).not.toContain(victimSeed.pid);
      expect(victim).toBeTruthy();
    });

    describe("(d) one cell per compared term of the step-9 re-read", () => {
      const eventCountDelta = async (claim: string, fn: () => Promise<void>): Promise<number> => {
        const n = (await events(claim)).length;
        await fn();
        return (await events(claim)).length - n;
      };

      it.each([
        [
          "a claim's provider is rebound",
          async (s: Scenario) =>
            (await ctx.su.prisma.tenantClaim.updateMany({ where: { claim: s.googleClaim! }, data: { provider: TO } })).count,
        ],
        [
          "a claim is revoked",
          async (s: Scenario) =>
            (await ctx.su.prisma.tenantClaim.updateMany({ where: { claim: s.googleClaim! }, data: { revokedAt: new Date() } })).count,
        ],
        [
          "an unbound claim is added",
          async (s: Scenario) => {
            await seedClaimRow(s.tenantId, freshClaim("added"), { provider: null });
            return 1;
          },
        ],
        [
          "a revoked claim bound elsewhere is un-revoked",
          async (s: Scenario) =>
            (await ctx.su.prisma.tenantClaim.updateMany({ where: { claim: s.revokedClaim! }, data: { revokedAt: null } })).count,
        ],
        [
          "an operator attestation is appended to a claim bound to the target",
          async (s: Scenario) =>
            eventCountDelta(s.claim, () =>
              recordEvent(s.claim, s.tenantId, "ops-second", TO, { operation: TENANT_CLAIM_EVENT_OPERATION.REBIND, oldProvider: TO }),
            ),
        ],
        [
          "a signin event with new_provider = target is recorded on an operator-bound claim",
          async (s: Scenario) =>
            eventCountDelta(s.claim, () =>
              recordEvent(s.claim, s.tenantId, SIGNIN_ACTOR_LABEL, TO, { operation: TENANT_CLAIM_EVENT_OPERATION.REBIND, oldProvider: TO }),
            ),
        ],
        [
          "a candidate's membership is deactivated",
          async (s: Scenario) =>
            (await ctx.su.prisma.tenantMember.updateMany({ where: { tenantId: s.tenantId, userId: s.accounts[0]!.userId }, data: { deactivatedAt: new Date() } })).count,
        ],
        [
          "a row appears at (target, a candidate's providerAccountId)",
          async (s: Scenario) => {
            const u = await ctx.createUser(s.tenantId);
            await seedAccount(s.tenantId, u, { provider: TO, pid: s.accounts[0]!.pid });
            return 1;
          },
        ],
      ])("%s", async (_name, write) => {
        const { s } = await raceScenario();
        const result = await applyWithRace(s, () => write(s));
        expect(result.message).toContain(CHANGED);
      });
    });

    it("(e) control: a write to a non-candidate account during the confirmation does not abort the run", async () => {
      const { s } = await raceScenario();
      const inactive = await seedCandidate(s.tenantId);
      await ctx.su.prisma.tenantMember.updateMany({ where: { tenantId: s.tenantId, userId: inactive.userId }, data: { deactivatedAt: new Date() } });
      let raced = false;
      let written = -1;
      const r = await run(s, {
        apply: true,
        confirm: async () => {
          written = (await ctx.su.prisma.account.updateMany({ where: { id: inactive.accountId }, data: { scope: "unrelated" } })).count;
          raced = true;
          return true;
        },
      });
      expect(raced).toBe(true);
      expect(written).toBe(1);
      expect(r, r.message).toMatchObject({ ok: true, code: 0 });
      expect(await rekeyOutbox(s.tenantId)).toHaveLength(3);
      const rows = await snapshot();
      expect(rows.filter((x) => x.provider === TO)).toHaveLength(3);
      expect(rows.find((x) => x.id === inactive.accountId)).toMatchObject({ provider: LEGACY, scope: "unrelated" });
    });
  });
});
