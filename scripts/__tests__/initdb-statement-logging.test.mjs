/**
 * infra/postgres/initdb: every file that sets a role password turns off each
 * record of statement text before its first statement — so no cleartext
 * password reaches the server log (logged or refused), pg_stat_statements, or
 * psql's `LINE n:` excerpt on the entrypoint's stderr.
 *
 * This proves the order of the text. That the settings do what they say was
 * checked once on a throwaway postgres:16-alpine (log_statement=all, sentinel
 * passwords, a deliberately refused role statement) — see the deviation log.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INITDB = resolve(__dirname, "..", "..", "infra", "postgres", "initdb");

const REQUIRED = [
  "SET log_statement = 'none';",
  "SET log_min_error_statement = 'panic';",
  "SET log_min_duration_statement = -1;",
  "SET pg_stat_statements.track_utility = off;",
  "\\set VERBOSITY terse",
];
const GUCS = ["log_statement", "log_min_error_statement", "log_min_duration_statement",
  "pg_stat_statements.track_utility"];

/** Statement lines: no blank lines, no `--` comment lines. */
const statements = (src) =>
  src.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("--"));

/** Files that set a role password: any PASSWORD outside a comment. */
const members = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => statements(readFileSync(join(dir, f), "utf8")).some((l) => /PASSWORD/i.test(l)))
    .sort();

/** Violations of the ordering rule in one file's text. */
function violations(src) {
  const errs = [];
  const lines = statements(src);
  let depth = 0;
  let firstOther = -1;
  const seenAt = new Map();
  lines.forEach((l, i) => {
    if (/^\\if\b/.test(l)) depth++;
    if (REQUIRED.includes(l)) {
      if (depth !== 0) errs.push(`inside \\if: ${l}`);
      if (seenAt.has(l)) errs.push(`repeated: ${l}`);
      seenAt.set(l, i);
    } else if (firstOther === -1 && !/^\\getenv\b/.test(l)) {
      firstOther = i;
    }
    if (/^\\endif\b/.test(l)) depth--;
  });
  for (const r of REQUIRED) {
    if (!seenAt.has(r)) errs.push(`missing: ${r}`);
    else if (firstOther !== -1 && seenAt.get(r) > firstOther) {
      errs.push(`after the first statement (${lines[firstOther]}): ${r}`);
    }
  }
  // Nothing after the block may undo it.
  lines.forEach((l) => {
    if (/^\\c(onnect)?\b/.test(l)) errs.push(`reconnects: ${l}`);
    if (REQUIRED.includes(l)) return;
    for (const g of GUCS) {
      const re = new RegExp(`^(SET|RESET)\\s+(LOCAL\\s+|SESSION\\s+)?${g.replace(".", "\\.")}\\b`, "i");
      if (re.test(l)) errs.push(`changes ${g} again: ${l}`);
    }
    if (/^RESET\s+ALL\b/i.test(l)) errs.push(`RESET ALL: ${l}`);
    if (/^\\set\s+VERBOSITY\b/.test(l)) errs.push(`changes VERBOSITY again: ${l}`);
  });
  return errs;
}

describe("infra/postgres/initdb statement logging", () => {
  it("derives the files that set a role password, and they are the expected set", () => {
    expect(members(INITDB)).toEqual([
      "01-create-jackson-db.sql",
      "02-create-app-role.sql",
      "04-create-retention-gc-worker-role.sql",
    ]);
  });

  it.each(members(INITDB))("%s turns statement logging off before its first statement", (f) => {
    expect(violations(readFileSync(join(INITDB, f), "utf8"))).toEqual([]);
  });
});

describe("the ordering rule (fixtures)", () => {
  const block = REQUIRED.join("\n");
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "initdb-fixture-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts the block ahead of \\getenv and the statements (allow side)", () => {
    expect(violations(`-- c\n${block}\n\\getenv v PW\nSELECT :'v' <> '' AS h \\gset\nCREATE ROLE r PASSWORD :'v';`))
      .toEqual([]);
  });

  it("accepts \\getenv ahead of the block", () => {
    expect(violations(`\\getenv v PW\n${block}\nCREATE ROLE r PASSWORD :'v';`)).toEqual([]);
  });

  it.each([
    ["a missing SET", REQUIRED.slice(1).join("\n") + "\nCREATE ROLE r PASSWORD :'v';", /missing: SET log_statement/],
    ["the block after a SELECT carrying the variable",
      `\\getenv v PW\nSELECT :'v' <> '' AS h \\gset\n${block}\nCREATE ROLE r PASSWORD :'v';`, /after the first statement/],
    ["the block after a variable not named *password*",
      `\\getenv secret S\nSELECT :'secret' AS x \\gset\n${block}`, /after the first statement/],
    ["the block inside \\if", `\\if :x\n${block}\n\\endif\nCREATE ROLE r PASSWORD 'p';`, /inside \\if/],
    ["the block commented out", `${REQUIRED.map((l) => `-- ${l}`).join("\n")}\nCREATE ROLE r PASSWORD 'p';`, /missing/],
    ["a later RESET", `${block}\nCREATE ROLE r PASSWORD 'p';\nRESET log_statement;`, /changes log_statement again/],
    ["a later SET LOCAL", `${block}\nSET LOCAL log_min_error_statement = 'error';`, /changes log_min_error_statement again/],
    ["a reconnect", `${block}\n\\c other\nCREATE ROLE r PASSWORD 'p';`, /reconnects/],
  ])("refuses %s", (_name, src, msg) => {
    expect(violations(src).join("\n")).toMatch(msg);
  });

  it("derives a fixture directory's member set from PASSWORD outside comments", () => {
    writeFileSync(join(dir, "a.sql"), "CREATE ROLE a PASSWORD 'x';");
    writeFileSync(join(dir, "b.sql"), "-- PASSWORD only in a comment\nCREATE ROLE b NOLOGIN;");
    expect(members(dir)).toEqual(["a.sql"]);
  });
});
