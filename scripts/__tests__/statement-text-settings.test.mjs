/**
 * scripts/lib/statement-text-settings.mjs is the one list of settings that
 * record statement text. Three places apply it: the bootstrap imports it; the
 * rotation library and the initdb files spell it out, and are pinned to it here.
 * (Whether the list covers every such setting the server has is the integration
 * test src/__tests__/db-integration/statement-text-settings.integration.test.ts.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STATEMENT_TEXT_SETTINGS,
  TRANSACTION_START_SETTING,
  statementScopedResetStatements,
  statementScopedSetStatements,
  statementTextSetStatements,
} from "../lib/statement-text-settings.mjs";
import { runBootstrap } from "../bootstrap-rds-roles.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const LIST = statementTextSetStatements();

/** SET lines for listed settings, in file order. */
const setLines = (src) =>
  src.split("\n").map((l) => l.trim())
    .filter((l) => STATEMENT_TEXT_SETTINGS.some(([name]) => l.startsWith(`SET ${name} `)));

describe("statement-text settings", () => {
  it("lists each setting once", () => {
    const names = STATEMENT_TEXT_SETTINGS.map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
  });

  it("scripts/lib/set-role-password.sh sets exactly the list, in order", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/lib/set-role-password.sh"), "utf8");
    expect(setLines(src)).toEqual(LIST);
  });

  it.each([
    "01-create-jackson-db.sql",
    "02-create-app-role.sql",
    "04-create-retention-gc-worker-role.sql",
  ])("infra/postgres/initdb/%s sets exactly the list, in order", (f) => {
    const src = readFileSync(join(REPO_ROOT, "infra/postgres/initdb", f), "utf8");
    expect(setLines(src)).toEqual(LIST);
  });
});

describe("the statement-scoped helpers the bootstrap wraps each password statement in", () => {
  // Pinned to the list itself: the bootstrap's own test (T11) compares against
  // these helpers, so a setting a helper dropped would pass there.
  const names = STATEMENT_TEXT_SETTINGS.map(([n]) => n);
  const setNames = statementScopedSetStatements().map((s) => /^SET (\S+) = /.exec(s)?.[1]);
  const resetNames = statementScopedResetStatements().map((s) => /^RESET (\S+);$/.exec(s)?.[1]);

  it("lists the transaction-start setting", () => {
    expect(names).toContain(TRANSACTION_START_SETTING);
  });

  it("sets every listed setting but the transaction-start one, with the list's value", () => {
    expect([...setNames, TRANSACTION_START_SETTING].sort()).toEqual([...names].sort());
    expect(statementScopedSetStatements()).toEqual(
      LIST.filter((s) => !s.startsWith(`SET ${TRANSACTION_START_SETTING} `)),
    );
  });

  it("resets exactly what it set, in reverse", () => {
    expect(resetNames).toEqual([...setNames].reverse());
  });
});

describe("runBootstrap", () => {
  /** Answers the superuser probe, records statements, and stops at BEGIN. */
  const fakeClient = (rolsuper) => {
    const statements = [];
    return {
      statements,
      escapeLiteral: (v) => `'${v}'`,
      query: async (text) => {
        statements.push(text);
        if (text === "BEGIN") throw new Error("stop at BEGIN");
        if (text.includes("SELECT rolsuper FROM pg_roles")) return { rows: [{ rolsuper }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
  };

  it("as a superuser, sets only transaction sampling on the session before the transaction begins", async () => {
    // The rest are scoped to each password statement (convergeRole, T11), so
    // the GRANTs and REVOKEs of the run stay logged.
    const c = fakeClient(true);
    await expect(runBootstrap(c, [], [])).rejects.toThrow("stop at BEGIN");
    const beforeBegin = c.statements.slice(0, c.statements.indexOf("BEGIN"));
    expect(beforeBegin.filter((s) => s.startsWith("SET "))).toEqual([
      `SET ${TRANSACTION_START_SETTING} = 0`,
    ]);
  });

  it("as a non-superuser (the RDS master), sends none of them — it may not set them", async () => {
    const c = fakeClient(false);
    await expect(runBootstrap(c, [], [])).rejects.toThrow("stop at BEGIN");
    expect(c.statements.filter((s) => s.startsWith("SET "))).toEqual([]);
  });
});
