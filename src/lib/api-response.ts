import { NextResponse } from "next/server";
import { API_ERROR, type ApiErrorCode } from "@/lib/api-error-codes";
import { mapPrismaError } from "@/lib/prisma-error";

/**
 * Create a standardized error response.
 *
 * Replaces direct `NextResponse.json({ error: ... }, { status })` calls
 * with a single helper that enforces consistent error shape.
 */
export function errorResponse(
  code: ApiErrorCode,
  status: number,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    details ? { error: code, ...details } : { error: code },
    { status },
  );
}

// ── Common presets ──────────────────────────────────────────────

export const unauthorized = () =>
  errorResponse(API_ERROR.UNAUTHORIZED, 401);

export const notFound = () =>
  errorResponse(API_ERROR.NOT_FOUND, 404);

export const forbidden = () =>
  errorResponse(API_ERROR.FORBIDDEN, 403);

export const validationError = (details: unknown) =>
  errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
    details,
  });

/**
 * Convert a Prisma error to a standardized NextResponse.
 * Returns null if the error is not a recognized Prisma error,
 * so the caller can handle it as an unexpected error.
 */
export function prismaErrorResponse(error: unknown): NextResponse | null {
  const mapped = mapPrismaError(error);
  if (!mapped) return null;
  return errorResponse(mapped.code, mapped.status);
}
