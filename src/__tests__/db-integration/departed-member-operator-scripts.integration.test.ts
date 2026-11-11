/**
 * Integration test (real DB): the operator scripts of
 * docs/operations/departed-member-access-backfill.md, run as extracted from the
 * runbook, so the documented text is the tested text (#1033, plan C6).
 *
 * Each script runs as passwd_app (no BYPASSRLS) on its own connection from the
 * pool factory, so a table missing from a script's bypass list is reported by
 * the notice sink and fails the cell. Fixtures are committed through the
 * superuser helper in each cell's own tenants and removed by deleteTestData.
 *
 * Run: docker compose stop audit-outbox-worker retention-gc-worker &&
 *      npx vitest run --config vitest.integration.config.ts departed-member-operator-scripts
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import type pg from "pg";
import {
  appConnectionString,
  assertRlsApplies,
  collectNotices,
  createTestContext,
  expectBypassNotices,
  readBackfillBlock,
  RLS_BACKFILL_RERUN_DIR,
  setBypassRlsGucs,
  setTestBypass,
  type TestContext,
} from "./helpers";

const mockAuth = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => mockAuth(...args) }));

import { GET as listOwnerless } from "@/app/api/tenant/teams/ownerless/route";
import { departFromTenant, returnToTenant, TENANT_MEMBERSHIP_SOURCE } from "@/lib/team/team-departure";
import { advisoryKey } from "@/lib/team/tenant-row-lock";
import { createPool } from "@/lib/db/pool-factory";
import { buildOutboxPayload } from "@/lib/audit/audit-payload";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";

const hex = (n: number) => randomBytes(n).toString("hex");
const SECOND = 1000;
const DEACTIVATE = "TEAM_MEMBER_TENANT_DEACTIVATE";
const RESTORE = "TEAM_MEMBER_TENANT_RESTORE";
const TEMPLATE_LABEL = "REPLACE-WITH-OPERATOR-LABEL";

// ── Runbook extraction ──────────────────────────────────────────

/**
 * RUNBOOK_MD names a file to read instead of the runbook (a mutated copy, for a
 * red proof outside the source tree).
 */
function runbookText(): string {
  return readFileSync(process.env.RUNBOOK_MD ?? join(process.cwd(), "docs/operations/departed-member-access-backfill.md"), "utf8");
}

/** The text between `-- BEGIN <kind> <name>` and `-- END <kind> <name>`; throws unless exactly one pair exists. */
function extract(kind: "SCRIPT" | "BODY", name: string): string {
  const text = runbookText();
  const begin = `-- BEGIN ${kind} ${name}\n`;
  const end = `-- END ${kind} ${name}\n`;
  const count = (marker: string) => text.split(marker).length - 1;
  if (count(begin) !== 1 || count(end) !== 1) {
    throw new Error(`expected exactly one ${kind} ${name} marker pair, found ${count(begin)} BEGIN and ${count(end)} END`);
  }
  const from = text.indexOf(begin) + begin.length;
  const to = text.indexOf(end);
  if (to < from) throw new Error(`${kind} ${name}: END before BEGIN`);
  return text.slice(from, to);
}

const reportScript = () => extract("SCRIPT", "departed-member-report");
const reportBody = () => extract("BODY", "report");
const containScript = () => extract("SCRIPT", "departed-member-contain");

/** Replaces the single line ending in `marker`; throws unless exactly one matches. */
function replaceLine(script: string, marker: string, line: string): string {
  const pattern = new RegExp(`^.*${marker}$`, "gm");
  const found = script.match(pattern) ?? [];
  if (found.length !== 1) throw new Error(`expected exactly one line ending in ${marker}, found ${found.length}`);
  return script.replace(pattern, () => line);
}

/** The runbook's contain script with its two INPUT lines filled in. */
function containWith(input: { triples: string; label: string }): string {
  let script = containScript();
  script = replaceLine(script, "-- INPUT:triples", `  v_input uuid[] := '${input.triples}'::uuid[]; -- INPUT:triples`);
  script = replaceLine(script, "-- INPUT:label", `  v_label text := $label$${input.label}$label$; -- INPUT:label`);
  return script;
}

/** A uuid[] literal of (tenant, team, user) rows. */
const triplesLiteral = (rows: readonly (readonly string[])[]) => `{${rows.map((r) => `{${r.join(",")}}`).join(",")}}`;

/** The tables a script's own `app.bypass_tables` literal names. */
function bypassTables(script: string): string[] {
  const found = [...script.matchAll(/set_config\('app\.bypass_tables', '([a-z_,]+)'/g)];
  if (found.length !== 1) throw new Error(`expected one app.bypass_tables literal, found ${found.length}`);
  return found[0][1].split(",");
}

describe("departed-member operator scripts — real-DB integration", () => {
  let ctx: TestContext;
  let appPool: pg.Pool;
  let tenants: string[];

  beforeAll(async () => {
    ctx = await createTestContext();
    appPool = createPool({ connectionString: appConnectionString(), max: 6 });
    await assertRlsApplies(prisma);
  });

  afterAll(async () => {
    await appPool.end();
    await ctx.cleanup();
  });

  beforeEach(() => {
    tenants = [];
    vi.clearAllMocks();
  });

  afterEach(async () => {
    for (const tenantId of tenants) await ctx.deleteTestData(tenantId);
  });

  // ── Fixture helpers (superuser) ─────────────────────────────

  async function sql<T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> {
    return ctx.su.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await setBypassRlsGucs(tx);
      return tx.$queryRawUnsafe<T[]>(text, ...params);
    });
  }

  async function newTenant(): Promise<string> {
    const id = await ctx.createTenant();
    tenants.push(id);
    return id;
  }

  /** A departure stamp at least two hours in the past, to the second. */
  const newStamp = () => new Date(Math.floor(Date.now() / SECOND) * SECOND - 2 * 3_600_000);
  const iso = (stamp: Date, ms = 0) => new Date(stamp.getTime() + ms).toISOString();

  /** An active tenant MEMBER (createUser makes OWNERs). */
  async function mkMember(tenant: string): Promise<string> {
    const id = await ctx.createUser(tenant);
    await sql(`UPDATE tenant_members SET role = 'MEMBER' WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenant, id);
    return id;
  }

  async function mkTeam(tenant: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $3, 1, now(), now())`,
      id, tenant, `team-${id.slice(0, 8)}`,
    );
    return id;
  }

  async function addMembership(
    team: string, user: string, tenant: string, o: { role?: string; createdAt?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"TeamRole", true, COALESCE($6::timestamptz, now()), now())`,
      id, team, user, tenant, o.role ?? "MEMBER", o.createdAt ?? null,
    );
    return id;
  }

  /** The user's row in `tenant`, departed at `stamp` (created if the user has none there). */
  async function departIn(tenant: string, user: string, stamp: Date): Promise<void> {
    const rows = await sql(`SELECT 1 FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenant, user);
    if (rows.length === 0) {
      await sql(
        `INSERT INTO tenant_members (id, tenant_id, user_id, role, deactivated_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', $4::timestamptz, now(), now())`,
        randomUUID(), tenant, user, stamp.toISOString(),
      );
      return;
    }
    await sql(
      `UPDATE tenant_members SET deactivated_at = $3::timestamptz WHERE tenant_id = $1::uuid AND user_id = $2::uuid`,
      tenant, user, stamp.toISOString(),
    );
  }

  const endMembership = (rowId: string, stamp: Date) =>
    sql(`UPDATE team_members SET deactivated_at = $2::timestamptz, deactivated_by_tenant = true WHERE id = $1::uuid`, rowId, stamp.toISOString());

  type RecordArgs = { tenant: string; team: string; target: string; action?: string; backfill?: string | null; status?: string };

  const recordMetadata = (backfill: string | null | undefined) =>
    backfill ? { source: "TENANT_DEACTIVATION", backfill } : { source: "TENANT_DEACTIVATION" };

  const logsRecord = (r: RecordArgs) =>
    sql(
      `INSERT INTO audit_logs (id, tenant_id, scope, action, user_id, actor_type, team_id, target_type, target_id, metadata, created_at)
       VALUES ($1::uuid, $2::uuid, 'TEAM', $3::"AuditAction", $4::uuid, 'SYSTEM', $5::uuid, 'TeamMember', $6, $7::jsonb, now())`,
      randomUUID(), r.tenant, r.action ?? DEACTIVATE, SYSTEM_ACTOR_ID, r.team, r.target, JSON.stringify(recordMetadata(r.backfill)),
    );

  const outboxRecord = (r: RecordArgs) =>
    sql(
      `INSERT INTO audit_outbox (id, tenant_id, payload, status, created_at, sent_at)
       VALUES ($1::uuid, $2::uuid, $3::jsonb, $4::"AuditOutboxStatus", now(), CASE WHEN $4 = 'SENT' THEN now() END)`,
      randomUUID(), r.tenant,
      JSON.stringify({
        scope: "TEAM", action: r.action ?? DEACTIVATE, userId: SYSTEM_ACTOR_ID, actorType: "SYSTEM", serviceAccountId: null,
        teamId: r.team, targetType: "TeamMember", targetId: r.target, metadata: recordMetadata(r.backfill), ip: null, userAgent: null,
      }),
      r.status ?? "PENDING",
    );

  async function webhook(tenant: string, team: string, createdAt: string, updatedAt: string): Promise<string> {
    const id = randomUUID();
    await sql(
      `INSERT INTO team_webhooks (id, team_id, tenant_id, url, secret_encrypted, secret_iv, secret_auth_tag, events, is_active, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'https://example.invalid/hook', $4, $5, $6, ARRAY[]::text[], true, $7::timestamptz, $8::timestamptz)`,
      id, team, tenant, hex(16), hex(12), hex(16), createdAt, updatedAt,
    );
    return id;
  }

  // ── Script runners (passwd_app) ─────────────────────────────

  type Results = pg.QueryResult[];

  /**
   * Runs `text` as one simple-protocol query on its own connection; rolls back after a raise.
   * `setup` may return a teardown, run before the connection goes back to the pool.
   */
  async function runScript(text: string, setup?: (client: pg.PoolClient) => Promise<(() => void) | void>): Promise<Results> {
    const client = await appPool.connect();
    let teardown: (() => void) | void = undefined;
    try {
      const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      teardown = await setup?.(client);
      const res = await client.query(text);
      return (Array.isArray(res) ? res : [res]) as Results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      teardown?.();
      client.release();
    }
  }

  type Section1Row = { tenant_id: string; team_id: string; user_id: string; role: string; has_deactivation_record: boolean };
  type Section2Row = { id: string; tenant_id: string; team_id: string; is_active: boolean; created_at: Date; updated_at: Date };

  /** The two report sections of a result set (the set_config selects are not sections). */
  function sectionsOf(results: Results): { section1: Section1Row[]; section2: Section2Row[]; fields2: string[] } {
    const selects = results.filter((r) => r.command === "SELECT" && r.fields[0]?.name !== "set_config");
    expect(selects).toHaveLength(2);
    return {
      section1: selects[0].rows as Section1Row[],
      section2: selects[1].rows as Section2Row[],
      fields2: selects[1].fields.map((f) => f.name),
    };
  }

  const runReport = async (text = reportScript()) => sectionsOf(await runScript(text));
  const inTenants = <R extends { tenant_id: string }>(rows: R[], scope: readonly string[]) => rows.filter((r) => scope.includes(r.tenant_id));

  async function readTeamMembers(rowIds: readonly string[]) {
    return sql<{ id: string; deactivated_at: Date | null; deactivated_by_tenant: boolean }>(
      `SELECT id, deactivated_at, deactivated_by_tenant FROM team_members WHERE id = ANY($1::uuid[]) ORDER BY id`, [...rowIds],
    );
  }

  // ── Report ──────────────────────────────────────────────────

  describe("report", () => {
    type World = {
      tenant: string;
      stamp: Date;
      teamA: string;
      teamB: string;
      /** name -> user id */
      users: Record<string, string>;
      /** name -> team_members row id */
      rowIds: Record<string, string>;
      /** name -> expected section 1 row; names with no entry must be absent */
      expected: Record<string, { team: string; role: string; record: boolean }>;
    };

    /** Candidates around C1's exclusion, and the adjacent non-candidates. */
    async function seedWorld(): Promise<World> {
      const tenant = await newTenant();
      const otherTenant = await newTenant();
      const stamp = newStamp();
      const teamA = await mkTeam(tenant);
      const teamB = await mkTeam(tenant);
      const users: World["users"] = {};
      const rowIds: World["rowIds"] = {};
      const expected: World["expected"] = {};

      async function candidate(name: string, o: { team?: string; role?: string; offset?: number; record?: boolean } = {}) {
        const user = await mkMember(tenant);
        await departIn(tenant, user, stamp);
        const team = o.team ?? teamA;
        rowIds[name] = await addMembership(team, user, tenant, { role: o.role, createdAt: iso(stamp, o.offset ?? -SECOND) });
        users[name] = user;
        if (o.offset === undefined || o.offset < 0) expected[name] = { team, role: o.role ?? "MEMBER", record: o.record ?? false };
        return user;
      }

      await candidate("leak");
      await candidate("leakAdmin", { team: teamB, role: "ADMIN" });
      await candidate("recLogs", { record: true }).then((u) => logsRecord({ tenant, team: teamB, target: u }));
      await candidate("recOutbox", { record: true }).then((u) => outboxRecord({ tenant, team: teamB, target: u }));
      await candidate("recSent", { record: true }).then((u) => outboxRecord({ tenant, team: teamA, target: u, status: "SENT" }));
      // Records that do not explain it, in each store: another action, another target, another tenant.
      const unrelatedTarget = randomUUID();
      await candidate("negActionLogs").then((u) => logsRecord({ tenant, team: teamA, target: u, action: RESTORE }));
      await candidate("negTargetLogs").then(() => logsRecord({ tenant, team: teamA, target: unrelatedTarget }));
      await candidate("negTenantLogs").then((u) => logsRecord({ tenant: otherTenant, team: teamA, target: u }));
      await candidate("negActionOutbox").then((u) => outboxRecord({ tenant, team: teamA, target: u, action: RESTORE }));
      await candidate("negTargetOutbox").then(() => outboxRecord({ tenant, team: teamA, target: unrelatedTarget }));
      await candidate("negTenantOutbox").then((u) => outboxRecord({ tenant: otherTenant, team: teamA, target: u }));
      // Not candidates: created after the departure; user active; membership already ended.
      await candidate("late", { offset: SECOND });
      const activeUser = await mkMember(tenant);
      await addMembership(teamA, activeUser, tenant, { createdAt: iso(stamp, -SECOND) });
      const endedUser = await mkMember(tenant);
      await departIn(tenant, endedUser, stamp);
      await endMembership(await addMembership(teamA, endedUser, tenant, { createdAt: iso(stamp, -SECOND) }), stamp);
      return { tenant, stamp, teamA, teamB, users, rowIds, expected };
    }

    const expectedSection1 = (w: World, only?: (n: string) => boolean) =>
      Object.fromEntries(Object.entries(w.expected).filter(([n]) => !only || only(n)).map(([n, e]) => [w.users[n], { team_id: e.team, role: e.role, has_deactivation_record: e.record }]));

    const section1Map = (w: World, rows: Section1Row[]) =>
      Object.fromEntries(inTenants(rows, [w.tenant]).map((r) => [r.user_id, { team_id: r.team_id, role: r.role, has_deactivation_record: r.has_deactivation_record }]));

    it("section 1 lists exactly the raw candidates with the record flag, and nothing adjacent (literal map)", async () => {
      const w = await seedWorld();
      const { section1 } = await runReport();
      expect(section1Map(w, section1)).toEqual(expectedSection1(w));
      expect(Object.keys(section1Map(w, section1))).toHaveLength(11);
    });

    it("after C1, in the block's transaction, the report body lists exactly C1's excluded set; C1 ended the rest", async () => {
      const w = await seedWorld();
      const c1 = readBackfillBlock(RLS_BACKFILL_RERUN_DIR, "team-tenant-departure-rerun");
      const tables = bypassTables(reportScript());
      const client = await appPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(c1);
        // The test bypass is the last step before the body, and only the report's own list.
        await setTestBypass(client, tables);
        const ended = await client.query<{ id: string; deactivated_at: Date | null }>(
          `SELECT id, deactivated_at FROM team_members WHERE id = ANY($1::uuid[])`, [Object.values(w.rowIds)],
        );
        const endedByRow = new Map(ended.rows.map((r) => [r.id, r.deactivated_at !== null]));
        const res = await client.query(reportBody());
        const body = sectionsOf((Array.isArray(res) ? res : [res]) as Results);

        const excluded = (n: string) => w.expected[n]?.record === true;
        expect(section1Map(w, body.section1)).toEqual(expectedSection1(w, excluded));
        // C1 ended exactly the candidates the record flag does not exclude.
        for (const name of Object.keys(w.expected)) {
          expect(endedByRow.get(w.rowIds[name]), name).toBe(!excluded(name));
        }
        expect(endedByRow.get(w.rowIds.late)).toBe(false);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    it("raises the control's fixed message when the bypass grant is removed, and passes with it (positive control)", async () => {
      await seedWorld();
      const grant = "SELECT set_config('app.bypass_rls', 'on', true);\n";
      const script = reportScript();
      expect(script.split(grant)).toHaveLength(2);
      expect(script).toContain("00000000-0000-0000-0000-000000000000");
      await expect(runReport(script.replace(grant, ""))).rejects.toThrow(
        "report: no tenant_members rows are visible; the bypass grant did not take effect",
      );
      await expect(runReport(script)).resolves.toBeDefined();
    });

    it("extraction fails unless exactly one marker pair is found", () => {
      expect(reportScript()).toContain("BEGIN READ ONLY");
      expect(containScript()).toContain("$contain$");
      expect(reportBody()).toContain("Section 1");
      expect(() => extract("SCRIPT", "no-such-script")).toThrow(/exactly one SCRIPT no-such-script marker pair, found 0 BEGIN and 0 END/);
    });

    describe("section 2 (webhooks)", () => {
      const C1_DIR = RLS_BACKFILL_RERUN_DIR;
      const SIX = ["id", "tenant_id", "team_id", "is_active", "created_at", "updated_at"];

      /** A team whose only link to the departure is one ended membership (no section-1 row) and a record. */
      async function recordTeam(tenant: string, stamp: Date, rec: Omit<RecordArgs, "tenant" | "team" | "target">, store: "logs" | "outbox") {
        const team = await mkTeam(tenant);
        const user = await mkMember(tenant);
        await departIn(tenant, user, stamp);
        const row = await addMembership(team, user, tenant, { createdAt: iso(stamp, -2 * SECOND) });
        await endMembership(row, stamp);
        const args = { tenant, team, target: user, ...rec };
        await (store === "logs" ? logsRecord(args) : outboxRecord(args));
        // Untouched since before the departure: no time filter may hide it.
        const hook = await webhook(tenant, team, iso(stamp, -3 * SECOND), iso(stamp, -2 * SECOND));
        return { team, user, hook, row };
      }

      it("a candidate's team lists only webhooks created or updated after the departure; six columns only", async () => {
        const tenant = await newTenant();
        const stamp = newStamp();
        const team = await mkTeam(tenant);
        const user = await mkMember(tenant);
        await departIn(tenant, user, stamp);
        await addMembership(team, user, tenant, { createdAt: iso(stamp, -SECOND) });
        const old = await webhook(tenant, team, iso(stamp, -3 * SECOND), iso(stamp, -2 * SECOND));
        const updated = await webhook(tenant, team, iso(stamp, -3 * SECOND), iso(stamp, SECOND));
        const created = await webhook(tenant, team, iso(stamp, SECOND), iso(stamp, SECOND));
        const unrelatedTeam = await mkTeam(tenant);
        await webhook(tenant, unrelatedTeam, iso(stamp, SECOND), iso(stamp, SECOND));

        const report = await runReport();
        expect(report.fields2).toEqual(SIX);
        const ids = inTenants(report.section2, [tenant]).map((r) => r.id);
        expect(ids.sort()).toEqual([updated, created].sort());
        expect(ids).not.toContain(old);
      });

      it.each(["logs", "outbox"] as const)(
        "a team reached only through a C1-dir record in %s lists all its webhooks; one field off each, it lists none (literal)",
        async (store) => {
          const tenant = await newTenant();
          const stamp = newStamp();
          const status = store === "outbox" ? "SENT" : undefined;
          const found = await recordTeam(tenant, stamp, { backfill: C1_DIR, status }, store);
          const otherBackfill = await recordTeam(tenant, stamp, { backfill: "20261101000000_other_backfill", status }, store);
          const otherAction = await recordTeam(tenant, stamp, { backfill: C1_DIR, action: RESTORE, status }, store);
          const noBackfill = await recordTeam(tenant, stamp, { backfill: null, status }, store);

          const report = await runReport();
          // Preconditions: none of the four teams has a section-1 row.
          const teams = [found, otherBackfill, otherAction, noBackfill].map((t) => t.team);
          expect(report.section1.filter((r) => teams.includes(r.team_id))).toEqual([]);
          expect(inTenants(report.section2, [tenant]).map((r) => r.id)).toEqual([found.hook]);
        },
      );

      it("the team stays listed after the member returned (real returnToTenant), departed again, and after the tenant row was deleted", async () => {
        const tenant = await newTenant();
        const stamp = newStamp();
        const { team, user, hook } = await recordTeam(tenant, stamp, { backfill: C1_DIR }, "logs");
        const actor = { userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM };
        const listed = async () => inTenants((await runReport()).section2, [tenant]).map((r) => r.id);
        expect(await listed()).toEqual([hook]);

        const returned = await withTenantRls(prisma, tenant, (tx) => returnToTenant(tx, tenant, [user], { actor }));
        expect(returned).toEqual([user]);
        const [back] = await sql<{ deactivated_at: Date | null }>(
          `SELECT deactivated_at FROM team_members WHERE team_id = $1::uuid AND user_id = $2::uuid`, team, user,
        );
        expect(back.deactivated_at).toBeNull();
        expect(await listed()).toEqual([hook]);

        const departed = await withTenantRls(prisma, tenant, (tx) => departFromTenant(tx, tenant, [user], { actor }));
        expect(departed).toEqual([user]);
        expect(await listed()).toEqual([hook]);

        await sql(`DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, tenant, user);
        expect(await listed()).toEqual([hook]);
      });
    });

    it.each(bypassTables(reportScript()))("table-list control: with %s removed from the script's bypass list a notice names it", async (removed) => {
      await seedWorldForTableControl();
      const script = reportScript();
      const literal = script.match(/set_config\('app\.bypass_tables', '([a-z_,]+)'/)![1];
      const mutated = script.replace(literal, literal.split(",").filter((t) => t !== removed).join(","));
      expect(mutated).not.toBe(script);
      const notices = await expectBypassNotices(() => runScript(mutated).catch(() => undefined));
      expect(notices).toContainEqual({ table: removed, purpose: "system_maintenance" });
    });

    /** Every table of the report scanned at least once: a candidate, a record in each store, a webhook. */
    async function seedWorldForTableControl() {
      const tenant = await newTenant();
      const stamp = newStamp();
      const team = await mkTeam(tenant);
      const user = await mkMember(tenant);
      await departIn(tenant, user, stamp);
      await addMembership(team, user, tenant, { createdAt: iso(stamp, -SECOND) });
      await logsRecord({ tenant, team, target: user, backfill: RLS_BACKFILL_RERUN_DIR });
      await outboxRecord({ tenant, team, target: user, backfill: RLS_BACKFILL_RERUN_DIR });
      await webhook(tenant, team, iso(stamp, SECOND), iso(stamp, SECOND));
      // A candidate with no record in either store: the record flag is
      // `EXISTS(audit_logs) OR EXISTS(audit_outbox)`, so the outbox arm is only
      // evaluated — and its policy only reports — for a row the logs arm misses.
      const unrecorded = await mkMember(tenant);
      await departIn(tenant, unrecorded, stamp);
      await addMembership(team, unrecorded, tenant, { createdAt: iso(stamp, -SECOND) });
    }
  });

  // ── Contain ─────────────────────────────────────────────────

  describe("contain", () => {
    type Leak = {
      tenant: string;
      stamp: Date;
      team: string;
      admin: string;
      /** user id -> team_members row id */
      rows: { user: string; rowId: string; role: string }[];
    };

    /** A tenant with a tenant OWNER (`admin`) and a team whose members, an OWNER and `members` MEMBERs, all departed. */
    async function seedLeak(members = 1): Promise<Leak> {
      const tenant = await newTenant();
      const stamp = newStamp();
      expect(Date.now() - stamp.getTime()).toBeGreaterThanOrEqual(3_600_000);
      const admin = await ctx.createUser(tenant);
      const team = await mkTeam(tenant);
      const rows: Leak["rows"] = [];
      for (const role of ["OWNER", ...Array.from({ length: members }, () => "MEMBER")]) {
        const user = await mkMember(tenant);
        await departIn(tenant, user, stamp);
        rows.push({ user, rowId: await addMembership(team, user, tenant, { role, createdAt: iso(stamp, -SECOND) }), role });
      }
      return { tenant, stamp, team, admin, rows };
    }

    const tripleOf = (l: Leak, r: Leak["rows"][number]) => [l.tenant, l.team, r.user];
    const goodTriples = (l: Leak) => triplesLiteral(l.rows.map((r) => tripleOf(l, r)));

    async function ownerlessTeams(admin: string): Promise<string[]> {
      mockAuth.mockResolvedValue({ user: { id: admin } });
      const res = await listOwnerless(new NextRequest("http://localhost/api/tenant/teams/ownerless"));
      expect(res.status).toBe(200);
      return ((await res.json()) as { teams: { id: string }[] }).teams.map((t) => t.id);
    }

    /** What a refusal must leave untouched in every tenant the cell created, read through the superuser. */
    async function snapshot() {
      const members = await sql(
        `SELECT id, deactivated_at, deactivated_by_tenant, updated_at FROM team_members WHERE tenant_id = ANY($1::uuid[]) ORDER BY id`, tenants,
      );
      const outbox = await sql(
        `SELECT id FROM audit_outbox WHERE tenant_id = ANY($1::uuid[]) AND payload->'metadata'->>'backfill' = $2 ORDER BY id`, tenants, RLS_BACKFILL_RERUN_DIR,
      );
      return { members, outbox };
    }

    async function outboxRecords(l: Leak) {
      const rows = await sql<{ payload: { targetId: string } }>(
        `SELECT payload FROM audit_outbox WHERE tenant_id = $1::uuid AND payload->'metadata'->>'backfill' = $2`, l.tenant, RLS_BACKFILL_RERUN_DIR,
      );
      return new Map(rows.map((r) => [r.payload.targetId, r.payload]));
    }

    async function expectContained(l: Leak, label: string, notices?: string[]) {
      const after = await readTeamMembers(l.rows.map((r) => r.rowId));
      expect(after.map((r) => [r.deactivated_at?.getTime(), r.deactivated_by_tenant])).toEqual(
        l.rows.map(() => [l.stamp.getTime(), true]),
      );
      const records = await outboxRecords(l);
      expect([...records.keys()].sort()).toEqual(l.rows.map((r) => r.user).sort());
      for (const r of l.rows) {
        expect(records.get(r.user)).toEqual(buildOutboxPayload({
          scope: AUDIT_SCOPE.TEAM,
          action: AUDIT_ACTION.TEAM_MEMBER_TENANT_DEACTIVATE,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          serviceAccountId: null,
          teamId: l.team,
          targetType: AUDIT_TARGET_TYPE.TEAM_MEMBER,
          targetId: r.user,
          metadata: {
            source: TENANT_MEMBERSHIP_SOURCE.TENANT_DEACTIVATION,
            backfill: RLS_BACKFILL_RERUN_DIR,
            departedAt: l.stamp.toISOString(),
            manual: true,
            operator: label,
          },
          ip: null,
          userAgent: null,
        }));
        // The database user goes only to the operator's own session.
        expect(JSON.stringify(records.get(r.user))).not.toContain("passwd_app");
      }
      if (notices) expect(notices.some((m) => m === `contain: ended ${l.rows.length} membership(s) as database user passwd_app`)).toBe(true);
    }

    async function runContain(text: string): Promise<string[]> {
      let collected: ReturnType<typeof collectNotices> | undefined;
      await runScript(text, async (client) => {
        collected = collectNotices(client);
        return collected.stop;
      });
      return collected?.messages ?? [];
    }

    it("ends an OWNER and a member at the tenant's stamp with the marker and outbox records; the team becomes ownerless", async () => {
      const l = await seedLeak();
      expect(await ownerlessTeams(l.admin)).not.toContain(l.team);

      const notices = await runContain(containWith({ triples: goodTriples(l), label: "ops-test" }));

      await expectContained(l, "ops-test", notices);
      expect(await ownerlessTeams(l.admin)).toContain(l.team);
    });

    it("a user id in upper case ends the membership", async () => {
      const l = await seedLeak();
      await runContain(containWith({ triples: goodTriples(l).toUpperCase(), label: "ops-test" }));
      await expectContained(l, "ops-test");
    });

    it("a duplicated triple counts once and ends the membership", async () => {
      const l = await seedLeak();
      const rows = l.rows.map((r) => tripleOf(l, r));
      await runContain(containWith({ triples: triplesLiteral([...rows, rows[0]]), label: "ops-test" }));
      await expectContained(l, "ops-test");
    });

    it("a 255-character label is accepted and recorded whole", async () => {
      const l = await seedLeak();
      const label = "x".repeat(255);
      await runContain(containWith({ triples: goodTriples(l), label }));
      await expectContained(l, label);
    });

    describe("refusals write nothing", () => {
      async function expectRefused(text: string, expected: { message?: RegExp; code?: string }) {
        const before = await snapshot();
        const error = await runScript(text).then(() => null, (e: unknown) => e as { message: string; code?: string });
        expect(error).not.toBeNull();
        if (expected.message) expect(error!.message).toMatch(expected.message);
        if (expected.code) expect(error!.code).toBe(expected.code);
        expect(await snapshot()).toEqual(before);
      }
      const QUALIFY = /membership\(s\) qualify .*nothing was written/;
      const label = "ops-test";

      it("the baseline (all conjuncts hold) succeeds, so each refusal below differs from it in one field", async () => {
        const l = await seedLeak();
        await runContain(containWith({ triples: goodTriples(l), label }));
        await expectContained(l, label);
      });

      it("the membership belongs to another tenant than the triple's (the user has a departed row in the triple's tenant too)", async () => {
        const l = await seedLeak();
        const other = await newTenant();
        await departIn(other, l.rows[1].user, l.stamp);
        await expectRefused(containWith({ triples: triplesLiteral([[other, l.team, l.rows[1].user]]), label }), { message: QUALIFY });
      });

      it("the tenant row is the user's row in another tenant (departed there, active in the triple's tenant)", async () => {
        const l = await seedLeak();
        // A second tenant where the user is active and holds a membership; their row in the first is departed.
        const other = await newTenant();
        const otherTeam = await mkTeam(other);
        const moved = l.rows[1].user;
        await sql(`DELETE FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, other, moved);
        await sql(
          `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at) VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', now(), now())`,
          randomUUID(), other, moved,
        );
        await addMembership(otherTeam, moved, other, { createdAt: iso(l.stamp, -SECOND) });
        const [active] = await sql(`SELECT 1 FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND deactivated_at IS NULL`, other, moved);
        expect(active).toBeDefined();
        await expectRefused(containWith({ triples: triplesLiteral([[other, otherTeam, moved]]), label }), { message: QUALIFY });
        // The first tenant's membership is untouched, and its row stays departed.
        expect((await readTeamMembers([l.rows[1].rowId]))[0].deactivated_at).toBeNull();
      });

      it("the membership is already ended", async () => {
        const l = await seedLeak();
        await endMembership(l.rows[1].rowId, l.stamp);
        await expectRefused(containWith({ triples: triplesLiteral([tripleOf(l, l.rows[1])]), label }), { message: QUALIFY });
      });

      it("the member's tenant row is active", async () => {
        const l = await seedLeak();
        await sql(`UPDATE tenant_members SET deactivated_at = NULL WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, l.tenant, l.rows[1].user);
        await expectRefused(containWith({ triples: triplesLiteral([tripleOf(l, l.rows[1])]), label }), { message: QUALIFY });
      });

      it("the team is another team of the tenant, where the user holds no membership", async () => {
        const l = await seedLeak();
        const elsewhere = await mkTeam(l.tenant);
        await expectRefused(containWith({ triples: triplesLiteral([[l.tenant, elsewhere, l.rows[1].user]]), label }), { message: QUALIFY });
        expect((await readTeamMembers([l.rows[1].rowId]))[0].deactivated_at).toBeNull();
      });

      it("a null id in a triple is refused by name, before the qualify count", async () => {
        const l = await seedLeak();
        await expectRefused(containWith({ triples: `{{${l.tenant},${l.team},NULL}}`, label }), { message: /holds a null id/ });
      });

      it("a mixed list (one qualifying triple, one not) ends neither", async () => {
        const l = await seedLeak(2);
        await sql(`UPDATE tenant_members SET deactivated_at = NULL WHERE tenant_id = $1::uuid AND user_id = $2::uuid`, l.tenant, l.rows[2].user);
        await expectRefused(containWith({ triples: triplesLiteral([tripleOf(l, l.rows[1]), tripleOf(l, l.rows[2])]), label }), { message: QUALIFY },
        );
      });

      it("an empty array", async () => {
        await seedLeak();
        await expectRefused(containWith({ triples: "{}", label }), { message: /two-dimensional uuid array/ });
      });

      it("a one-dimensional array", async () => {
        const l = await seedLeak();
        await expectRefused(containWith({ triples: `{${tripleOf(l, l.rows[1]).join(",")}}`, label }), { message: /two-dimensional uuid array/ });
      });

      it("a two-dimensional array with two columns", async () => {
        const l = await seedLeak();
        await expectRefused(containWith({ triples: triplesLiteral([[l.tenant, l.team]]), label }), { message: /two-dimensional uuid array/ });
      });

      it("a three-dimensional array whose second dimension has three entries", async () => {
        const l = await seedLeak();
        const [t, m, u] = tripleOf(l, l.rows[1]);
        await expectRefused(containWith({ triples: `{{{${t}},{${m}},{${u}}}}`, label }), { message: /two-dimensional uuid array/ });
      });

      it.each([
        ["empty", ""],
        ["256 characters", "x".repeat(256)],
        ["the template token", TEMPLATE_LABEL],
      ])("a label that is %s", async (_name, bad) => {
        const l = await seedLeak();
        await expectRefused(containWith({ triples: goodTriples(l), label: bad }), { message: /operator label must be 1 to 255 characters/ });
      });

      it("a malformed id raises 22P02 at the cast", async () => {
        const l = await seedLeak();
        await expectRefused(containWith({ triples: `{{${l.tenant},${l.team},not-a-uuid}}`, label }), { code: "22P02" });
      });
    });

    describe("locks: each held alone makes the script fail on that statement with 55P03", () => {
      /** `SET LOCAL lock_timeout` goes right after the script's own BEGIN, where it takes effect. */
      function withLockTimeout(script: string): string {
        const begins = script.match(/^BEGIN;$/gm) ?? [];
        if (begins.length !== 1) throw new Error(`expected one top-level BEGIN, found ${begins.length}`);
        return script.replace(/^BEGIN;$/m, "BEGIN;\nSET LOCAL lock_timeout = '1500ms';");
      }

      async function blockedBy(l: Leak, holder: string, params: unknown[], statementText: string): Promise<void> {
        const a = await ctx.su.pool.connect();
        const b = await appPool.connect();
        try {
          await a.query("BEGIN");
          await a.query(holder, params);
          const script = withLockTimeout(containWith({ triples: goodTriples(l), label: "ops-test" }));
          const error = await b.query(script).then(() => null, (e: unknown) => e as { code?: string; where?: string });
          expect(error?.code).toBe("55P03");
          expect(error?.where).toContain(statementText);
        } finally {
          await b.query("ROLLBACK").catch(() => {});
          await a.query("ROLLBACK").catch(() => {});
          b.release();
          a.release();
        }
      }

      it("the advisory lock of an input (tenant, user), key built by the app's helper", async () => {
        const l = await seedLeak();
        await blockedBy(l, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, [advisoryKey(l.tenant, l.rows[1].user)], "pg_advisory_xact_lock");
        expect((await readTeamMembers(l.rows.map((r) => r.rowId))).every((r) => r.deactivated_at === null)).toBe(true);
      });

      it("an input user's tenant_members row", async () => {
        const l = await seedLeak();
        await blockedBy(
          l, `SELECT 1 FROM tenant_members WHERE tenant_id = $1::uuid AND user_id = $2::uuid FOR NO KEY UPDATE`,
          [l.tenant, l.rows[1].user], "FOR UPDATE OF tmb",
        );
      });

      it("an input team's row", async () => {
        const l = await seedLeak();
        await blockedBy(l, `SELECT 1 FROM teams WHERE id = $1::uuid FOR NO KEY UPDATE`, [l.team], "FROM teams WHERE id = ANY");
      });
    });

    it.each(bypassTables(containScript()))("table-list control: with %s removed from the script's bypass list a notice names it", async (removed) => {
      const l = await seedLeak();
      const script = containWith({ triples: goodTriples(l), label: "ops-test" });
      const literal = script.match(/set_config\('app\.bypass_tables', '([a-z_,]+)'/)![1];
      const mutated = script.replace(literal, literal.split(",").filter((t) => t !== removed).join(","));
      expect(mutated).not.toBe(script);
      const notices = await expectBypassNotices(() => runScript(mutated).catch(() => undefined));
      expect(notices).toContainEqual({ table: removed, purpose: "system_maintenance" });
    });
  });
});
