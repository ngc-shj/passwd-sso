/**
 * Self-test for scripts/checks/check-tenant-claim-event-coverage.mjs — the C5
 * gate requiring every `tenant_claims` writer to append a routing-history event
 * in the same function, and `tenant_claim_events` to have exactly one producer.
 *
 * RT7. Each deny case is a fixture the gate must red on, and each is a case the
 * gate was WRONG about at some point in review:
 *
 *  - the nested-relation writer is the one a `tenantClaim.create` grep never
 *    returns, so a grep implementation passes it green;
 *  - "two arms, one event, in one function" is the case a tree-wide existence
 *    predicate misses, because the missing operation is still emitted elsewhere;
 *  - the TWO-FILE case is the only shape that can express that blindness. In a
 *    single-file fixture the unemitted operation appears nowhere else, so even
 *    the blind predicate reds and the fixture certifies nothing;
 *  - the empty scan root is the case where the gate looked at nothing and would
 *    otherwise print OK.
 *
 * And RT10: the allow side is fixtured too, including the try/catch retry pair
 * that production actually ships — a gate that reds on compliant source gets
 * loosened, and the loosening lands on the blindness above.
 *
 * Fixtures are written into a temp root rather than committed, following
 * check-critical-audit-atomic.test.mjs. The gate's DERIVED inputs (the Prisma
 * relation field name, the operation set) resolve from the real repo root
 * regardless of the scan-root override, so these fixtures exercise the real
 * derivation rather than a fake copy shipped beside them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-tenant-claim-event-coverage.mjs");

let root;

function runGuard(scanRoot = root, extraEnv = {}) {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      TENANT_CLAIM_EVENT_COVERAGE_ROOT: scanRoot,
      // Every case here overrides the scan root, which is the state the sec-F6
      // guard refuses under CI. Acknowledging fixture mode explicitly is the
      // point of that guard — see the ENV_POLLUTION_GUARD case below.
      TENANT_CLAIM_EVENT_COVERAGE_FIXTURE_MODE: "1",
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function write(rel, contents) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

const EVENT = (op) =>
  `await recordTenantClaimEvent(tx, {\n` +
  `  claim, operation: "${op}", oldTenantId: null, newTenantId: t.id,\n` +
  `  oldRevokedAt: null, newRevokedAt: null, actorLabel: "x",\n` +
  `});`;

/** Spelling 2 — the nested relation write a delegate grep cannot see. */
const NESTED_WRITE = `await tx.tenant.create({ data: { name, slug, claims: { create: { claim } } } });`;
/** Spelling 1 — the plain delegate write. */
const DELEGATE_WRITE = `await tx.tenantClaim.updateMany({ where: { claim }, data: { revokedAt: null } });`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tce-gate-"));
  // Every fixture tree needs at least one compliant writer somewhere, or the
  // gate's own writer-count floor fires and masks the case under test.
  // The forbidden-pattern runner needs a SUBJECT; without one it exits 2 by
  // design ("looked at nothing" is not "found nothing wrong").
  write(
    "prisma/migrations/20260101000000_add_tenant_claim_events/migration.sql",
    `CREATE TABLE "tenant_claim_events" (id UUID NOT NULL);\n`,
  );
  write(
    "src/lib/baseline.ts",
    `export async function baseline(tx, claim, name, slug) {\n` +
      `  const t = ${NESTED_WRITE.replace("await ", "")}\n  ${EVENT("register")}\n}\n`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-tenant-claim-event-coverage", () => {
  it("passes when a nested-relation writer emits its event", () => {
    const r = runGuard();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/OK \(\d+ tenant_claims writer/);
  });

  it("fails a delegate writer with no event", () => {
    write(
      "scripts/offender.ts",
      `export async function revoke(tx, claim) {\n  ${DELEGATE_WRITE}\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/scripts\/offender\.ts:2: writes tenant_claims but calls no/);
  });

  it("fails a NESTED-RELATION writer with no event (the case a grep passes green)", () => {
    write(
      "src/lib/offender.ts",
      `export async function reg(tx, claim, name, slug) {\n  ${NESTED_WRITE}\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/src\/lib\/offender\.ts:2: writes tenant_claims but calls no/);
  });

  it("fails an upsert that nests the claim write under create/update, not data", () => {
    // `create` takes `data:`; `upsert` splits the same payload across `create:`
    // and `update:`. A carrier list of just `data` registers no writer here and
    // silently stops requiring an event — a blind spot in a control declared
    // fail-closed, and one no live member exercises today, which is exactly why
    // it needs a fixture rather than a comment.
    write(
      "scripts/upsert.ts",
      `export async function up(tx, claim, name, slug) {\n` +
        `  await tx.tenant.upsert({ where: { slug },\n` +
        `    create: { name, slug, claims: { create: { claim } } },\n` +
        `    update: { name } });\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/scripts\/upsert\.ts:2: writes tenant_claims but calls no/);
  });

  it("fails a nested relation write that is not a creation verb (connect = reassignment)", () => {
    // `claims: { connect: { id } }` inside tenant.update rewrites
    // tenant_claims.tenant_id — a reassignment, i.e. exactly what this table
    // exists to record. A creation-verb list registered no writer at all here.
    write(
      "scripts/nested-connect.ts",
      `export async function move(tx, id, claimId) {\n` +
        `  await tx.tenant.update({ where: { id }, data: { claims: { connect: { id: claimId } } } });\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/scripts\/nested-connect\.ts:2: writes tenant_claims but calls no/);
  });

  it("fails when one arm emits twice and another emits nothing (distinct operations, not a count)", () => {
    // The counterexample a raw call count passes: two writers, two producer
    // calls, but both name the same operation — the arms are mutually
    // exclusive, so the second arm is recorded nowhere.
    write(
      "scripts/dup-op.ts",
      `export async function add(tx, claim, t) {\n` +
        `  if (a) {\n    ${DELEGATE_WRITE}\n    ${EVENT("reassign")}\n    ${EVENT("reassign")}\n` +
        `  } else if (b) {\n    ${DELEGATE_WRITE}\n  }\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/only 1 distinct operation\(s\) recorded \(reassign\)/);
  });

  it("fails two writer arms sharing one function when only one event is emitted", () => {
    write(
      "scripts/two-arms.ts",
      `export async function add(tx, claim, t) {\n` +
        `  if (a) {\n    ${DELEGATE_WRITE}\n    ${EVENT("reassign")}\n` +
        `  } else if (b) {\n    ${DELEGATE_WRITE}\n  }\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/2 tenant_claims writer\(s\) but only 1 distinct operation/);
  });

  it("fails an unemitted writer even when the SAME operation is emitted in another file", () => {
    // The two-file shape. A single-file fixture cannot express this: with only
    // one file, the operation appears nowhere else and even a tree-wide
    // existence predicate reds, so the fixture would certify a blind gate.
    write(
      "src/lib/emits-register.ts",
      `export async function ok(tx, claim, name, slug) {\n` +
        `  const t = ${NESTED_WRITE.replace("await ", "")}\n  ${EVENT("register")}\n}\n`,
    );
    write(
      "scripts/silent-register.ts",
      `export async function silent(tx, claim, name, slug) {\n  ${NESTED_WRITE}\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/scripts\/silent-register\.ts:2: writes tenant_claims but calls no/);
  });

  it("fails a producer call handed the global `prisma` client instead of the transaction", () => {
    write(
      "scripts/global-client.ts",
      `export async function bad(prisma, claim, t) {\n` +
        `  ${DELEGATE_WRITE.replace("tx.", "prisma.")}\n` +
        `  await recordTenantClaimEvent(prisma, {\n` +
        `    claim, operation: "revoke", oldTenantId: t.id, newTenantId: t.id,\n` +
        `    oldRevokedAt: null, newRevokedAt: new Date(), actorLabel: "x",\n  });\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/called with the global `prisma` client/);
  });

  it("fails an operation literal that is not a member of the const-object", () => {
    write(
      "scripts/typo.ts",
      `export async function bad(tx, claim, t) {\n  ${DELEGATE_WRITE}\n  ${EVENT("reasign")}\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/operation "reasign" is not a member of TENANT_CLAIM_EVENT_OPERATION/);
  });

  it("fails a second producer — a tenantClaimEvent write outside the producer module", () => {
    write(
      "scripts/second-producer.ts",
      `export async function sneaky(tx) {\n` +
        `  await tx.tenantClaimEvent.create({ data: { claim: "x" } });\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/tenantClaimEvent\.create\(\) outside src\/lib\/tenant\/tenant-claim-event\.ts/);
  });

  it("exits 2 — not 0 — when the scan root contains nothing to analyse", () => {
    // Every predicate detects a VIOLATION, so zero files means zero violations.
    // Without the floor this is the state in which the gate prints OK while
    // looking at nothing, and a leaked env override or a renamed directory puts
    // it there permanently.
    const empty = mkdtempSync(join(tmpdir(), "tce-empty-"));
    try {
      // The tree carries the runner's SUBJECT but no source at all, so the
      // floor under test is the one that fires — not the migration check.
      mkdirSync(join(empty, "prisma/migrations/20260101000000_add_tenant_claim_events"), { recursive: true });
      writeFileSync(join(empty, "prisma/migrations/20260101000000_add_tenant_claim_events/migration.sql"), `CREATE TABLE "tenant_claim_events" (id UUID NOT NULL);\n`, "utf8");
      const r = runGuard(empty);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/analysed 0 files/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses a scan-root override under CI without an explicit fixture-mode acknowledgement (sec-F6)", () => {
    // The empty-scan and zero-writer floors do NOT cover this: the baseline
    // fixture written in beforeEach IS a compliant writer, so an override
    // leaking into a real CI run yields a non-zero file count, a non-zero
    // writer count, zero violations and a green OK — while the real source is
    // never read. That is a silent, permanent retirement of the gate.
    const r = runGuard(root, {
      CI: "true",
      TENANT_CLAIM_EVENT_COVERAGE_FIXTURE_MODE: "",
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/ENV_POLLUTION_GUARD/);
  });

  it("allows the override under CI when fixture mode is acknowledged", () => {
    const r = runGuard(root, { CI: "true" });
    expect(r.exitCode).toBe(0);
  });

  it("fails a migration carrying a C1 forbidden pattern", () => {
    // The plan names THIS gate as the runner for C1's three migration patterns.
    // A forbidden pattern with no runner is the shape D-13 recorded one PR ago:
    // a rule that reads as enforced and is not.
    write(
      "prisma/migrations/20260101000000_add_tenant_claim_events/migration.sql",
      `CREATE TABLE "tenant_claim_events" (id UUID NOT NULL);\n` +
        `CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END; $$;\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/forbidden pattern .*SECURITY DEFINER/);
  });

  it("fails a migration that re-arms the cascade with a foreign key", () => {
    write(
      "prisma/migrations/20260101000000_add_tenant_claim_events/migration.sql",
      `CREATE TABLE "tenant_claim_events" (id UUID NOT NULL,\n` +
        `  CONSTRAINT fk FOREIGN KEY (id) REFERENCES "tenants"("id") ON DELETE CASCADE);\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/forbidden pattern .*REFERENCES/);
  });

  it("fails a LATER migration that re-arms the cascade — not only the creating one", () => {
    // The creating migration is immutable after merge, so a subject set anchored
    // on it checks a file nobody can change and misses the one change that
    // destroys this table's purpose: a later ALTER TABLE adding the FK.
    write(
      "prisma/migrations/20260202000000_later_change/migration.sql",
      `ALTER TABLE "tenant_claim_events" ADD CONSTRAINT fk\n` +
        `  FOREIGN KEY (old_tenant_id) REFERENCES "tenants"("id") ON DELETE CASCADE;\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/20260202000000_later_change\/migration\.sql: forbidden pattern .*REFERENCES/);
  });

  it("passes a migration whose ONLY mention of the table is a comment", () => {
    // Comments are stripped before the subject match, so prose about this table
    // cannot enrol an unrelated migration and then have an unrelated FK read as
    // an accusation against it. D-3 records that the first drafts of the real
    // migration failed this gate on comments explaining why those very things
    // are absent; the widened subject set would have multiplied that.
    write(
      "prisma/migrations/20260303000000_unrelated/migration.sql",
      `-- deliberately NOT modelled on tenant_claim_events, which is append-only\n` +
        `ALTER TABLE "tenant_notes" ADD CONSTRAINT fk\n` +
        `  FOREIGN KEY (tenant_id) REFERENCES "tenants"("id") ON DELETE CASCADE;\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(0);
  });

  it("still catches a later FK when the file also contains a `--` inside a string literal", () => {
    // The three shapes below are why the comment strip is used for SUBJECT
    // SELECTION ONLY and never feeds the matchers: a quote-unaware strip eats
    // real SQL, and its failure direction is FALSE-ALLOW — the same direction
    // that got per-statement splitting withdrawn one round earlier.
    write(
      "prisma/migrations/20260202000000_later_change/migration.sql",
      `ALTER TABLE "tenant_claim_events" ADD COLUMN note TEXT DEFAULT 'usage: a -- b';\n` +
        `ALTER TABLE "tenant_claim_events" ADD CONSTRAINT fk\n` +
        `  FOREIGN KEY (old_tenant_id) REFERENCES "tenants"("id");\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/forbidden pattern .*REFERENCES/);
  });

  it("still catches a later FK when a line comment contains an unclosed block-comment opener", () => {
    write(
      "prisma/migrations/20260202000000_later_change/migration.sql",
      `-- TODO: revisit the /* old approach here\n` +
        `ALTER TABLE "tenant_claim_events" ADD CONSTRAINT fk\n` +
        `  FOREIGN KEY (old_tenant_id) REFERENCES "tenants"("id");\n` +
        `/* an ordinary block comment later in the file */\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/forbidden pattern .*REFERENCES/);
  });

  it("exits 2 when no migration creates the table — no subject is not a clean bill", () => {
    // Migrations directory present, but nothing in it creates the table — the
    // shape a renamed or dropped migration produces.
    rmSync(join(root, "prisma/migrations/20260101000000_add_tenant_claim_events"), {
      recursive: true,
      force: true,
    });
    const r = runGuard();
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no migration creates tenant_claim_events/);
  });

  it("exits 2 when the migrations directory itself is unreadable", () => {
    rmSync(join(root, "prisma"), { recursive: true, force: true });
    const r = runGuard();
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/cannot read prisma\/migrations/);
  });

  it("exits 2 when the tree has source files but no writer matches at all", () => {
    const bare = mkdtempSync(join(tmpdir(), "tce-bare-"));
    try {
      mkdirSync(join(bare, "src/lib"), { recursive: true });
      writeFileSync(join(bare, "src/lib/x.ts"), "export const x = 1;\n", "utf8");
      mkdirSync(join(bare, "prisma/migrations/20260101000000_add_tenant_claim_events"), { recursive: true });
      writeFileSync(join(bare, "prisma/migrations/20260101000000_add_tenant_claim_events/migration.sql"), `CREATE TABLE "tenant_claim_events" (id UUID NOT NULL);\n`, "utf8");

      const r = runGuard(bare);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/no tenant_claims writer at all/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  // ─── allow side (RT10) ───────────────────────────────────────────────────

  it("passes a try/catch retry pair that emits ONE event", () => {
    // The shape production actually ships: the catch-clause create is the
    // alternative arm of the try-clause create — one logical registration,
    // retried — so a statement COUNT would red on compliant source, and the
    // repair for that red is the loosening that reopens the two-arm blindness.
    write(
      "src/lib/retry.ts",
      `export async function create(tx, claim, name, slug) {\n` +
        `  let t;\n  try {\n    t = ${NESTED_WRITE.replace("await ", "")}\n` +
        `  } catch (e) {\n    t = ${NESTED_WRITE.replace("await ", "")}\n  }\n` +
        `  ${EVENT("register")}\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(0);
  });

  it("passes a tenantClaimEvent READ outside the producer module", () => {
    // `tenant-domain history` reads the table from scripts/. A verb-blind rule
    // would ban the contract's own required read path.
    write(
      "scripts/history.ts",
      `export async function history(tx, claim) {\n` +
        `  return tx.tenantClaimEvent.findMany({ where: { claim } });\n}\n`,
    );
    const r = runGuard();
    expect(r.exitCode).toBe(0);
  });

  it("derives its identifiers from the real repo, not from the fixture tree", () => {
    // V4: if the derived inputs moved with the scan-root override, these
    // fixtures would need a fake schema.prisma and a fake const-object beside
    // them, and the real derivation would never run. The nested-relation
    // fixtures above spell `claims` and the operation fixtures spell real
    // operation values; both only match because the gate read the real files.
    const r = runGuard();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/relation field "claims", 4 operations/);
  });
});
