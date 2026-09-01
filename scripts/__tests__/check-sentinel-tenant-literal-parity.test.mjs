/**
 * Self-test for check-sentinel-tenant-literal-parity.mjs.
 *
 * The gate ties SYSTEM_TENANT_ID (src/lib/constants/app.ts) to the two SQL sites
 * that spell the same UUID and cannot dereference it: the sentinel `tenants` row
 * and the CHECK that keeps that tenant memberless.
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
function makeRoot({ constant = REAL_UUID, rowSql = REAL_UUID, checkSql = REAL_UUID, constantName = "SYSTEM_TENANT_ID", omit = [] } = {}) {
  root = mkdtempSync(join(tmpdir(), "sentinel-parity-"));
  roots.push(root);

  mkdirSync(join(root, "src/lib/constants"), { recursive: true });
  writeFileSync(
    join(root, "src/lib/constants/app.ts"),
    `export const ${constantName} = "${constant}" as const;\n`,
    "utf8",
  );

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
    expect(r.stdout).toContain("2 SQL site(s) in parity");
  });

  it("REDS when the constant moves away from both SQL sites", () => {
    // Changing the constant is the realistic drift — and it is the one a
    // value-anchored grep cannot see, because the changed literal drops OUT of
    // the match set instead of mismatching within it.
    const r = runGate(makeRoot({ constant: OTHER_UUID }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(ROW_DIR);
    expect(r.stderr).toContain(CHECK_DIR);
  });

  it("REDS when only the CHECK literal moves, naming that site alone", () => {
    const r = runGate(makeRoot({ checkSql: OTHER_UUID }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(CHECK_DIR);
    expect(r.stderr).not.toContain(ROW_DIR);
  });

  it("REDS when only the tenants-row literal moves, naming that site alone", () => {
    // The site a CHECK-only gate would miss. That row is the FK target of
    // audit_logs.tenant_id, so a sentinel with no row behind it sends every
    // unattributable emit into logAuditAsync's log-only catch arm.
    const r = runGate(makeRoot({ rowSql: OTHER_UUID }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(ROW_DIR);
    expect(r.stderr).not.toContain(CHECK_DIR);
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

  it("REFUSES when every named SQL site is missing, rather than passing vacuously", () => {
    // The floor. With both sites gone the mismatch list is empty, and a gate
    // that reported OK there would be green precisely when it had checked
    // nothing.
    const r = runGate(makeRoot({ omit: ["row", "check"] }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("examined 0 SQL sites");
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // The gate's only execution path. Anchored at line start so a commented-out
    // `# DISABLED: queue_step …` does not satisfy it — that is disarming, not
    // deletion, and `toContain` returns true for both.
    const prePr = readFileSync(join(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^queue_step .*check-sentinel-tenant-literal-parity\.mjs\s*$/m);
  });
});
