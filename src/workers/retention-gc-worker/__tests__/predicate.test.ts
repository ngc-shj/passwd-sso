import { describe, it, expect } from "vitest";
import { renderPredicate, assertIdentifier } from "../predicate";

describe("assertIdentifier", () => {
  it("accepts valid lowercase-plus-underscore identifiers", () => {
    expect(() => assertIdentifier("expires_at")).not.toThrow();
    expect(() => assertIdentifier("tenant_id")).not.toThrow();
    expect(() => assertIdentifier("id")).not.toThrow();
    expect(() => assertIdentifier("is_dcr")).not.toThrow();
    expect(() => assertIdentifier("dcr_expires_at")).not.toThrow();
  });

  it("throws on a semicolon injection attempt", () => {
    expect(() => assertIdentifier("foo; DROP")).toThrow(/unsafe identifier rejected/);
  });

  it("throws on uppercase letters", () => {
    expect(() => assertIdentifier("Foo")).toThrow(/unsafe identifier rejected/);
    expect(() => assertIdentifier("FOO")).toThrow(/unsafe identifier rejected/);
  });

  it("throws on hyphens", () => {
    expect(() => assertIdentifier("a-b")).toThrow(/unsafe identifier rejected/);
  });

  it("throws on digits", () => {
    expect(() => assertIdentifier("col1")).toThrow(/unsafe identifier rejected/);
  });

  it("throws on spaces", () => {
    expect(() => assertIdentifier("foo bar")).toThrow(/unsafe identifier rejected/);
  });

  it("throws on empty string", () => {
    expect(() => assertIdentifier("")).toThrow(/unsafe identifier rejected/);
  });
});

describe("renderPredicate", () => {
  it("renders the DCR predicate exactly as expected (S1/C1/INV-C1c)", () => {
    const result = renderPredicate([
      { column: "is_dcr", op: "=", value: true },
      { column: "tenant_id", op: "IS NULL" },
    ]);
    expect(result).toBe("is_dcr = true AND tenant_id IS NULL");
  });

  it("renders IS NOT NULL clause", () => {
    const result = renderPredicate([
      { column: "tenant_id", op: "IS NOT NULL" },
    ]);
    expect(result).toBe("tenant_id IS NOT NULL");
  });

  it("renders value false as SQL literal false, not a string", () => {
    const result = renderPredicate([{ column: "is_dcr", op: "=", value: false }]);
    expect(result).toBe("is_dcr = false");
  });

  it("renders multiple clauses AND-joined in order", () => {
    const result = renderPredicate([
      { column: "is_dcr", op: "=", value: true },
      { column: "tenant_id", op: "IS NULL" },
      { column: "expires_at", op: "IS NOT NULL" },
    ]);
    expect(result).toBe("is_dcr = true AND tenant_id IS NULL AND expires_at IS NOT NULL");
  });

  it("throws when a clause column contains a malicious identifier", () => {
    expect(() =>
      renderPredicate([{ column: "foo; DROP TABLE mcp_clients--", op: "IS NULL" }]),
    ).toThrow(/unsafe identifier rejected/);
  });

  it("throws when a clause column has uppercase letters", () => {
    expect(() =>
      renderPredicate([{ column: "IsDcr", op: "IS NULL" }]),
    ).toThrow(/unsafe identifier rejected/);
  });
});
