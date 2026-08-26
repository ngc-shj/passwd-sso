import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { mapPrismaError, pgErrorCode } from "@/lib/prisma/prisma-error";
import { API_ERROR } from "@/lib/http/api-error-codes";

describe("mapPrismaError", () => {
  it.each([
    ["P2002", 409, API_ERROR.CONFLICT],
    ["P2003", 409, API_ERROR.CONFLICT],
    ["P2025", 404, API_ERROR.NOT_FOUND],
  ] as const)(
    "maps Prisma code %s to status %d and code %s",
    (prismaCode, expectedStatus, expectedCode) => {
      const error = new Prisma.PrismaClientKnownRequestError("test", {
        code: prismaCode,
        clientVersion: "test",
      });
      const result = mapPrismaError(error);
      expect(result).not.toBeNull();
      expect(result!.status).toBe(expectedStatus);
      expect(result!.code).toBe(expectedCode);
    },
  );

  it("maps PrismaClientInitializationError to 503 SERVICE_UNAVAILABLE", () => {
    const error = new Prisma.PrismaClientInitializationError(
      "connection refused",
      "test",
    );
    const result = mapPrismaError(error);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(503);
    expect(result!.code).toBe(API_ERROR.SERVICE_UNAVAILABLE);
  });

  it("returns null for unknown Prisma known request error codes", () => {
    const error = new Prisma.PrismaClientKnownRequestError("test", {
      code: "P2001",
      clientVersion: "test",
    });
    const result = mapPrismaError(error);
    expect(result).toBeNull();
  });

  it("returns null for a plain Error", () => {
    const result = mapPrismaError(new Error("generic error"));
    expect(result).toBeNull();
  });

  it("returns null for non-Error values", () => {
    expect(mapPrismaError("string error")).toBeNull();
    expect(mapPrismaError(null)).toBeNull();
    expect(mapPrismaError(undefined)).toBeNull();
    expect(mapPrismaError(42)).toBeNull();
  });
});

describe("pgErrorCode", () => {
  /**
   * The shape the pg driver adapter actually produces, measured against a real
   * database in src/__tests__/db-integration/ and pinned by fixture in
   * helpers.test.ts. It is first here because it is the one the original
   * implementation could not read: the SQLSTATE sits under
   * meta.driverAdapterError.cause.code, so a parser that stopped at meta.code
   * returned null and the caller reclassified a known error as unknown.
   */
  function adapterError(sqlstate: string): Error {
    return Object.assign(
      new Error("\nInvalid `prisma.$executeRaw()` invocation:\n\nRaw query failed."),
      { code: "P2010", meta: { driverAdapterError: { cause: { code: sqlstate } } } },
    );
  }

  it.each([
    [
      "the pg adapter's nested shape",
      (s: string) => adapterError(s),
    ],
    [
      "P2010 with a flat meta.code",
      (s: string) =>
        Object.assign(new Error("Raw query failed"), { code: "P2010", meta: { code: s } }),
    ],
    [
      "a direct pg error",
      (s: string) => Object.assign(new Error("boom"), { code: s }),
    ],
    [
      "a Prisma-wrapped driver error on cause",
      (s: string) =>
        Object.assign(new Error("boom"), { code: "P2028", cause: { code: s } }),
    ],
    [
      "a SQLSTATE rendered into the message",
      (s: string) => new Error(`Raw query failed. Code: \`${s}\`. Message: \`x\``),
    ],
  ])("reads the SQLSTATE from %s", (_label, build) => {
    expect(pgErrorCode(build("42P01"))).toBe("42P01");
  });

  // The overlap that makes the ordering load-bearing rather than arbitrary.
  // Prisma numbers its errors P1000-P6xxx and PostgreSQL has a real class P0,
  // so both are [0-9A-Z]{5} and a length test hands back the wrapper.
  it("does not mistake a Prisma wrapper code for a SQLSTATE", () => {
    expect(pgErrorCode(Object.assign(new Error("x"), { code: "P2028" }))).toBeNull();
  });

  it("reads SQLSTATE class P0, which is a real driver code despite its P prefix", () => {
    expect(pgErrorCode(Object.assign(new Error("x"), { code: "P0001" }))).toBe("P0001");
  });

  // Tie: an error carrying both nestings. The nested adapter value wins,
  // matching the order sqlStateOf established against a real database.
  it("prefers the adapter's nested code when both nestings are present", () => {
    const err = Object.assign(new Error("Raw query failed"), {
      code: "P2010",
      meta: { driverAdapterError: { cause: { code: "40001" } }, code: "23503" },
    });
    expect(pgErrorCode(err)).toBe("40001");
  });

  it("returns null when no SQLSTATE is present anywhere", () => {
    expect(pgErrorCode(new Error("connection refused"))).toBeNull();
  });

  it.each([null, undefined, "string error", 42])(
    "returns null for the non-object input %s",
    (input) => {
      expect(pgErrorCode(input)).toBeNull();
    },
  );
});
