import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { mapPrismaError } from "@/lib/prisma/prisma-error";
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
