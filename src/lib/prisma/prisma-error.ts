import { Prisma } from "@prisma/client";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";

interface PrismaErrorMapping {
  status: number;
  code: ApiErrorCode;
}

/**
 * The PostgreSQL SQLSTATE carried by an error, or null when there is none.
 *
 * Prisma surfaces a driver-level error in three different shapes depending on
 * where it was raised, and a check that reads only one of them silently
 * classifies the other two as "unknown error". The shapes:
 *   1. Direct PG error:                 err.code === "42P01"
 *   2. Prisma P2010 (raw query failed): err.meta.code === "42P01"
 *   3. Prisma wrapped:                  err.cause.code === "42P01"
 *
 * `isLockTimeoutError` in src/lib/auth/policy/account-lockout.ts predates this
 * and still carries its own copy of the same unwrap for 55P03.
 */
export function pgErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;

  const code = "code" in err ? (err as { code: unknown }).code : undefined;
  if (typeof code === "string" && code !== "P2010") return code;

  // P2010 wraps the driver error's SQLSTATE in meta.code.
  if (code === "P2010" && "meta" in err && err.meta && typeof err.meta === "object") {
    const metaCode = (err.meta as { code?: unknown }).code;
    if (typeof metaCode === "string") return metaCode;
  }

  if ("cause" in err && err.cause && typeof err.cause === "object") {
    const causeCode = (err.cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }

  return null;
}

/**
 * Maps Prisma-specific errors to API status codes and error codes.
 * Returns null for errors that are not Prisma errors (caller handles them).
 */
export function mapPrismaError(error: unknown): PrismaErrorMapping | null {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return { status: 503, code: API_ERROR.SERVICE_UNAVAILABLE };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2002": // unique constraint violation
      case "P2003": // foreign key constraint violation
        return { status: 409, code: API_ERROR.CONFLICT };
      case "P2025":
        return { status: 404, code: API_ERROR.NOT_FOUND };
      default:
        return null;
    }
  }
  return null;
}
