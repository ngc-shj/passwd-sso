import { describe, it, expect } from "vitest";
import { renderPredicate } from "../predicate";
import { sqlIdentifier, renderSql } from "@/lib/prisma/raw-sql";

describe("sqlIdentifier", () => {
  it("accepts valid lowercase-plus-underscore identifiers", () => {
    expect(() => sqlIdentifier("expires_at")).not.toThrow();
    expect(() => sqlIdentifier("tenant_id")).not.toThrow();
    expect(() => sqlIdentifier("id")).not.toThrow();
    expect(() => sqlIdentifier("is_dcr")).not.toThrow();
    expect(() => sqlIdentifier("dcr_expires_at")).not.toThrow();
  });

  it("throws on a semicolon injection attempt", () => {
    expect(() => sqlIdentifier("foo; DROP")).toThrow(/must match/);
  });

  it("throws on uppercase letters", () => {
    expect(() => sqlIdentifier("Foo")).toThrow(/must match/);
    expect(() => sqlIdentifier("FOO")).toThrow(/must match/);
  });

  it("throws on hyphens", () => {
    expect(() => sqlIdentifier("a-b")).toThrow(/must match/);
  });

  it("throws on digits", () => {
    expect(() => sqlIdentifier("col1")).toThrow(/must match/);
  });

  it("throws on spaces", () => {
    expect(() => sqlIdentifier("foo bar")).toThrow(/must match/);
  });

  it("throws on empty string", () => {
    expect(() => sqlIdentifier("")).toThrow(/must match/);
  });
});

describe("renderPredicate", () => {
  it("renders the DCR predicate exactly as expected (S1/C1/INV-C1c)", () => {
    const result = renderSql(renderPredicate([
      { column: "is_dcr", op: "=", value: true },
      { column: "tenant_id", op: "IS NULL" },
    ]));
    expect(result).toBe("is_dcr = true AND tenant_id IS NULL");
  });

  it("renders IS NOT NULL clause", () => {
    const result = renderSql(renderPredicate([
      { column: "tenant_id", op: "IS NOT NULL" },
    ]));
    expect(result).toBe("tenant_id IS NOT NULL");
  });

  it("renders value false as SQL literal false, not a string", () => {
    const result = renderSql(renderPredicate([{ column: "is_dcr", op: "=", value: false }]));
    expect(result).toBe("is_dcr = false");
  });

  it("renders multiple clauses AND-joined in order", () => {
    const result = renderSql(renderPredicate([
      { column: "is_dcr", op: "=", value: true },
      { column: "tenant_id", op: "IS NULL" },
      { column: "expires_at", op: "IS NOT NULL" },
    ]));
    expect(result).toBe("is_dcr = true AND tenant_id IS NULL AND expires_at IS NOT NULL");
  });

  it("throws when a clause column contains a malicious identifier", () => {
    expect(() =>
      renderPredicate([{ column: "foo; DROP TABLE mcp_clients--", op: "IS NULL" }]),
    ).toThrow(/must match/);
  });

  it("throws when a clause column has uppercase letters", () => {
    expect(() =>
      renderPredicate([{ column: "IsDcr", op: "IS NULL" }]),
    ).toThrow(/must match/);
  });
});
