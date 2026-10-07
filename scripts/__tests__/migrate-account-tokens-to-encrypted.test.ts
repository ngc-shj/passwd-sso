/**
 * Step 0 characterization (raw-sql-ident-branded-type plan, Testing strategy):
 * pins the exact SQL text `buildAccountsSelectSql` / `buildAccountUpdateSql`
 * produce today, BEFORE either is migrated off string interpolation (C2).
 * The expected strings here must not change when that migration lands — only
 * the production call site (`renderSql(...)`) may change (NF1).
 *
 * Importing the module does not touch the database: the CLI guard
 * (`process.argv[1] && import.meta.url === pathToFileURL(...).href`, the
 * same pattern as scripts/tenant-domain.ts) keeps `main()` from running on
 * import, and MIGRATION_DATABASE_URL is read only inside `main()`.
 */
import { describe, it, expect } from "vitest";
import {
  buildAccountsSelectSql,
  buildAccountUpdateSql,
} from "../migrate-account-tokens-to-encrypted";
import { renderSql } from "@/lib/prisma/raw-sql";

// Built from parts (rather than a literal multi-line template) because the
// no-cursor case's blank line is NOT empty — it carries the 9-space indent
// the WHERE clause would otherwise occupy, which an editor's trailing-
// whitespace trim would silently eat out of a literal. See
// buildAccountsSelectSql's own `${hasCursor ? "WHERE id > $1::uuid" : ""}`
// line.
function expectedSelectSql(whereClause: string, limit: number): string {
  return [
    `SELECT id, user_id AS "userId", provider,`,
    `                provider_account_id AS "providerAccountId",`,
    `                refresh_token, access_token, id_token`,
    `         FROM accounts`,
    `         ${whereClause}`,
    `         ORDER BY id ASC`,
    `         LIMIT ${limit}`,
  ].join("\n");
}

describe("buildAccountsSelectSql", () => {
  it("omits the WHERE clause on the first page (no cursor)", () => {
    expect(renderSql(buildAccountsSelectSql(false, 500))).toBe(expectedSelectSql("", 500));
  });

  it("adds the keyset WHERE clause once a cursor is set", () => {
    expect(renderSql(buildAccountsSelectSql(true, 500))).toBe(
      expectedSelectSql("WHERE id > $1::uuid", 500),
    );
  });

  it("interpolates batchSize into LIMIT", () => {
    expect(renderSql(buildAccountsSelectSql(false, 42))).toContain("LIMIT 42");
  });
});

describe("buildAccountUpdateSql", () => {
  it("builds the SET clause for a single column", () => {
    expect(renderSql(buildAccountUpdateSql(["refresh_token"]))).toBe(
      `UPDATE accounts SET "refresh_token" = $1 WHERE id = $2::uuid`,
    );
  });

  it("builds the SET clause for two columns", () => {
    expect(renderSql(buildAccountUpdateSql(["refresh_token", "access_token"]))).toBe(
      `UPDATE accounts SET "refresh_token" = $1, "access_token" = $2 WHERE id = $3::uuid`,
    );
  });

  it("builds the SET clause for all three columns", () => {
    expect(
      renderSql(buildAccountUpdateSql(["refresh_token", "access_token", "id_token"])),
    ).toBe(
      `UPDATE accounts SET "refresh_token" = $1, "access_token" = $2, "id_token" = $3 WHERE id = $4::uuid`,
    );
  });
});
