/**
 * Self-test for scripts/checks/check-team-key-version-refs.mjs (C2, #1009).
 * Each fixture is the real schema and the latest real migration defining the
 * prune function copied into a temp root, with one change; the unchanged copy
 * is the conformant control. The shape cells cover the lock-then-decide order
 * (lib/team-key-prune-shape.mjs); the fail-loud cells cover inputs the gate
 * cannot read.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const GATE = join(REPO, "scripts", "checks", "check-team-key-version-refs.mjs");
const SCHEMA = readFileSync(join(REPO, "prisma", "schema.prisma"), "utf8");
const MIGRATIONS = join(REPO, "prisma", "migrations");
const PRUNE_MIGRATION = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(MIGRATIONS, d.name, "migration.sql")))
  .map((d) => d.name)
  .filter((name) => /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?team_member_key_prune\b/i.test(
    readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"),
  ))
  .sort()
  .at(-1);
const PRUNE_SQL = readFileSync(join(MIGRATIONS, PRUNE_MIGRATION, "migration.sql"), "utf8");
const PRUNE_PATH = `prisma/migrations/${PRUNE_MIGRATION}/migration.sql`;

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
  write(PRUNE_PATH, PRUNE_SQL);
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
      PRUNE_PATH,
      PRUNE_SQL.replace(/\bh\.team_key_version/g, "h.item_key_version"),
    );
    expect(PRUNE_SQL).toMatch(/\bh\.team_key_version/);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("REFERENCE TeamPasswordEntryHistory.teamKeyVersion is not named");
  });

  it("fails when the column is named through an alias bound to another table", () => {
    // `h.team_key_version` stays, but h now names team_password_entries.
    write(
      PRUNE_PATH,
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
      /AND \(a\.key_version = p\.key_version\n\s+OR \(p\.key_version = 1 AND COALESCE\(a\.key_version, 0\) < 1\)\)/,
      "AND true",
    );
    expect(later).not.toMatch(/\ba\.key_version/);
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
      PRUNE_PATH,
      replaceOnce(PRUNE_SQL, "WHERE e.team_id = p.team_id\n", "WHERE e.team_id = p.team_id AND e.item_key_team_key_version >= 0\n"),
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

  it("does not count a reference named only in the candidate statement", () => {
    // The candidate statement reads before the locks are held; the RETURN QUERY decides.
    const block = /       AND NOT EXISTS \(\n         SELECT 1 FROM team_password_entry_histories h\n[\s\S]*?\n       \)\n/;
    expect(PRUNE_SQL).toMatch(block);
    write(PRUNE_PATH, PRUNE_SQL.replace(block, ""));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("REFERENCE TeamPasswordEntryHistory.teamKeyVersion is not named");
    expect(out).toContain("RETURN QUERY");
  });

  describe("body shape (choose unlocked, lock the teams, then decide in a later statement)", () => {
    const LOCK_STATEMENT = /  SELECT array_agg\(s\.id\) INTO v_teams\n[\s\S]*?FOR NO KEY UPDATE OF t SKIP LOCKED\n    \) s;\n/;

    function shapeFails(sql, message) {
      write(PRUNE_PATH, sql);
      const { code, out } = run();
      expect(code, out).toBe(1);
      expect(out).toContain(message);
    }

    it("fails when the team-lock statement is missing", () => {
      expect(PRUNE_SQL).toMatch(LOCK_STATEMENT);
      shapeFails(PRUNE_SQL.replace(LOCK_STATEMENT, ""), "must have exactly one team-lock statement (SELECT ... INTO ... FOR NO KEY UPDATE), found 0");
    });

    it("fails when the team lock does not skip locked teams", () => {
      shapeFails(
        replaceOnce(PRUNE_SQL, "FOR NO KEY UPDATE OF t SKIP LOCKED", "FOR NO KEY UPDATE OF t"),
        "must lock teams with FOR NO KEY UPDATE OF <teams alias> SKIP LOCKED",
      );
    });

    it("fails when the lock is a weaker FOR SHARE", () => {
      shapeFails(
        replaceOnce(PRUNE_SQL, "FOR NO KEY UPDATE OF t SKIP LOCKED", "FOR SHARE OF t SKIP LOCKED"),
        "must lock teams with FOR NO KEY UPDATE OF <teams alias> SKIP LOCKED",
      );
    });

    it("fails on a PERFORM between the lock and the RETURN QUERY", () => {
      shapeFails(
        replaceOnce(PRUNE_SQL, "  RETURN QUERY\n", "  PERFORM 1 FROM team_member_keys;\n  RETURN QUERY\n"),
        "unexpected statement in team_member_key_prune",
      );
    });

    it("fails on a second SELECT statement", () => {
      shapeFails(
        replaceOnce(PRUNE_SQL, "  RETURN QUERY\n", "  SELECT count(*) INTO v_teams FROM team_member_keys;\n  RETURN QUERY\n"),
        "must have exactly one unlocked candidate statement (SELECT ... INTO, no FOR UPDATE/SHARE), found 2",
      );
    });

    it("fails on a DELETE outside the RETURN QUERY", () => {
      shapeFails(
        replaceOnce(PRUNE_SQL, "  RETURN QUERY\n", "  DELETE FROM team_member_keys WHERE false;\n  RETURN QUERY\n"),
        "unexpected statement in team_member_key_prune",
      );
    });

    it("fails when the RETURN QUERY is not restricted to the locked teams", () => {
      shapeFails(
        replaceOnce(PRUNE_SQL, "     WHERE tmk.team_id = ANY (v_teams)\n       AND tmk.key_version", "     WHERE tmk.key_version"),
        "must restrict to the locked teams",
      );
    });

    it("fails when the decision precedes the lock", () => {
      const lock = LOCK_STATEMENT.exec(PRUNE_SQL)[0];
      const decide = /  RETURN QUERY\n[\s\S]*?GROUP BY del\.tenant_id, del\.team_id, del\.key_version;\n/.exec(PRUNE_SQL)[0];
      shapeFails(PRUNE_SQL.replace(lock, "").replace(decide, `${decide}${lock}`), "team-lock statement must precede its RETURN QUERY");
    });

    it("fails when the bypass check is not the first statement", () => {
      const bypass = /  IF NOT \(SELECT public\.rls_bypass_admits\('team_member_keys'\)\) THEN\n[\s\S]*?END IF;\n/.exec(PRUNE_SQL)[0];
      shapeFails(
        PRUNE_SQL.replace(bypass, "").replace("  -- Step 1,", `${bypass}  -- Step 1,`),
        "first statement of team_member_key_prune must be the RLS-bypass check",
      );
    });

    it("fails without the READ COMMITTED guard", () => {
      const guard = /  IF current_setting\('transaction_isolation'\)[\s\S]*?END IF;\n/.exec(PRUNE_SQL)[0];
      shapeFails(PRUNE_SQL.replace(guard, ""), "must refuse unless current_setting('transaction_isolation') is 'read committed'");
    });

    const CANDIDATE_STATEMENT = /  SELECT array_agg\(c\.id\) INTO v_cands\n[\s\S]*?\n    \) c;\n/;

    it("fails without the unlocked candidate statement", () => {
      expect(PRUNE_SQL).toMatch(CANDIDATE_STATEMENT);
      shapeFails(PRUNE_SQL.replace(CANDIDATE_STATEMENT, ""), "must have exactly one unlocked candidate statement (SELECT ... INTO, no FOR UPDATE/SHARE), found 0");
    });

    it("fails when the candidate statement takes a lock (the search would run under it)", () => {
      shapeFails(
        replaceOnce(PRUNE_SQL, "       LIMIT 25\n    ) c;", "       LIMIT 25\n       FOR SHARE OF t\n    ) c;"),
        "must have exactly one team-lock statement (SELECT ... INTO ... FOR NO KEY UPDATE), found 2",
      );
    });

    it("fails when the candidate cap is the batch parameter", () => {
      shapeFails(replaceOnce(PRUNE_SQL, "       LIMIT 25\n", "       LIMIT p_batch\n"), "must cap the teams with LIMIT <integer literal>");
    });

    it("passes another literal cap (allow side of the cell above)", () => {
      write(PRUNE_PATH, replaceOnce(PRUNE_SQL, "       LIMIT 25\n", "       LIMIT 10\n"));
      const { code, out } = run();
      expect(code, out).toBe(0);
    });

    it("fails when the team-lock statement reads another table", () => {
      shapeFails(
        replaceOnce(
          PRUNE_SQL,
          "       WHERE t.id = ANY (v_cands)\n",
          "       WHERE t.id = ANY (v_cands)\n         AND EXISTS (SELECT 1 FROM team_member_keys k2 WHERE k2.team_id = t.id)\n",
        ),
        "team-lock statement must read only teams",
      );
    });

    it("fails when the team-lock statement is not restricted to the candidates", () => {
      shapeFails(replaceOnce(PRUNE_SQL, "       WHERE t.id = ANY (v_cands)\n", "       WHERE true\n"), "must restrict to the candidates");
    });

    it("fails when the lock precedes the candidate search", () => {
      const cand = CANDIDATE_STATEMENT.exec(PRUNE_SQL)[0];
      const lock = LOCK_STATEMENT.exec(PRUNE_SQL)[0];
      shapeFails(PRUNE_SQL.replace(cand, "").replace(lock, `${lock}${cand}`), "candidate statement must precede its team-lock statement");
    });

    it("fails on the round-1 body (lock and search in one statement)", () => {
      const round1 = readFileSync(join(MIGRATIONS, "20261109100000_team_member_key_prune_team_lock", "migration.sql"), "utf8");
      shapeFails(round1, "team-lock statement must read only teams");
    });

    it("fails on dynamic SQL", () => {
      shapeFails(
        replaceOnce(PRUNE_SQL, "  RETURN QUERY\n  WITH pairs", "  RETURN QUERY EXECUTE 'SELECT 1';\n  RETURN QUERY\n  WITH pairs"),
        "must not be dynamic (EXECUTE)",
      );
    });
  });

  describe("fails loudly on input it cannot read", () => {
    it("no migration defines the function", () => {
      rmSync(join(root, "prisma", "migrations", PRUNE_MIGRATION), { recursive: true });
      const { code, out } = run();
      expect(code).toBe(1);
      expect(out).toContain("no migration under prisma/migrations defines team_member_key_prune");
    });

    it("an unclosed dollar-quoted body", () => {
      write(PRUNE_PATH, PRUNE_SQL.slice(0, PRUNE_SQL.indexOf("$function$;")));
      const { code, out } = run();
      expect(code).toBe(1);
      expect(out).toContain("the body of team_member_key_prune is not closed by $function$");
    });

    it("a missing schema", () => {
      rmSync(join(root, "prisma", "schema.prisma"));
      const { code, out } = run();
      expect(code).toBe(1);
      expect(out).toContain("prisma schema not found at");
    });

    it("a schema with zero version columns", () => {
      write("prisma/schema.prisma", "model Plain {\n  id String @id\n}\n");
      const { code, out } = run();
      expect(code).toBe(1);
      expect(out).toContain("derived zero version columns");
    });
  });
});
