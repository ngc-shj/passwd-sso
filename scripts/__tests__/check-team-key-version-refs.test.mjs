/**
 * Self-test for scripts/checks/check-team-key-version-refs.mjs (C2, #1009).
 * Each fixture is the real schema and the real prune migration copied into a
 * temp root, with one change; the unchanged copy is the conformant control.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const GATE = join(REPO, "scripts", "checks", "check-team-key-version-refs.mjs");
const SCHEMA = readFileSync(join(REPO, "prisma", "schema.prisma"), "utf8");
const PRUNE_MIGRATION = readdirSync(join(REPO, "prisma", "migrations"))
  .filter((d) => d.endsWith("_team_member_key_prune"))
  .sort()
  .at(-1);
const PRUNE_SQL = readFileSync(join(REPO, "prisma", "migrations", PRUNE_MIGRATION, "migration.sql"), "utf8");

let root;

function write(rel, body) {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function run() {
  try {
    return {
      code: 0,
      out: execFileSync("node", [GATE], {
        encoding: "utf8",
        env: { ...process.env, TEAM_KEY_VERSION_REFS_CHECK_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Replace exactly one occurrence, so a fixture edit that silently misses fails the test. */
function replaceOnce(text, from, to) {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "team-key-version-refs-"));
  write("prisma/schema.prisma", SCHEMA);
  write(`prisma/migrations/${PRUNE_MIGRATION}/migration.sql`, PRUNE_SQL);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-team-key-version-refs", () => {
  it("passes on the real schema and the real function (control)", () => {
    const { code, out } = run();
    expect(code, out).toBe(0);
    expect(out).toContain("OK (");
  });

  it("fails on a new model carrying teamKeyVersion", () => {
    write("prisma/schema.prisma", `${SCHEMA}\nmodel TeamSecret {\n  id             String @id\n  teamKeyVersion Int    @map("team_key_version")\n}\n`);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("UNCLASSIFIED TeamSecret.teamKeyVersion");
  });

  it("fails on a new version field on a known model", () => {
    write(
      "prisma/schema.prisma",
      replaceOnce(
        SCHEMA,
        '  itemKeyVersionHighWater Int     @default(0) @map("item_key_version_high_water")\n',
        '  itemKeyVersionHighWater Int     @default(0) @map("item_key_version_high_water")\n  previousTeamKeyVersion  Int     @default(0) @map("previous_team_key_version")\n',
      ),
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("UNCLASSIFIED TeamPasswordEntry.previousTeamKeyVersion");
  });

  it("fails on a differently named field mapped to team_key_version", () => {
    write(
      "prisma/schema.prisma",
      replaceOnce(SCHEMA, "model TeamTag {\n", 'model TeamTag {\n  wrappedUnder Int @map("team_key_version")\n'),
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("UNCLASSIFIED TeamTag.wrappedUnder");
  });

  it("fails when the function does not name a reference column", () => {
    write(
      `prisma/migrations/${PRUNE_MIGRATION}/migration.sql`,
      PRUNE_SQL.replaceAll("h.team_key_version", "h.item_key_version"),
    );
    expect(PRUNE_SQL).toContain("h.team_key_version");
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("REFERENCE TeamPasswordEntryHistory.teamKeyVersion is not named");
  });

  it("fails when the column is named through an alias bound to another table", () => {
    // `h.team_key_version` stays, but h now names team_password_entries.
    write(
      `prisma/migrations/${PRUNE_MIGRATION}/migration.sql`,
      replaceOnce(
        replaceOnce(PRUNE_SQL, "SELECT 1 FROM team_password_entry_histories h", "SELECT 1 FROM team_password_entries h"),
        "JOIN team_password_entries he ON he.id = h.entry_id",
        "JOIN team_password_entries he ON he.id = h.id",
      ),
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("REFERENCE TeamPasswordEntryHistory.teamKeyVersion is not named");
  });

  it("reads the latest redefinition: a later migration missing a reference predicate fails", () => {
    const later = replaceOnce(PRUNE_SQL, "            AND a.encryption_mode = 0\n", "").replace(
      /AND \(a\.key_version = tmk\.key_version\n\s+OR \(tmk\.key_version = 1 AND COALESCE\(a\.key_version, 0\) < 1\)\)/,
      "AND true",
    );
    expect(later).not.toContain("a.key_version");
    write("prisma/migrations/29990101000000_redefine_prune/migration.sql", later);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("REFERENCE Attachment.keyVersion is not named");
    expect(out).toContain("29990101000000_redefine_prune");
  });

  it("passes a later redefinition that keeps every reference (control for the cell above)", () => {
    write("prisma/migrations/29990101000000_redefine_prune/migration.sql", PRUNE_SQL);
    const { code, out } = run();
    expect(code, out).toBe(0);
    expect(out).toContain("29990101000000_redefine_prune");
  });

  it("fails when the function names the re-key marker", () => {
    write(
      `prisma/migrations/${PRUNE_MIGRATION}/migration.sql`,
      replaceOnce(PRUNE_SQL, "WHERE e.team_id = tmk.team_id\n", "WHERE e.team_id = tmk.team_id AND e.item_key_team_key_version >= 0\n"),
    );
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("names item_key_team_key_version");
  });

  it("fails on a stale classification", () => {
    write("prisma/schema.prisma", replaceOnce(SCHEMA, '  targetVersion   Int       @map("target_version")\n', ""));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("STALE classification MasterKeyRotation.targetVersion");
  });
});
