import { Prisma } from "@prisma/client";

function targetContainsTableName(target: unknown): boolean {
  if (typeof target === "string") {
    return target === "scim_external_mappings";
  }
  if (Array.isArray(target)) {
    return target.includes("scim_external_mappings");
  }
  return false;
}

export function isScimExternalMappingUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (error.code !== "P2002") {
    return false;
  }
  return (
    error.meta?.modelName === "ScimExternalMapping" ||
    targetContainsTableName(error.meta?.target)
  );
}
