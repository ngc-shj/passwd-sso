import { NextResponse } from "next/server";
import { z, type ZodError } from "zod";
import { API_ERROR, type ApiErrorCode } from "@/lib/api-error-codes";
import { mapPrismaError } from "@/lib/prisma-error";

// Avoid importing TeamAuthError/TenantAuthError directly to prevent circular
// dependencies — both classes share the same { message: ApiErrorCode, status: number }
// shape, so duck-typing is sufficient here.
interface AuthErrorShape {
  message: ApiErrorCode;
  status: number;
}

function isAuthError(e: unknown): e is AuthErrorShape {
  if (!(e instanceof Error)) return false;
  const name = (e as Error).name;
  if (name !== "TeamAuthError" && name !== "TenantAuthError") return false;
  return typeof (e as unknown as Record<string, unknown>).status === "number";
}

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
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(
    details ? { error: code, ...details } : { error: code },
    { status, headers },
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

export const zodValidationError = (error: ZodError) =>
  validationError(z.treeifyError(error));

export const rateLimited = (retryAfterMs?: number) => {
  const headers: Record<string, string> = {};
  if (retryAfterMs != null && retryAfterMs > 0) {
    headers["Retry-After"] = String(Math.ceil(retryAfterMs / 1000));
  }
  return errorResponse(API_ERROR.RATE_LIMIT_EXCEEDED, 429, undefined, headers);
};

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

/**
 * Handle TeamAuthError or TenantAuthError in route catch blocks.
 * Returns an error response if the error is an auth error, otherwise re-throws.
 *
 * Usage:
 *   } catch (e) {
 *     return handleAuthError(e);
 *   }
 */
export function handleAuthError(e: unknown): NextResponse {
  if (isAuthError(e)) {
    return errorResponse(e.message, e.status);
  }
  throw e;
}
