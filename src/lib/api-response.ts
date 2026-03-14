import { NextResponse } from "next/server";
import { API_ERROR, type ApiErrorCode } from "@/lib/api-error-codes";

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
