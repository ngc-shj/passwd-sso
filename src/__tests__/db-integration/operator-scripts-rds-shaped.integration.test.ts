/**
 * The operator scripts as the migration role is on RDS: neither SUPERUSER nor
 * BYPASSRLS (E2), so every table they read or write is subject to row-level
 * security, and the enforcing bypass (#921) refuses a statement that reaches a
 * table outside the grant the script passes. In dev and CI the migration role
 * is a superuser, which would pass whether or not a grant were complete.
 *
 * Every cell points the script's MIGRATION_DATABASE_URL at the owner-shaped
 * probe role (rds-probe-role.ts), unconditionally, and drives the script the way
 * an operator does: the tenant-domain subcommands in-process, the one-shot
 * migrations through a client or a child process built on that URL.
 *
 * Non-vacuity: the last describe asserts RLS applies to the connection, that
 * rows seeded in the tables the scripts scan are invisible outside a bypass, and
 * that an ungranted bypassed read on the same kind of connection is refused. The
 * proof that a cell can fail is a grant that drops a model its script reads.
 *
 * tenant-domain subcommand per BYPASS_GRANT member (the eleven the CLI names):
 *   TENANT_CLAIM_LIST              list
 *   TENANT_CLAIM_BINDING_READ      list --unbound, bind --from-members
 *   TENANT_DOMAIN_UNMAPPED_REPORT  unmapped
 *   TENANT_CLAIM_BINDING_WRITE     add, bind, bind --apply
 *   TENANT_CLAIM_REGISTER          remove
 *   TENANT_CLAIM_HISTORY           history
 *   TENANT_REALIGN_MEMBERSHIP      realign
 *   TENANT_DOMAIN_DIVERGENCE_READ  measure, backfill-owning-column (listing)
 *   TENANT_DOMAIN_BACKFILL_APPLY   backfill-owning-column --apply
 *   TENANT_LEGACY_ACCOUNT_READ     legacy-accounts
 *   TENANT_ACCOUNT_REKEY           rekey-accounts (preview and --apply)
 * bind's attestation path (a claim already bound, whose binding no operator
 * recorded) runs under TENANT_CLAIM_BINDING_WRITE.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { AuditAction, ActorType, AuditOutboxStatus, AuditScope } from "@prisma/client";
import { createPool, createPrismaClient } from "@/lib/db/pool-factory";
import { defineGrant, setBypassGucs } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";
import { JACKSON_LEGACY_PROVIDER_ID } from "@/lib/auth/jackson-providers";
import {
  SIGNIN_ACTOR_LABEL,
  TENANT_CLAIM_EVENT_OPERATION,
  recordTenantClaimEvent,
} from "@/lib/tenant/tenant-claim-event";
import { getCurrentMasterKeyVersion, getMasterKeyByVersion } from "@/lib/crypto/crypto-server";
import {
  decryptAccountTokenTriple,
  encryptAccountTokenTriple,
  isEncryptedAccountToken,
} from "@/lib/crypto/account-token-crypto";
import {
  ALIAS_CLAIM,
  runToken,
  stubClaimProviderEnv,
  type ProviderEnvSpec,
} from "@/__tests__/helpers/tenant-claim-fixtures";
import {
  assertRlsApplies,
  createTestContext,
  expectBypassRefusal,
  redProofOverride,
  setBypassRlsGucs,
  type TestContext,
} from "./helpers";
import { createProbeRole, type ProbeRole } from "./rds-probe-role";
import { USER_OWNED_MODELS, removeSeededUserOwnedRows, seedUserOwnedRows, type SeededUserOwnedRows } from "./user-owned-rows-seed";
import { STRANDED_COUNTERS } from "@/lib/tenant/stranded-rows";
import {
  cmdAdd,
  cmdBackfillOwningColumn,
  cmdBind,
  cmdBindApply,
  cmdBindFromMembers,
  cmdHistory,
  cmdLegacyAccounts,
  cmdList,
  cmdMeasure,
  cmdRealign,
  cmdRekeyAccounts,
  cmdRemove,
  cmdUnmapped,
  migrationClientFactory,
} from "../../../scripts/tenant-domain";
import { migrateWebhookSecrets } from "../../../scripts/migrate-webhook-secrets-v1-to-v2";

const execFileAsync = promisify(execFile);

const ALPHA = "saml-jackson-alpha";
const BRAVO = "saml-jackson-bravo";
const TWO_CONNECTIONS: ProviderEnvSpec = { connections: [ALPHA, BRAVO], mode: "strict" };
const LEGACY = JACKSON_LEGACY_PROVIDER_ID;
const LEGACY_AND_CONNECTION: ProviderEnvSpec = { legacy: true, connections: [ALPHA], mode: "strict" };
const PEPPER = "operator-scripts-rds-shaped-pepper-0123456789abcdef";

describe("operator scripts as an owner-shaped NOSUPERUSER NOBYPASSRLS role", () => {
  let ctx: TestContext;
  let probe: ProbeRole;
  let scratch: string;
  const outputSpies: MockInstance[] = [];
  const tenantIds: string[] = [];
  const seededRows: Array<{ userId: string; rows: SeededUserOwnedRows }> = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    probe = await createProbeRole();
  });

  afterAll(async () => {
    try {
      await ctx.cleanup();
    } finally {
      await probe.drop();
    }
  });

  beforeEach(() => {
    // Unconditionally: a runner that exported MIGRATION_DATABASE_URL must not
    // decide which principal the script connects as.
    vi.stubEnv("MIGRATION_DATABASE_URL", probe.connectionString);
    vi.stubEnv("AUDIT_IDENTIFIER_PEPPER", PEPPER);
    stubClaimProviderEnv({});
    scratch = mkdtempSync(join(tmpdir(), "operator-scripts-rds-"));
  });

  afterEach(async () => {
    for (const spy of outputSpies.splice(0)) spy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
    for (const { userId, rows } of seededRows.splice(0)) await removeSeededUserOwnedRows(ctx.su.prisma, userId, rows);
    for (const tenantId of tenantIds.splice(0)) await ctx.deleteTestData(tenantId);
  });

  function quiet(): { text: () => string } {
    const lines: string[] = [];
    const push = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    for (const method of ["log", "warn", "error"] as const) {
      outputSpies.push(vi.spyOn(console, method).mockImplementation(push));
    }
    return { text: () => lines.join("\n") };
  }

  async function tenant(): Promise<string> {
    const id = await ctx.createTenant();
    tenantIds.push(id);
    return id;
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
        await tx.$executeRawUnsafe(`UPDATE tenant_members SET deactivated_at = now() WHERE user_id = $1::uuid`, userId);
      }
    });
    return userId;
  }

  /** A row in each model a tenant move counts as stranded, so the cell's statements examine every one. */
  async function seedOwned(tenantId: string, userId: string): Promise<void> {
    seededRows.push({ userId, rows: await seedUserOwnedRows(ctx.su.prisma, tenantId, userId) });
  }

  const freshClaim = (arm: string) => `${runToken()}-${arm}.${ALIAS_CLAIM}`;

  async function seedClaim(tenantId: string, claim: string, provider: string | null = null) {
    await ctx.su.prisma.tenantClaim.create({ data: { tenantId, claim, createdBy: "rds-shaped-test", provider } });
  }

  const claimRow = (claim: string) => ctx.su.prisma.tenantClaim.findUnique({ where: { claim } });
  const eventsOf = (claim: string) =>
    ctx.su.prisma.tenantClaimEvent.findMany({ where: { claim }, orderBy: { seq: "asc" } });

  /** A user whose column stays at `homeTenant` while their only active membership moves to `toTenant`. */
  async function seedDivergent() {
    const homeTenant = await tenant();
    const toTenant = await tenant();
    const userId = await ctx.createUser(homeTenant);
    await ctx.su.prisma.$executeRawUnsafe(
      `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      homeTenant,
      userId,
    );
    await ctx.su.prisma.$executeRawUnsafe(
      `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
      randomUUID(),
      toTenant,
      userId,
    );
    return { homeTenant, toTenant, userId };
  }

  const columnOf = async (userId: string) =>
    (await ctx.su.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tenantId: true } })).tenantId;

  // ─── tenant-domain ──────────────────────────────────────────────────────

  it("seeds a row in every model a tenant move counts as stranded", () => {
    expect([...USER_OWNED_MODELS].sort()).toEqual(Object.keys(STRANDED_COUNTERS).sort());
  });

  describe("tenant-domain", () => {
    let createSpy: MockInstance<typeof migrationClientFactory.create>;

    beforeEach(() => {
      createSpy = vi.spyOn(migrationClientFactory, "create");
    });

    afterEach(() => {
      try {
        // The cell ran the script, and every client the script built was the probe's.
        expect(createSpy.mock.calls.length).toBeGreaterThan(0);
        for (const [url] of createSpy.mock.calls) expect(url).toBe(probe.connectionString);
      } finally {
        createSpy.mockRestore();
      }
    });

    it("list (TENANT_CLAIM_LIST) reads the seeded claim", async () => {
      quiet();
      const tenantId = await tenant();
      const claim = freshClaim("list");
      await seedClaim(tenantId, claim);

      const result = await cmdList({ tenant: tenantId });

      expect(result).toMatchObject({ ok: true, code: 0, message: "1 claim(s) listed." });
      expect((result.rows as Array<{ claim: string }>).map((r) => r.claim)).toEqual([claim]);
    });

    it("list --unbound (TENANT_CLAIM_BINDING_READ) reads the claim and the members' accounts behind its suggestion", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const out = quiet();
      const tenantId = await tenant();
      await member(tenantId, [BRAVO]);
      await member(tenantId, [BRAVO]);
      const claim = freshClaim("unbound");
      await seedClaim(tenantId, claim);

      const result = await cmdList({ tenant: tenantId, unbound: true });

      expect(result.ok).toBe(true);
      expect((result.rows as Array<{ claim: string }>).map((r) => r.claim)).toEqual([claim]);
      expect(out.text()).toContain(`suggest=${BRAVO}`);
    });

    it("unmapped (TENANT_DOMAIN_UNMAPPED_REPORT) reads audit_logs, audit_outbox and tenant_claims", async () => {
      quiet();
      const tenantId = await tenant();
      const userId = await ctx.createUser(tenantId);
      const logClaim = freshClaim("unmapped-log");
      const outboxClaim = freshClaim("unmapped-outbox");
      await seedClaim(tenantId, freshClaim("registered"));
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.auditLog.create({
          data: {
            tenantId,
            scope: AuditScope.PERSONAL,
            action: AuditAction.AUTH_LOGIN_FAILURE,
            userId,
            actorType: ActorType.SYSTEM,
            metadata: { reason: "tenant_claim_unmapped", claim: logClaim, provider: "google" },
          },
        });
        await tx.auditOutbox.create({
          data: {
            tenantId,
            status: AuditOutboxStatus.PENDING,
            // Ahead of the worker's claim window, so it stays an outbox-only row.
            nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
            payload: {
              scope: AuditScope.PERSONAL,
              action: AuditAction.AUTH_LOGIN_FAILURE,
              userId,
              actorType: ActorType.SYSTEM,
              serviceAccountId: null,
              teamId: null,
              targetType: null,
              targetId: null,
              metadata: { reason: "tenant_claim_unmapped", claim: outboxClaim, provider: "google" },
              ip: null,
              userAgent: null,
            },
          },
        });
      });

      const result = await cmdUnmapped({ days: 1 });

      expect(result.ok).toBe(true);
      const mine = (result.rows as Array<{ tenant_id: string; claim: string | null }>).filter((r) => r.tenant_id === tenantId);
      expect(mine.map((r) => r.claim).sort()).toEqual([logClaim, outboxClaim].sort());
    });

    it("add (TENANT_CLAIM_BINDING_WRITE) registers a claim and its event records the probe as the database user", async () => {
      quiet();
      const tenantId = await tenant();
      const claim = freshClaim("add");

      const result = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", unbound: true, yes: true });

      expect(result).toMatchObject({ ok: true, code: 0, tenantId });
      expect(await claimRow(claim)).toMatchObject({ tenantId, revokedAt: null });
      const events = await eventsOf(claim);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER, newTenantId: tenantId, dbUser: probe.name });
    });

    it("bind (TENANT_CLAIM_BINDING_WRITE) binds an unbound claim, reading the members' accounts as evidence", async () => {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      quiet();
      const tenantId = await tenant();
      await member(tenantId, [ALPHA]);
      const claim = freshClaim("bind");
      await seedClaim(tenantId, claim);

      const result = await cmdBind({ claim, provider: ALPHA, by: "ops", yes: true });

      expect(result).toMatchObject({ ok: true, code: 0, tenantId, claim });
      expect((await claimRow(claim))?.provider).toBe(ALPHA);
      const events = await eventsOf(claim);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ operation: TENANT_CLAIM_EVENT_OPERATION.REBIND, newProvider: ALPHA, dbUser: probe.name });
    });

    it("bind --from-members (TENANT_CLAIM_BINDING_READ) then --apply (TENANT_CLAIM_BINDING_WRITE) bind the reviewed line", async () => {
      quiet();
      const tenantId = await tenant();
      await member(tenantId, [ALPHA]);
      const claim = freshClaim("from-members");
      // Registered through the CLI so the claim has the event the review file's provenance reads.
      expect((await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", unbound: true, yes: true })).ok).toBe(true);
      stubClaimProviderEnv(TWO_CONNECTIONS);

      const full = join(scratch, "full.tsv");
      const written = await cmdBindFromMembers({ out: full });
      expect(written.ok, written.message).toBe(true);
      // What a reviewing operator keeps: the header and this claim's line only,
      // since the file lists every unbound claim of the shared database.
      const lines = readFileSync(full, "utf8").split("\n");
      const kept = lines.filter((line, i) => i === 0 || line.startsWith(`${claim}\t`));
      expect(kept).toHaveLength(2);
      expect(kept[1].split("\t")[2]).toBe(ALPHA);
      const reviewed = join(scratch, "reviewed.tsv");
      writeFileSync(reviewed, `${kept.join("\n")}\n`);

      const applied = await cmdBindApply({ file: reviewed, by: "ops", yes: true });

      expect(applied.ok, applied.message).toBe(true);
      expect((await claimRow(claim))?.provider).toBe(ALPHA);
      expect((await eventsOf(claim)).at(-1)).toMatchObject({ operation: TENANT_CLAIM_EVENT_OPERATION.REBIND, dbUser: probe.name });
    });

    it("remove (TENANT_CLAIM_REGISTER) revokes the claim and records the probe as the database user", async () => {
      quiet();
      const tenantId = await tenant();
      const claim = freshClaim("remove");
      await seedClaim(tenantId, claim);
      await member(tenantId, [ALPHA]);

      const result = await cmdRemove({ tenant: tenantId, domain: claim, by: "ops", yes: true });

      expect(result).toMatchObject({ ok: true, code: 0, tenantId, claim });
      expect((await claimRow(claim))?.revokedAt).not.toBeNull();
      const events = await eventsOf(claim);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ operation: TENANT_CLAIM_EVENT_OPERATION.REVOKE, dbUser: probe.name });
    });

    it("history (TENANT_CLAIM_HISTORY) reads the events a probe-run add wrote", async () => {
      quiet();
      const tenantId = await tenant();
      const claim = freshClaim("history");
      expect((await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", unbound: true, yes: true })).ok).toBe(true);

      const result = await cmdHistory({ domain: claim });

      expect(result.ok).toBe(true);
      expect(result.rows).toEqual([
        expect.objectContaining({ operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER, newTenantId: tenantId, actorLabel: "ops" }),
      ]);
      // By a claim reference, which resolves through tenant_claims and tenants.
      const byRef = await cmdHistory({ tenant: claim });
      expect(byRef.ok, byRef.message).toBe(true);
      expect(byRef.rows).toHaveLength(1);
    });

    it("realign (TENANT_REALIGN_MEMBERSHIP) moves a user active nowhere, examining a seeded row of every stranded model", async () => {
      const out = quiet();
      const owning = await tenant();
      const former = await tenant();
      const userId = await ctx.createUser(owning);
      await seedOwned(owning, userId);
      const claim = freshClaim("realign");
      await seedClaim(former, claim);
      await ctx.su.prisma.$executeRawUnsafe(
        `UPDATE tenant_members SET deactivated_at = now() WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
        owning,
        userId,
      );
      await ctx.su.prisma.$executeRawUnsafe(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now(), now())`,
        randomUUID(),
        former,
        userId,
      );

      // The target named by a claim, which resolves through tenant_claims and tenants.
      const result = await cmdRealign({ user: userId, tenant: claim, by: "ops", yes: true });

      expect(result, result.message).toMatchObject({ ok: true, code: 0, tenantId: former });
      expect(await columnOf(userId)).toBe(former);
      // The count the operator reads names every seeded model: each was examined.
      const stranded = JSON.parse(/Rows that stay under it: (\{.*\})/.exec(out.text())?.[1] ?? "null") as Record<string, number>;
      expect(Object.keys(stranded).sort()).toEqual([...USER_OWNED_MODELS].sort());
      const rows = await ctx.su.prisma.auditOutbox.findMany({
        where: { tenantId: { in: [owning, former] }, payload: { path: ["action"], equals: "USER_TENANT_REALIGNED" } },
        select: { tenantId: true },
      });
      expect(rows.map((r) => r.tenantId).sort()).toEqual([owning, former].sort());
    });

    it("measure (TENANT_DOMAIN_DIVERGENCE_READ) counts a seeded divergent user", async () => {
      quiet();
      const baseline = (await cmdMeasure()).rows?.[0] as { divergent: number };

      await seedDivergent();
      const result = await cmdMeasure();

      expect(result.ok, result.message).toBe(true);
      expect((result.rows?.[0] as { divergent: number }).divergent).toBe(baseline.divergent + 1);
    });

    it("backfill-owning-column lists a divergent user (TENANT_DOMAIN_DIVERGENCE_READ), and --apply moves them (TENANT_DOMAIN_BACKFILL_APPLY)", async () => {
      quiet();
      const { homeTenant, toTenant, userId } = await seedDivergent();
      await seedOwned(homeTenant, userId);

      const listed = await cmdBackfillOwningColumn({ by: "ops" });
      expect(listed.ok, listed.message).toBe(true);
      expect((listed.rows as Array<{ userId: string; from: string; to: string }>).find((c) => c.userId === userId)).toMatchObject({
        from: homeTenant,
        to: toTenant,
      });
      expect(await columnOf(userId)).toBe(homeTenant);

      const applied = await cmdBackfillOwningColumn({ by: "ops", apply: true, yes: true });

      expect(applied.ok, applied.message).toBe(true);
      expect((applied.rows as Array<{ userId: string; moved: boolean }>).find((o) => o.userId === userId)).toMatchObject({ moved: true });
      expect(await columnOf(userId)).toBe(toTenant);
    });

    it("legacy-accounts (TENANT_LEGACY_ACCOUNT_READ) reads accounts, members and tenants, and passes on the attestation", async () => {
      stubClaimProviderEnv(LEGACY_AND_CONNECTION);
      quiet();
      const tenantId = await tenant();
      await member(tenantId, [LEGACY]);

      const result = await cmdLegacyAccounts({ singleConnection: true });

      expect(result).toMatchObject({ ok: true, code: 0 });
      expect(result.rows).toEqual(expect.arrayContaining([expect.objectContaining({ tenantId, users: 1, accounts: 1 })]));
    });

    /**
     * A tenant with a member holding a legacy account with real encrypted
     * tokens. The claim is bound to ALPHA by the operator path under the probe
     * (`add`), or by a sign-in's event written through `ctx.su`.
     */
    async function seedRekeyTenant(binding: "operator" | "signin") {
      stubClaimProviderEnv(TWO_CONNECTIONS);
      const tenantId = await tenant();
      const claim = freshClaim("rekey");
      if (binding === "operator") {
        const added = await cmdAdd({ tenant: tenantId, domain: claim, by: "ops", provider: ALPHA, yes: true });
        expect(added, added.message).toMatchObject({ ok: true });
      } else {
        await seedClaim(tenantId, claim, ALPHA);
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          await recordTenantClaimEvent(tx, {
            claim,
            operation: TENANT_CLAIM_EVENT_OPERATION.REGISTER,
            oldTenantId: null,
            newTenantId: tenantId,
            oldRevokedAt: null,
            newRevokedAt: null,
            actorLabel: SIGNIN_ACTOR_LABEL,
            oldProvider: null,
            newProvider: ALPHA,
          });
        });
      }
      const userId = await member(tenantId, []);
      const pid = `subject-${randomUUID()}`;
      const plain = { refresh_token: `refresh-${pid}`, access_token: `access-${pid}`, id_token: `id-${pid}` };
      const account = await ctx.su.prisma.account.create({
        data: {
          userId,
          tenantId,
          type: "oidc",
          provider: LEGACY,
          providerAccountId: pid,
          ...encryptAccountTokenTriple(plain, { userId, provider: LEGACY, providerAccountId: pid }),
        },
      });
      return { tenantId, claim, userId, pid, plain, accountId: account.id };
    }

    const outboxActions = async (tenantId: string) =>
      (
        await ctx.su.prisma.$transaction(async (tx) => {
          await setBypassRlsGucs(tx);
          return tx.auditOutbox.findMany({ where: { tenantId } });
        })
      ).map((r) => (r.payload as { action?: string }).action);

    it("rekey-accounts preview (TENANT_ACCOUNT_REKEY) reads accounts, claims, events and members and decrypts the seeded tokens", async () => {
      const out = quiet();
      const t = await seedRekeyTenant("operator");

      const result = await cmdRekeyAccounts({ tenant: t.tenantId, to: ALPHA, by: "ops" });

      expect(result, result.message).toMatchObject({ ok: true, code: 0, tenantId: t.tenantId });
      expect((result.rows as Array<{ accountId: string }>).map((r) => r.accountId)).toEqual([t.accountId]);
      expect(out.text()).toContain(`claim=${t.claim}\tprovider=${ALPHA}`);
      const row = await ctx.su.prisma.account.findUniqueOrThrow({ where: { id: t.accountId } });
      expect(row.provider).toBe(LEGACY);
      expect(await outboxActions(t.tenantId)).not.toContain("ACCOUNT_PROVIDER_REKEYED");
    });

    it("rekey-accounts --apply (TENANT_ACCOUNT_REKEY) moves the account and enqueues its audit row through enqueueAuditInTx", async () => {
      quiet();
      const t = await seedRekeyTenant("operator");

      const result = await cmdRekeyAccounts({ tenant: t.tenantId, to: ALPHA, by: "ops", apply: true, yes: true });

      expect(result, result.message).toMatchObject({ ok: true, code: 0, tenantId: t.tenantId });
      const row = await ctx.su.prisma.account.findUniqueOrThrow({ where: { id: t.accountId } });
      expect(row.provider).toBe(ALPHA);
      expect(decryptAccountTokenTriple(row, { userId: t.userId, provider: ALPHA, providerAccountId: t.pid })).toEqual(t.plain);
      expect(await outboxActions(t.tenantId)).toEqual(["ACCOUNT_PROVIDER_REKEYED"]);
    });

    it("bind attestation (TENANT_CLAIM_BINDING_WRITE) records an operator rebind of a sign-in's binding, and rekey-accounts then passes R-c", async () => {
      const out = quiet();
      const t = await seedRekeyTenant("signin");
      const refused = await cmdRekeyAccounts({ tenant: t.tenantId, to: ALPHA, by: "ops" });
      expect(refused).toMatchObject({ ok: false, code: 1 });
      expect(out.text()).toContain("not bound by an operator");

      const attested = await cmdBind({ claim: t.claim, provider: ALPHA, by: "ops", acceptUnusedProvider: true, yes: true });

      expect(attested, attested.message).toMatchObject({ ok: true, code: 0, tenantId: t.tenantId, claim: t.claim });
      expect((await claimRow(t.claim))?.provider).toBe(ALPHA);
      const events = await eventsOf(t.claim);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        operation: TENANT_CLAIM_EVENT_OPERATION.REBIND,
        oldProvider: ALPHA,
        newProvider: ALPHA,
        actorLabel: "ops",
        dbUser: probe.name,
      });
      const preview = await cmdRekeyAccounts({ tenant: t.tenantId, to: ALPHA, by: "ops" });
      expect(preview, preview.message).toMatchObject({ ok: true, code: 0 });
    });
  });

  // ─── one-shot migrations ────────────────────────────────────────────────

  describe("one-shot migrations", () => {
    /** A v1 (no-AAD) webhook secret that decrypts under the current master key. */
    function v1Secret() {
      const version = getCurrentMasterKeyVersion();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", getMasterKeyByVersion(version), iv, { authTagLength: 16 });
      const ciphertext = Buffer.concat([cipher.update("v1-secret", "utf8"), cipher.final()]);
      return { version, ciphertext: ciphertext.toString("hex"), iv: iv.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
    }

    it("migrate-webhook-secrets-v1-to-v2 rewrites a team and a tenant webhook through a client on the probe URL", async () => {
      quiet();
      const tenantId = await tenant();
      const teamId = randomUUID();
      const teamWebhookId = randomUUID();
      const tenantWebhookId = randomUUID();
      const secret = v1Secret();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO teams (id, tenant_id, name, slug, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, 'rds-shaped-team', $3, now(), now())`,
          teamId,
          tenantId,
          `rds-shaped-${teamId.slice(0, 8)}`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO team_webhooks (id, tenant_id, team_id, url, events, is_active, secret_encrypted, secret_iv, secret_auth_tag,
             master_key_version, secret_aad_version, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'https://example.com/team', ARRAY[]::text[], true, $4, $5, $6, $7, 1, now(), now())`,
          teamWebhookId, tenantId, teamId, secret.ciphertext, secret.iv, secret.authTag, secret.version,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO tenant_webhooks (id, tenant_id, url, events, is_active, secret_encrypted, secret_iv, secret_auth_tag,
             master_key_version, secret_aad_version, created_at, updated_at)
           VALUES ($1::uuid, $2::uuid, 'https://example.com/tenant', ARRAY[]::text[], true, $3, $4, $5, $6, 1, now(), now())`,
          tenantWebhookId, tenantId, secret.ciphertext, secret.iv, secret.authTag, secret.version,
        );
      });

      const pool = createPool({ connectionString: probe.connectionString, max: 2 });
      const prisma = createPrismaClient(pool, {}, { ownsPool: true });
      try {
        await assertRlsApplies(prisma);
        const stats = await migrateWebhookSecrets(prisma, { dryRun: false });
        // The sweep covers the whole table; assert on these rows, and that it saw at least them.
        expect(stats.teamRowsMigrated).toBeGreaterThanOrEqual(1);
        expect(stats.tenantRowsMigrated).toBeGreaterThanOrEqual(1);
      } finally {
        await prisma.$disconnect();
      }

      const versions = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        const team = await tx.$queryRawUnsafe<Array<{ v: number }>>(`SELECT secret_aad_version AS v FROM team_webhooks WHERE id = $1::uuid`, teamWebhookId);
        const tenantRow = await tx.$queryRawUnsafe<Array<{ v: number }>>(`SELECT secret_aad_version AS v FROM tenant_webhooks WHERE id = $1::uuid`, tenantWebhookId);
        return { team: team[0]?.v, tenant: tenantRow[0]?.v };
      });
      expect(versions).toEqual({ team: 2, tenant: 2 });
    });

    it("migrate-account-tokens-to-encrypted encrypts a plaintext account token, run as the operator runs it with the probe URL", async () => {
      const tenantId = await tenant();
      const userId = await ctx.createUser(tenantId);
      const accountId = randomUUID();
      await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        await tx.$executeRawUnsafe(
          `INSERT INTO accounts (id, user_id, tenant_id, type, provider, provider_account_id, refresh_token, access_token)
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'oidc', 'google', $4, 'plaintext-refresh', 'plaintext-access')`,
          accountId, userId, tenantId, `subject-${randomUUID()}`,
        );
      });

      // A child process: the script's main() is not exported, and the cell runs it as an operator does.
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", redProofOverride("MIGRATE_ACCOUNT_TOKENS_SCRIPT") ?? "scripts/migrate-account-tokens-to-encrypted.ts"],
        { cwd: process.cwd(), env: { ...process.env, MIGRATION_DATABASE_URL: probe.connectionString }, timeout: 120_000 },
      );

      expect(stdout).toMatch(/rewritten\s+: [1-9]\d*/);
      expect(stdout).toMatch(/failed\s+: 0\b/);
      // The stderr sink writes `"_logType":"rls.bypass_…"`, with a dot: matching the
      // SQL function's underscore spelling could never fail.
      expect(stderr).not.toMatch(/"_logType":"rls\.bypass_(not_granted|refused|notice_unparsed)"/);
      const [row] = await ctx.su.prisma.$transaction(async (tx) => {
        await setBypassRlsGucs(tx);
        return tx.$queryRawUnsafe<Array<{ refresh_token: string; access_token: string }>>(
          `SELECT refresh_token, access_token FROM accounts WHERE id = $1::uuid`,
          accountId,
        );
      });
      expect(isEncryptedAccountToken(row.refresh_token)).toBe(true);
      expect(isEncryptedAccountToken(row.access_token)).toBe(true);
    });
  });

  // ─── the connection the cells above ran on ──────────────────────────────

  describe("non-vacuity", () => {
    it("RLS applies to the probe connection, hides rows seeded in the tables the scripts scan, and refuses an ungranted bypassed read", async () => {
      const tenantId = await tenant();
      const claim = freshClaim("non-vacuity");
      await seedClaim(tenantId, claim);
      const pool = createPool({ connectionString: probe.connectionString, max: 1 });
      const prisma = createPrismaClient(pool, {}, { ownsPool: true });
      try {
        await assertRlsApplies(prisma);

        // The row exists (the superuser reads it) and RLS hides it from the probe outside a bypass.
        expect(await claimRow(claim)).not.toBeNull();
        const outside = await prisma.$queryRawUnsafe<unknown[]>(`SELECT id FROM tenant_claims WHERE claim = $1`, claim);
        expect(outside).toEqual([]);

        // A grant naming it reads it; one that omits it is refused.
        const granted = await prisma.$transaction(async (tx) => {
          await setBypassGucs(tx, defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenantClaim"]));
          return tx.$queryRawUnsafe<unknown[]>(`SELECT id FROM tenant_claims WHERE claim = $1`, claim);
        });
        expect(granted).toHaveLength(1);
        const { table } = await expectBypassRefusal(() =>
          prisma.$transaction(async (tx) => {
            await setBypassGucs(tx, defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenant", "user"]));
            return tx.$queryRawUnsafe(`SELECT id FROM tenant_claims WHERE claim = $1`, claim);
          }),
        );
        expect(table).toBe("tenant_claims");
      } finally {
        await prisma.$disconnect();
      }
    });
  });
});
