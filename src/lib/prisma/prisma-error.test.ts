import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { mapPrismaError, pgConstraintName, pgErrorCode } from "@/lib/prisma/prisma-error";
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

describe("pgConstraintName", () => {
  /**
   * These fixtures are the shapes MEASURED against this repo's own CHECKs on a
   * real database (a probe raising `users_not_system_tenant` through
   * `user.create` and `teams_not_system_tenant` through `$executeRawUnsafe`),
   * not shapes invented to satisfy the parser. Three of those measurements
   * decide the implementation and so belong in the fixtures:
   *
   *   - the ORM path surfaces as **P2039**, the raw path as **P2010**, while
   *     both nest the driver error identically — a reader keyed on P2010 would
   *     miss every ORM write;
   *   - the cause carries `originalCode`, `originalMessage`, `kind`, `code`,
   *     `severity`, `message` and `detail` — and NO `constraint` field, which
   *     is why the name has to be parsed at all;
   *   - `err.message` renders the text as well, so it survives a change of
   *     nesting.
   */
  const CHECK_MESSAGE =
    'new row for relation "users" violates check constraint "users_not_system_tenant"';

  function ormShape(): Error {
    return Object.assign(
      new Error(
        "\nInvalid `tx.user.create()` invocation\n\n" +
          "Database error. Code: `23514`. Message: `" + CHECK_MESSAGE + "`",
      ),
      {
        code: "P2039",
        meta: {
          modelName: "User",
          driverAdapterError: {
            name: "DriverAdapterError",
            message: CHECK_MESSAGE,
            cause: {
              originalCode: "23514",
              originalMessage: CHECK_MESSAGE,
              kind: "postgres",
              code: "23514",
              severity: "ERROR",
              detail: "Failing row contains (…).",
              message: CHECK_MESSAGE,
            },
          },
        },
      },
    );
  }

  it("reads the name from the ORM path's P2039 nesting", () => {
    expect(pgConstraintName(ormShape())).toBe("users_not_system_tenant");
  });

  it("reads the name from the raw path's P2010 nesting", () => {
    const message =
      'new row for relation "teams" violates check constraint "teams_not_system_tenant"';
    const err = Object.assign(new Error("Raw query failed."), {
      code: "P2010",
      meta: {
        driverAdapterError: {
          message,
          cause: { code: "23514", originalMessage: message, message },
        },
      },
    });
    expect(pgConstraintName(err)).toBe("teams_not_system_tenant");
  });

  it("falls back to the rendered message when the adapter nesting is absent", () => {
    // The step that survives an adapter that changes its shape.
    expect(
      pgConstraintName(new Error("Database error. Code: `23514`. Message: `" + CHECK_MESSAGE + "`")),
    ).toBe("users_not_system_tenant");
  });

  it("reads constraint kinds other than CHECK", () => {
    // Not scoped to CHECK by construction; the caller decides which SQLSTATEs
    // it cares about. A parser that only matched "check constraint" would
    // silently return null for the unique and FK cases a later caller wants.
    expect(
      pgConstraintName(
        new Error('duplicate key value violates unique constraint "users_email_key"'),
      ),
    ).toBe("users_email_key");
  });

  it("returns null when no constraint is named", () => {
    expect(pgConstraintName(new Error("could not serialize access"))).toBeNull();
  });

  it.each([null, undefined, "string error", 42])(
    "returns null for the non-object input %s",
    (input) => {
      expect(pgConstraintName(input)).toBeNull();
    },
  );

  it("returns null when the message is localised past the keyword", () => {
    // The stated limit, pinned so it is a known property rather than a
    // surprise: PostgreSQL localises its messages, so on a server with a
    // non-English `lc_messages` the name is present and unreadable. Callers
    // must have an explicit "could not extract" arm; treating null as "some
    // other constraint" would be the fail-open.
    const localised = new Error(
      'リレーション"users"の新しい行はチェック制約"users_not_system_tenant"に違反しています',
    );
    expect(pgConstraintName(localised)).toBeNull();
  });
});
