import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  normalizeTenantClaim,
  storableClaimSchema,
  operatorDomainSchema,
  NON_PRINTABLE_ASCII_SQL_CLASS,
  EXTERNAL_ID_FOLD_SQL,
} from "./tenant-claim-registry";

// No module mocking (RT5) — every assertion below exercises the real
// normaliser and the real schemas.

describe("normalizeTenantClaim", () => {
  it("strips leading/trailing whitespace", () => {
    expect(normalizeTenantClaim("  alias.example  ")).toBe("alias.example");
  });

  it("folds mixed case", () => {
    expect(normalizeTenantClaim("Alias.Example")).toBe("alias.example");
  });

  it("leaves an already-normalised input unchanged", () => {
    expect(normalizeTenantClaim("alias.example")).toBe("alias.example");
  });

  it("changes at least one adversarial input — fails if the function degenerates to identity", () => {
    const inputs = [" Alias.Example ", "ACMECORP", "  primary.example"];
    expect(inputs.some((v) => normalizeTenantClaim(v) !== v)).toBe(true);
  });

  it("output always satisfies the C1 CHECK predicate (v === lower(trim(v)))", () => {
    // Adversarial table: full-width and non-ASCII characters included.
    // normalizeTenantClaim's postcondition (v === v.trim().toLowerCase())
    // holds unconditionally — it is a tautology of the function's own
    // definition. What is NOT unconditional is storability: a non-ASCII
    // result must be rejected by storableClaimSchema (SC9's narrowing),
    // not expected to round-trip through the CHECK.
    const adversarial = [
      "Alias.Example",
      "  alias.example  ",
      "ACMECORP",
      "café.example", // non-ASCII (é)
      "全角.example", // full-width / CJK
      "ß.example", // ß — case-folding hazard under some engines
      "İ.example", // dotted capital I — SC9's D3 example
    ];

    for (const input of adversarial) {
      const normalized = normalizeTenantClaim(input);
      expect(normalized).toBe(normalized.trim().toLowerCase());

      const isAscii = /^[\x20-\x7E]+$/.test(normalized);
      if (isAscii) {
        expect(storableClaimSchema.safeParse(normalized).success).toBe(true);
      } else {
        // SC9: non-ASCII normalised forms are rejected at the storage
        // boundary, not stored unresolvably.
        expect(storableClaimSchema.safeParse(normalized).success).toBe(false);
      }
    }
  });
});

describe("storableClaimSchema", () => {
  it.each(["acmecorp", "alias.example", "a".repeat(255)])(
    "accepts %s",
    (value) => {
      expect(storableClaimSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    ["empty string", ""],
    ["whitespace-only", "   "],
    ["256 characters", "a".repeat(256)],
    ["non-ASCII value", "café.example"],
    ["un-normalised value", "Alias.Example"],
  ])("rejects %s", (_label, value) => {
    expect(storableClaimSchema.safeParse(value).success).toBe(false);
  });
});

describe("operatorDomainSchema", () => {
  it("accepts alias.example", () => {
    expect(operatorDomainSchema.safeParse("alias.example").success).toBe(true);
  });

  it.each([
    ["no dot", "acmecorp"],
    ["leading whitespace", " alias.example"],
    ["path suffix", "alias.example/path"],
    ["scheme prefix", "https://alias.example"],
    ["empty label", "alias..example"],
    ["trailing dot", "alias.example."],
  ])("rejects %s", (_label, value) => {
    expect(operatorDomainSchema.safeParse(value).success).toBe(false);
  });
});

describe("NON_PRINTABLE_ASCII_SQL_CLASS drift guard", () => {
  // The C1 CHECK constraint is the authority for what a storable claim looks
  // like. Three other places restate that predicate: the backfill's WHERE
  // clause, its extracted copy, and (via a bound parameter) the operator
  // pre-flight report. The pre-flight one is the dangerous one — it exists to
  // tell an operator which rows the CHECK will reject BEFORE they migrate, so
  // a stale copy produces a confidently wrong "all clear". These assertions
  // fail the moment the SQL and the constant diverge.
  const repoRoot = resolve(__dirname, "../../..");
  const read = (rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

  const MIGRATION = "prisma/migrations/20260729110000_add_tenant_claims/migration.sql";
  const BACKFILL = "scripts/lib/tenant-claim-backfill.sql";

  it("is the predicate the CHECK constraint enforces", () => {
    expect(read(MIGRATION)).toContain(`claim !~ '${NON_PRINTABLE_ASCII_SQL_CLASS}'`);
  });

  it("is the predicate the backfill filters the raw external_id on", () => {
    // Raw column, not the folded output — round-5 D3.
    expect(read(BACKFILL)).toContain(`external_id !~ '${NON_PRINTABLE_ASCII_SQL_CLASS}'`);
    expect(read(MIGRATION)).toContain(`external_id !~ '${NON_PRINTABLE_ASCII_SQL_CLASS}'`);
  });

  /**
   * Round-3 F11. The ASCII predicate above was enumerated and pinned; the FOLD
   * expression next to it in the same statements was not, and it had five
   * copies. The unguarded one — `findFoldedExternalIdOwner` — is the one that
   * decides whether a sign-in may create a tenant, so a divergence there would
   * disagree with `preflight`, the report an operator runs to predict exactly
   * that decision, while both looked correct in isolation.
   */
  const FOLD_COPIES: ReadonlyArray<{ file: string; occurrences: number; why: string }> = [
    { file: MIGRATION, occurrences: 3, why: "the backfill's SELECT and its two-sided collision exclusion" },
    { file: BACKFILL, occurrences: 3, why: "the extracted twin of the same statement" },
    { file: "scripts/tenant-domain.ts", occurrences: 2, why: "preflight's collision and fold-mismatch queries" },
    { file: "src/lib/tenant/tenant-management.ts", occurrences: 1, why: "findFoldedExternalIdOwner (the copy F11 found unguarded)" },
  ];

  it.each(FOLD_COPIES)("$file spells the fold exactly, $occurrences time(s) — $why", ({ file, occurrences }) => {
    const text = read(file);
    const spelled = text.split(EXTERNAL_ID_FOLD_SQL).length - 1;
    expect(spelled).toBe(occurrences);
  });

  it("no copy folds external_id without the C collation", () => {
    // The failure this catches is invisible on an en_US database and appears
    // only where LC_CTYPE differs, i.e. on someone else's deployment. Matches
    // any `lower(...external_id...)` that is not the canonical spelling.
    const UNCOLLATED = /lower\s*\(\s*btrim\s*\(\s*external_id\s*\)\s*\)/;
    for (const { file } of FOLD_COPIES) {
      expect(UNCOLLATED.test(read(file)), `${file} folds external_id without COLLATE "C"`).toBe(false);
    }
  });

  it("agrees with the JS predicate storableClaimSchema applies", () => {
    // Behavioural cross-check: the SQL class and the JS regex must classify
    // the same values the same way, or a claim can pass one engine and fail
    // the other — the exact split round-5 D3 was raised about.
    const sqlClassRe = new RegExp(NON_PRINTABLE_ASCII_SQL_CLASS);
    for (const value of ["alias.example", "acmecorp", "a-b_c~1", "\u00e0bc", "\u0130stanbul", "\u3042"]) {
      const rejectedBySql = sqlClassRe.test(value);
      const rejectedByJs = !storableClaimSchema.safeParse(value).success;
      expect(rejectedByJs).toBe(rejectedBySql);
    }
  });
});
