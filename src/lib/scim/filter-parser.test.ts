import { describe, it, expect } from "vitest";
import {
  parseScimFilter,
  filterToPrismaWhere,
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

describe("filterToPrismaWhere", () => {
  it("converts userName eq to Prisma where", () => {
    const ast = parseScimFilter('userName eq "test@example.com"');
    const where = filterToPrismaWhere(ast);
    expect(where).toEqual({
      user: { is: { email: "test@example.com" } },
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
});
