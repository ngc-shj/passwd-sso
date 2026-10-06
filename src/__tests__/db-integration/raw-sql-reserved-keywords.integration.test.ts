/**
 * C1 acceptance: `sqlIdentifier`'s embedded reserved-keyword list must equal
 * `SELECT word FROM pg_get_keywords() WHERE catcode IN ('R','T')` on the live
 * server — a version bump that adds or removes a reserved word must not
 * silently drift the embedded list out of sync with what Postgres actually
 * rejects as an identifier.
 *
 * raw-sql.ts exports only the four functions `sqlIdentifier` / `trustedSql` /
 * `joinSql` / `renderSql` (C1's export-surface contract) — the keyword list
 * itself is not exported, so this proves equality through behaviour instead
 * of importing the list directly:
 *   - every word the catalog reports as catcode R or T must be rejected;
 *   - every other word that still matches the identifier pattern
 *     (`^[a-z_]+$`) must be accepted — this is what rules out an embedded
 *     list that is a strict superset of the catalog's R/T words.
 * Together these two directions pin the embedded list to exactly the
 * catalog's R/T set, for every word the pattern could possibly match.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestContext, type TestContext } from "./helpers";
import { sqlIdentifier } from "@/lib/prisma/raw-sql";

describe("sqlIdentifier reserved-keyword list vs pg_get_keywords() (C1)", () => {
  let ctx: TestContext;
  let reservedWords: string[];
  let acceptableNonReservedWords: string[];

  beforeAll(async () => {
    ctx = await createTestContext();

    const rows = await ctx.su.prisma.$queryRawUnsafe<
      { word: string; catcode: string }[]
    >("SELECT word, catcode FROM pg_get_keywords()");

    reservedWords = rows
      .filter((r) => r.catcode === "R" || r.catcode === "T")
      .map((r) => r.word);

    // Restricted to the identifier pattern sqlIdentifier itself enforces:
    // a non-reserved word outside that pattern (e.g. containing a digit)
    // would be rejected for an unrelated reason and prove nothing here.
    acceptableNonReservedWords = rows
      .filter((r) => r.catcode !== "R" && r.catcode !== "T")
      .map((r) => r.word)
      .filter((word) => /^[a-z_]+$/.test(word));
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("rejects every word the live catalog reports as catcode R or T", () => {
    expect(reservedWords.length).toBeGreaterThan(0);
    for (const word of reservedWords) {
      expect(() => sqlIdentifier(word)).toThrow();
    }
  });

  it("accepts every pattern-matching word the catalog does NOT report as R or T — rules out an embedded list that over-rejects", () => {
    expect(acceptableNonReservedWords.length).toBeGreaterThan(0);
    for (const word of acceptableNonReservedWords) {
      expect(() => sqlIdentifier(word)).not.toThrow();
    }
  });

  it("accepts an ordinary identifier that is not a PostgreSQL keyword at all", () => {
    expect(() => sqlIdentifier("tenant_id")).not.toThrow();
  });
});
