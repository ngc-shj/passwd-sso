import { NextResponse } from "next/server";
import { z, type ZodError } from "zod";
import {
  API_ERROR,
  API_ERROR_STATUS,
  type ApiErrorCode,
} from "@/lib/http/api-error-codes";
import { mapPrismaError } from "@/lib/prisma/prisma-error";
import { MS_PER_SECOND } from "@/lib/constants/time";

/**
 * Canonical wire shape of the Main API error envelope.
 *
 * See docs/api/error-handling.md § 3.1 / Contract C2 + C4 in the plan:
 * `error` is always an `ApiErrorCode`. The closed list of body context
 * fields is `details` (z.treeifyError tree OR `{ message: string }`-shaped
 * object), `lockedUntil` (ISO 8601, `ACCOUNT_LOCKED` only), and
 * `currentKeyVersion` (webauthn PRF CAS, `CONFLICT` only).
 *
 * Importantly: top-level `message` / `result` / `hint` / etc. are FORBIDDEN.
 * The `readonly` modifier + absence of an index signature means accessing
 * `body.message` (or any non-listed key) is a TypeScript error, catching
 * F8-class UI consumer regressions at compile time.
 *
 * Use `readApiErrorBody(res)` from `@/lib/http/read-api-error-body` on
 * client/UI sites to obtain a value of this type from a `Response`.
 */
export type MainApiErrorBody = {
  readonly error: ApiErrorCode;
  readonly details?: unknown;
  readonly lockedUntil?: string | null;
  readonly currentKeyVersion?: number;
};

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
 *
 * The `status` argument is optional and defaults to `API_ERROR_STATUS[code]`
 * (see `@/lib/http/api-error-codes`). Pass an explicit status only for the
 * documented exceptions in that map (e.g. `INVALID_ORIGIN, 500` in
 * vault/admin-reset). When the explicit value matches the default, the gate
 * `scripts/checks/check-api-error-codes.sh` flags it as redundant — drop
 * the second argument.
 */
export function errorResponse(
  code: ApiErrorCode,
  status?: number,
  details?: Record<string, unknown>,
  headers?: HeadersInit,
): NextResponse {
  return NextResponse.json(
    details ? { error: code, ...details } : { error: code },
    { status: status ?? API_ERROR_STATUS[code], headers },
  );
}

// ── Common presets ──────────────────────────────────────────────

export const unauthorized = () => errorResponse(API_ERROR.UNAUTHORIZED);

export const notFound = () => errorResponse(API_ERROR.NOT_FOUND);

export const forbidden = () => errorResponse(API_ERROR.FORBIDDEN);

// `validationError(details?)` — `details` is optional (undefined → no
// `details` field in the body). Accepts only object-shaped details (per C6
// — the `details` body field must be a z.treeifyError tree or equivalent
// object). Passing a string would be a runtime envelope violation; the type
// rejects it at compile time. Use `errorResponseWithMessage(VALIDATION_ERROR,
// msg)` for single-line message wrapping.
export const validationError = (details?: Record<string, unknown>) =>
  errorResponse(
    API_ERROR.VALIDATION_ERROR,
    undefined,
    details ? { details } : undefined,
  );

export const zodValidationError = (error: ZodError) =>
  validationError(z.treeifyError(error) as Record<string, unknown>);

/**
 * Convenience wrapper for the canonical `{ details: { message: "..." } }` shape.
 *
 * Replaces the verbose `errorResponse(code, status, { details: { message: "..." } })`
 * pattern at ~33 production sites. Keeps the wrap centralized so that future
 * changes to the message-wrap shape only need to touch this helper.
 *
 * For Zod / multi-field validation errors, use `validationError(treeOrObject)`
 * directly; this helper is for single-line diagnostic messages.
 *
 * Two call shapes:
 * - `errorResponseWithMessage(code, message)` — status defaults to
 *   `API_ERROR_STATUS[code]` (preferred)
 * - `errorResponseWithMessage(code, status, message)` — explicit status
 *   override (only for documented exceptions in API_ERROR_STATUS)
 */
export function errorResponseWithMessage(
  code: ApiErrorCode,
  message: string,
): NextResponse;
export function errorResponseWithMessage(
  code: ApiErrorCode,
  status: number,
  message: string,
): NextResponse;
export function errorResponseWithMessage(
  code: ApiErrorCode,
  statusOrMessage: number | string,
  message?: string,
): NextResponse {
  if (typeof statusOrMessage === "string") {
    return errorResponse(code, undefined, {
      details: { message: statusOrMessage },
    });
  }
  return errorResponse(code, statusOrMessage, {
    details: { message: message as string },
  });
}

export const rateLimited = (retryAfterMs?: number) => {
  const headers: Record<string, string> = {};
  if (retryAfterMs != null && retryAfterMs > 0) {
    headers["Retry-After"] = String(Math.ceil(retryAfterMs / MS_PER_SECOND));
  }
  return errorResponse(
    API_ERROR.RATE_LIMIT_EXCEEDED,
    undefined,
    undefined,
    headers,
  );
};

const DEFAULT_SERVICE_UNAVAILABLE_RETRY_AFTER_SEC = 30;

// 503 envelopes ALWAYS set Retry-After (operator playbook requires a back-off
// hint on service-unavailable; 429 may omit when the limiter cannot compute).
// retryAfterMs of 0 / null / undefined → use the 30 s default, not "no header".
function retryAfterSecondsOrDefault(retryAfterMs?: number): string {
  const sec =
    retryAfterMs != null && retryAfterMs > 0
      ? Math.ceil(retryAfterMs / MS_PER_SECOND)
      : DEFAULT_SERVICE_UNAVAILABLE_RETRY_AFTER_SEC;
  return String(sec);
}

/**
 * Canonical 503 envelope for opt-in rate-limiter fail-closed routes.
 *
 * Body shape is the minimal canonical envelope `{ error: "SERVICE_UNAVAILABLE" }`
 * (no internal failure-mode tokens leaked).
 */
export const serviceUnavailable = (retryAfterMs?: number) =>
  errorResponse(API_ERROR.SERVICE_UNAVAILABLE, undefined, undefined, {
    "Retry-After": retryAfterSecondsOrDefault(retryAfterMs),
  });

/**
 * RFC 6749 §5.2 OAuth 503 envelope. Used by `/api/mcp/*` routes
 * (OAuth Authorization Server, Dynamic Client Registration, token revocation)
 * where clients parse the OAuth-standard `error` vocabulary; the canonical
 * `serviceUnavailable()` envelope would not match RFC 6749 error grammar.
 *
 * No `error_description` field — see plan C2b, S12: drop the leakage surface;
 * a future caller MUST NOT pass interpolated error strings here.
 */
export const oauthTemporarilyUnavailable = (retryAfterMs?: number) =>
  NextResponse.json(
    { error: "temporarily_unavailable" },
    {
      status: 503,
      headers: { "Retry-After": retryAfterSecondsOrDefault(retryAfterMs) },
    },
  );

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
