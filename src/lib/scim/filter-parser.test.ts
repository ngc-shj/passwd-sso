import { describe, it, expect } from "vitest";
import {
  parseScimFilter,
  filterToPrismaWhere,
  extractExternalIdValue,
  hasAttribute,
  FilterParseError,
} from "./filter-parser";

describe("parseScimFilter", () => {
  it("parses simple eq filter", () => {
    const result = parseScimFilter('userName eq "test@example.com"');
    expect(result).toEqual({
      attr: "userName",
      op: "eq",
      value: "test@example.com",
    });
  });

  it("parses co (contains) filter", () => {
    const result = parseScimFilter('userName co "test"');
    expect(result).toEqual({
      attr: "userName",
      op: "co",
      value: "test",
    });
  });

  it("parses sw (starts with) filter", () => {
    const result = parseScimFilter('userName sw "admin"');
    expect(result).toEqual({
      attr: "userName",
      op: "sw",
      value: "admin",
    });
  });

  it("parses active boolean filter", () => {
    const result = parseScimFilter("active eq true");
    expect(result).toEqual({
      attr: "active",
      op: "eq",
      value: "true",
    });
  });

  it("parses and expression", () => {
    const result = parseScimFilter('userName eq "a" and active eq true');
    expect(result).toHaveProperty("and");
    const and = (result as { and: unknown[] }).and;
    expect(and).toHaveLength(2);
  });

  it("parses or expression", () => {
    const result = parseScimFilter('userName eq "a" or userName eq "b"');
    expect(result).toHaveProperty("or");
    const or = (result as { or: unknown[] }).or;
    expect(or).toHaveLength(2);
  });

  it("rejects mixed and/or connectives", () => {
    expect(() =>
      parseScimFilter('userName eq "a" and active eq true or userName eq "b"'),
    ).toThrow(FilterParseError);
    expect(() =>
      parseScimFilter('userName eq "a" and active eq true or userName eq "b"'),
    ).toThrow(/Mixing.*and.*or/);
  });

  it("rejects filter exceeding max length", () => {
    const longFilter = `userName eq "${"a".repeat(260)}"`;
    expect(() => parseScimFilter(longFilter)).toThrow(FilterParseError);
  });

  it("rejects unsupported attribute", () => {
    expect(() => parseScimFilter('name.givenName eq "John"')).toThrow(
      FilterParseError,
    );
  });

  it("rejects unknown attribute", () => {
    expect(() => parseScimFilter('emails eq "test"')).toThrow(
      FilterParseError,
    );
  });

  it("handles escaped quotes in string values", () => {
    const result = parseScimFilter('userName eq "test\\"user"');
    expect((result as { value: string }).value).toBe('test"user');
  });

  it("throws on unterminated string", () => {
    expect(() => parseScimFilter('userName eq "test')).toThrow(
      FilterParseError,
    );
  });

  it("throws on empty filter", () => {
    expect(() => parseScimFilter("")).toThrow(FilterParseError);
  });

  it("parses externalId eq filter", () => {
    const result = parseScimFilter('externalId eq "ext-123"');
    expect(result).toEqual({
      attr: "externalId",
      op: "eq",
      value: "ext-123",
    });
  });
});

describe("hasAttribute", () => {
  it("detects attribute in simple filter", () => {
    const ast = parseScimFilter("active eq true");
    expect(hasAttribute(ast, "active")).toBe(true);
    expect(hasAttribute(ast, "userName")).toBe(false);
  });

  it("detects attribute nested inside AND", () => {
    const ast = parseScimFilter('userName eq "test" and active eq false');
    expect(hasAttribute(ast, "active")).toBe(true);
    expect(hasAttribute(ast, "userName")).toBe(true);
    expect(hasAttribute(ast, "externalId")).toBe(false);
  });

  it("detects attribute nested inside OR", () => {
    const ast = parseScimFilter('active eq true or userName eq "test"');
    expect(hasAttribute(ast, "active")).toBe(true);
    expect(hasAttribute(ast, "userName")).toBe(true);
  });
});

describe("extractExternalIdValue", () => {
  it("returns value from simple externalId eq filter", () => {
    const ast = parseScimFilter('externalId eq "ext-123"');
    expect(extractExternalIdValue(ast)).toBe("ext-123");
  });

  it("returns null when no externalId filter", () => {
    const ast = parseScimFilter('userName eq "test@example.com"');
    expect(extractExternalIdValue(ast)).toBeNull();
  });

  it("finds externalId nested inside AND", () => {
    const ast = parseScimFilter('userName eq "test" and externalId eq "ext-456"');
    expect(extractExternalIdValue(ast)).toBe("ext-456");
  });

  it("finds externalId nested inside OR", () => {
    const ast = parseScimFilter('externalId eq "ext-789" or userName eq "test"');
    expect(extractExternalIdValue(ast)).toBe("ext-789");
  });

  it("returns null for active-only filter", () => {
    const ast = parseScimFilter("active eq true");
    expect(extractExternalIdValue(ast)).toBeNull();
  });
});

describe("filterToPrismaWhere", () => {
  it("converts userName eq to Prisma where with case-insensitive equals", () => {
    const ast = parseScimFilter('userName eq "test@example.com"');
    const where = filterToPrismaWhere(ast);
    expect(where).toEqual({
      user: { is: { email: { equals: "test@example.com", mode: "insensitive" } } },
    });
  });

  it("converts userName co to Prisma where with case-insensitive contains", () => {
    const ast = parseScimFilter('userName co "test"');
    const where = filterToPrismaWhere(ast);
    expect(where).toEqual({
      user: { is: { email: { contains: "test", mode: "insensitive" } } },
    });
  });

  it("converts userName sw to Prisma where with case-insensitive startsWith", () => {
    const ast = parseScimFilter('userName sw "admin"');
    const where = filterToPrismaWhere(ast);
    expect(where).toEqual({
      user: { is: { email: { startsWith: "admin", mode: "insensitive" } } },
    });
  });

  it("converts active eq true to deactivatedAt: null", () => {
    const ast = parseScimFilter("active eq true");
    const where = filterToPrismaWhere(ast);
    expect(where).toEqual({ deactivatedAt: null });
  });

  it("converts active eq false to deactivatedAt: { not: null }", () => {
    const ast = parseScimFilter("active eq false");
    const where = filterToPrismaWhere(ast);
    expect(where).toEqual({ deactivatedAt: { not: null } });
  });

  it("converts and to AND", () => {
    const ast = parseScimFilter('userName eq "test" and active eq true');
    const where = filterToPrismaWhere(ast);
    expect(where).toHaveProperty("AND");
  });

  it("converts externalId eq to empty object (resolved by caller)", () => {
    const ast = parseScimFilter('externalId eq "ext-1"');
    const where = filterToPrismaWhere(ast);
    expect(where).toEqual({});
  });

  it("rejects non-eq operator on externalId", () => {
    const ast = parseScimFilter('externalId co "ext"');
    expect(() => filterToPrismaWhere(ast)).toThrow(FilterParseError);
  });
});
