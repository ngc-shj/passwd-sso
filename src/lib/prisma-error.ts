import { Prisma } from "@prisma/client";
import { API_ERROR, type ApiErrorCode } from "@/lib/api-error-codes";

interface PrismaErrorMapping {
  status: number;
  code: ApiErrorCode;
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
