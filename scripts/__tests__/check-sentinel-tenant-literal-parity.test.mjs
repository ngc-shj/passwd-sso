/**
 * Self-test for check-sentinel-tenant-literal-parity.mjs.
 *
 * The gate ties SYSTEM_TENANT_ID (src/lib/constants/app.ts) to the sites that
 * spell the same UUID and cannot dereference it: the sentinel `tenants` row, the
 * CHECK that keeps that tenant memberless, the pair of CHECKs that keep it out
 * of `users` and `teams`, the retention migration, and the two operator-facing
 * docs whose queries a human pastes during an incident.
 *
 * Every case runs the gate against a SYNTHETIC repo root, so none depends on the
 * state of the real tree and none can be made green by editing the real
 * constant. The two arms that matter are opposite: a mismatch must red, and an
 * unmodified tree must not — a gate that refuses everything satisfies the first
 * on its own.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const GATE = join(REPO_ROOT, "scripts/checks/check-sentinel-tenant-literal-parity.mjs");

const REAL_UUID = "00000000-0000-4000-8000-000000000002";
const OTHER_UUID = "00000000-0000-4000-8000-000000000099";

const ROW_DIR = "20260428170853_add_dcr_cleanup_worker_role_and_system_tenant";
const CHECK_DIR = "20260901090000_forbid_system_tenant_membership";
const USERS_TEAMS_DIR = "20260904120000_forbid_system_tenant_on_users_and_teams";
const RETENTION_DIR = "20260902120000_set_system_tenant_audit_retention";
const DOC_FILES = ["alerts.md", "sentinel-tenant-membership.md"];

/**
 * How many times each doc fixture spells the literal — mirroring the gate's own
 * manifest, because the count is now part of what the gate checks. A fixture
 * that always wrote ONE occurrence could not distinguish "present" from
 * "present the right number of times", which is the whole subject of the
 * partial-drift case below.
 */
const DOC_OCCURRENCES = { "alerts.md": 4, "sentinel-tenant-membership.md": 4 };

let root;
const roots = [];

/**
 * A synthetic repo the gate is POINTED AT via SENTINEL_PARITY_ROOT, rather than
 * a copy of the gate placed inside it. Copying was the first attempt and it does
 * not work: the gate imports ts-morph, ESM resolves that upward from the gate's
 * own location, and a fixture under /tmp has no node_modules above it. NODE_PATH
 * does not apply to ESM either. The override is the same mechanism the sibling
 * narrative gate uses, and it carries the same CI pollution guard.
 */
function makeRoot({ constant = REAL_UUID, rowSql = REAL_UUID, checkSql = REAL_UUID, usersTeamsSql = REAL_UUID, retentionSql = REAL_UUID, docs = REAL_UUID, driftOneOf, driftOneUsersTeamsCheck = false, constantName = "SYSTEM_TENANT_ID", omit = [] } = {}) {
  root = mkdtempSync(join(tmpdir(), "sentinel-parity-"));
  roots.push(root);

  // Operator-facing copies. Not SQL the engine runs — queries a human pastes
  // during an incident, where a stale UUID returns a reassuring zero. Each is
  // written with the number of occurrences the gate's manifest declares, so a
  // partial drift is expressible: `driftOneOf` moves exactly the first one.
  mkdirSync(join(root, "docs/operations"), { recursive: true });
  for (const d of DOC_FILES) {
    if (omit.includes(d)) continue;
    const lines = [];
    for (let i = 0; i < DOC_OCCURRENCES[d]; i++) {
      const value = driftOneOf === d && i === 0 ? OTHER_UUID : docs;
      lines.push(`WHERE tenant_id = '${value}'`);
    }
    writeFileSync(join(root, "docs/operations", d), `${lines.join("\n")}\n`, "utf8");
  }

  if (!omit.includes("constantFile")) {
    mkdirSync(join(root, "src/lib/constants"), { recursive: true });
    writeFileSync(
      join(root, "src/lib/constants/app.ts"),
      `export const ${constantName} = "${constant}" as const;\n`,
      "utf8",
    );
  }

  // Always present, even when both sites are omitted: an absent migrations
  // directory is its own refusal one level up, and pinning that instead would
  // leave the "examined 0 named sites" floor — the vacuous-pass guard — with no
  // case reaching it.
  mkdirSync(join(root, "prisma/migrations"), { recursive: true });

  if (!omit.includes("row")) {
    mkdirSync(join(root, "prisma/migrations", ROW_DIR), { recursive: true });
    writeFileSync(
      join(root, "prisma/migrations", ROW_DIR, "migration.sql"),
      `INSERT INTO "tenants" (id) VALUES ('${rowSql}'::uuid);\n`,
      "utf8",
    );
  }
  if (!omit.includes("check")) {
    mkdirSync(join(root, "prisma/migrations", CHECK_DIR), { recursive: true });
    writeFileSync(
      join(root, "prisma/migrations", CHECK_DIR, "migration.sql"),
      `ALTER TABLE "tenant_members" ADD CONSTRAINT "tenant_members_not_system_tenant" CHECK ("tenant_id" <> '${checkSql}'::uuid);\n`,
      "utf8",
    );
  }
  if (!omit.includes("usersTeams")) {
    mkdirSync(join(root, "prisma/migrations", USERS_TEAMS_DIR), { recursive: true });
    // TWO occurrences, matching the real site: one CHECK per table, added in one
    // transaction. `driftOneUsersTeamsCheck` moves only the `teams` one, which is
    // the state a presence test cannot distinguish from parity.
    const teamsValue = driftOneUsersTeamsCheck ? OTHER_UUID : usersTeamsSql;
    writeFileSync(
      join(root, "prisma/migrations", USERS_TEAMS_DIR, "migration.sql"),
      `BEGIN;\n` +
        `ALTER TABLE "teams" ADD CONSTRAINT "teams_not_system_tenant" CHECK ("tenant_id" <> '${teamsValue}'::uuid);\n` +
        `ALTER TABLE "users" ADD CONSTRAINT "users_not_system_tenant" CHECK ("tenant_id" <> '${usersTeamsSql}'::uuid);\n` +
        `COMMIT;\n`,
      "utf8",
    );
  }
  if (!omit.includes("retention")) {
    mkdirSync(join(root, "prisma/migrations", RETENTION_DIR), { recursive: true });
    writeFileSync(
      join(root, "prisma/migrations", RETENTION_DIR, "migration.sql"),
      // Three occurrences, matching the real site: the chain-off guard reads the
      // tenant, the absent-row refusal names it, and the UPDATE targets it.
      `SELECT "audit_chain_enabled" FROM "tenants" WHERE "id" = '${retentionSql}'::uuid;\n` +
        `-- refusal names '${retentionSql}'\n` +
        `UPDATE "tenants" SET "audit_log_retention_days" = 365 WHERE "id" = '${retentionSql}'::uuid;\n`,
      "utf8",
    );
  }
  return root;
}

function runGate(r) {
  const res = spawnSync("node", [GATE], {
    encoding: "utf8",
    env: {
      ...process.env,
      SENTINEL_PARITY_ROOT: r,
      SENTINEL_PARITY_FIXTURE_MODE: "1",
    },
    timeout: 60_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("check-sentinel-tenant-literal-parity", () => {
  it("PASSES when the constant and both SQL sites agree", () => {
    // The allow arm, and it is not decoration: every deny arm below is
    // satisfiable by a gate that refuses unconditionally.
    const r = runGate(makeRoot());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("6 site(s) in parity");
  });

  it("REDS when the constant moves away from both SQL sites", () => {
    // Changing the constant is the realistic drift — and it is the one a
    // value-anchored grep cannot see, because the changed literal drops OUT of
    // the match set instead of mismatching within it.
    const r = runGate(makeRoot({ constant: OTHER_UUID }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(ROW_DIR);
    expect(r.stderr).toContain(CHECK_DIR);
    expect(r.stderr).toContain(USERS_TEAMS_DIR);
    expect(r.stderr).toContain(RETENTION_DIR);
    // BOTH values, not just the constant's: "the CONSTANT is what moves" is
    // useless without saying what to move it to, and the other value lives in a
    // checksummed migration the reader must not open to find out.
    expect(r.stderr).toContain(OTHER_UUID);
    expect(r.stderr).toContain(REAL_UUID);
  });

  it("REDS when only the CHECK literal moves, naming that site alone", () => {
    const r = runGate(makeRoot({ checkSql: OTHER_UUID }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(CHECK_DIR);
    expect(r.stderr).not.toContain(ROW_DIR);
    expect(r.stderr).toContain(OTHER_UUID);
    expect(r.stderr).toContain(REAL_UUID);
  });

  it("REDS when only the tenants-row literal moves, naming that site alone", () => {
    // The site a CHECK-only gate would miss. That row is the FK target of
    // audit_logs.tenant_id, so a sentinel with no row behind it sends every
    // unattributable emit into logAuditAsync's log-only catch arm.
    const r = runGate(makeRoot({ rowSql: OTHER_UUID }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(ROW_DIR);
    expect(r.stderr).not.toContain(CHECK_DIR);
    expect(r.stderr).toContain(OTHER_UUID);
    expect(r.stderr).toContain(REAL_UUID);
  });

  it("REDS when only the users/teams CHECK literals move, naming that site alone", () => {
    const r = runGate(makeRoot({ usersTeamsSql: OTHER_UUID }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(USERS_TEAMS_DIR);
    expect(r.stderr).not.toContain(CHECK_DIR);
    expect(r.stderr).not.toContain(ROW_DIR);
    expect(r.stderr).toContain(OTHER_UUID);
    expect(r.stderr).toContain(REAL_UUID);
  });

  it("REDS when ONE of the users/teams migration's two CHECKs drifts and the other does not", () => {
    // The reason that site's manifest entry carries `occurrences: 2`. The two
    // CHECKs are added in one transaction and must move together; a presence
    // test stays green while `teams` points at a tenant nothing writes to and
    // `users` is still guarded, which is the half-open state the pair exists to
    // make impossible.
    const r = runGate(makeRoot({ driftOneUsersTeamsCheck: true }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(USERS_TEAMS_DIR);
    expect(r.stderr).toContain("1 time(s), expected 2");
    expect(r.stderr).not.toContain(CHECK_DIR);
  });

  it("REFUSES when the users/teams SQL site is missing, rather than skipping it", () => {
    const r = runGate(makeRoot({ omit: ["usersTeams"] }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("MISSING");
    expect(r.stderr).toContain(USERS_TEAMS_DIR.replace(/^\d+/, ""));
  });

  it("REFUSES when the constant declaration is absent, rather than reporting parity", () => {
    // "Examined nothing" must not be spelled the same as "found nothing".
    const r = runGate(makeRoot({ constantName: "SOMETHING_ELSE" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no string-literal declaration");
  });

  it("REFUSES when a named SQL site is missing, rather than skipping it", () => {
    const r = runGate(makeRoot({ omit: ["check"] }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("MISSING");
    expect(r.stderr).toContain(CHECK_DIR.replace(/^\d+/, ""));
  });

  it("REDS when an operator-facing copy drifts, naming that doc", () => {
    // Not SQL the engine runs — a query a human pastes mid-incident. A stale
    // UUID here counts rows for a tenant nothing writes to and returns a
    // reassuring zero, at the one moment somebody is asking whether
    // unattributable events are piling up.
    const r = runGate(makeRoot({ docs: OTHER_UUID }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("docs/operations/alerts.md");
    expect(r.stderr).not.toContain(ROW_DIR);
  });

  it("REDS when ONE of the runbook's four occurrences drifts and the other three do not", () => {
    // The case presence-checking cannot reach, and the reason the manifest
    // carries a count. That runbook spells the UUID four times — once in prose
    // and three times in queries — so a `.includes()` gate stays green while
    // the query an operator actually pastes points at a tenant nothing writes
    // to. The message names the counts, not just the file.
    const r = runGate(makeRoot({ driftOneOf: "sentinel-tenant-membership.md" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("docs/operations/sentinel-tenant-membership.md");
    expect(r.stderr).toContain("3 time(s), expected 4");
    // Scoped: the sibling doc is untouched and must not be named.
    expect(r.stderr).not.toContain("docs/operations/alerts.md");
  });

  it("REFUSES a scan-root override in CI without fixture mode", () => {
    // The env-pollution guard, which every other case in this file runs with
    // FIXTURE_MODE set and therefore never enters. Left unproven, the override
    // is a way to point CI's parity check at a tree that trivially agrees with
    // itself — the gate would print OK having examined the wrong repo.
    const r = spawnSync("node", [GATE], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "true",
        SENTINEL_PARITY_ROOT: makeRoot(),
        SENTINEL_PARITY_FIXTURE_MODE: "",
      },
      timeout: 60_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("SENTINEL_PARITY_ROOT must not be set");
  });

  it("REFUSES when every named site is missing, rather than passing vacuously", () => {
    // The floor. With every site gone the mismatch list still has entries, but
    // `checked` is 0 — and a gate that reported OK on an empty examination
    // would be green precisely when it had checked nothing.
    const r = runGate(makeRoot({ omit: ["row", "check", "usersTeams", "retention", ...DOC_FILES] }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("examined 0 named sites");
  });

  it("REFUSES when the constant's FILE is gone, distinctly from the declaration being gone", () => {
    // Two different failures with two different repairs: the file moved (fix the
    // path) versus the export was renamed (fix the name). A shared message sends
    // the reader to the wrong one.
    const r = runGate(makeRoot({ omit: ["constantFile"] }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not exist");
    expect(r.stderr).not.toContain("no string-literal declaration");
  });

  it("REFUSES when two migration directories share one suffix, rather than picking one", () => {
    // The suffix is a human-chosen name, so a copied migration can duplicate it.
    // Picking either would make the gate's answer depend on readdir order.
    const r0 = makeRoot();
    mkdirSync(join(r0, "prisma/migrations", `20990101000000${CHECK_DIR.replace(/^\d+/, "")}`), {
      recursive: true,
    });
    writeFileSync(
      join(r0, "prisma/migrations", `20990101000000${CHECK_DIR.replace(/^\d+/, "")}`, "migration.sql"),
      `-- copy\n`,
      "utf8",
    );
    const r = runGate(r0);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("AMBIGUOUS");
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // The gate's only execution path. Anchored at line start so a commented-out
    // `# DISABLED: queue_step …` does not satisfy it — that is disarming, not
    // deletion, and `toContain` returns true for both.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^queue_step .*check-sentinel-tenant-literal-parity\.mjs\s*$/m);
  });
});
