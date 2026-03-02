import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { isScimExternalMappingUniqueViolation } from "@/lib/scim/prisma-error";

describe("isScimExternalMappingUniqueViolation", () => {
  it("returns false for non-Prisma errors", () => {
    expect(isScimExternalMappingUniqueViolation(new Error("nope"))).toBe(false);
  });

  it("returns false for a different Prisma error code", () => {
    const error = new Prisma.PrismaClientKnownRequestError("bad", {
      code: "P2025",
      clientVersion: "test",
    });

    expect(isScimExternalMappingUniqueViolation(error)).toBe(false);
  });

  it("returns true when modelName matches ScimExternalMapping", () => {
    const error = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test",
      meta: { modelName: "ScimExternalMapping" },
    });

    expect(isScimExternalMappingUniqueViolation(error)).toBe(true);
  });

  it("returns true when target contains the backing table name", () => {
    const stringTarget = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: "scim_external_mappings" },
    });
    const arrayTarget = new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["tenant_id", "scim_external_mappings"] },
    });

    expect(isScimExternalMappingUniqueViolation(stringTarget)).toBe(true);
    expect(isScimExternalMappingUniqueViolation(arrayTarget)).toBe(true);
  });
});
