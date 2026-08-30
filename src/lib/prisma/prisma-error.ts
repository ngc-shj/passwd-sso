import { Prisma } from "@prisma/client";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";

interface PrismaErrorMapping {
  status: number;
  code: ApiErrorCode;
}

/**
 * A five-character SQLSTATE, excluding Prisma's own error codes.
 *
 * The two domains overlap in shape, which is why the exclusion is by pattern
 * rather than by length: Prisma numbers its errors P1000-P6xxx, and PostgreSQL
 * has a real SQLSTATE class P0 (P0001 raise_exception, P0002 no_data_found).
 * `P2010` and `P0001` are both `[0-9A-Z]{5}`, so a length test would hand back
 * the wrapper code as if it were the driver's — the defect this ordering
 * exists to avoid. `P[1-9]` is Prisma's; everything else is the driver's.
 */
const PRISMA_ERROR_CODE_RE = /^P[1-9]\d{3}$/;
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

function asSqlState(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!SQLSTATE_RE.test(value)) return null;
  return PRISMA_ERROR_CODE_RE.test(value) ? null : value;
}

/**
 * The PostgreSQL SQLSTATE carried by an error, or null when there is none.
 *
 * Prisma surfaces a driver-level error in several shapes depending on where it
 * was raised, and a check that reads only one silently classifies the others as
 * "unknown error". The order below is the MEASURED one — `sqlStateOf` in
 * src/__tests__/db-integration/helpers.ts established the first two against a
 * real database (fixtures at helpers.test.ts), and that helper now delegates
 * here so the two cannot drift into deciding one predicate differently:
 *
 *   1. meta.driverAdapterError.cause.code   the pg driver adapter's nesting
 *   2. meta.code                            P2010's flatter rendering
 *   3. err.code                             a direct pg error
 *   4. err.cause.code                       a Prisma-wrapped driver error
 *   5. "Code: `42P01`" in the message       paths that render it into the text
 *
 * Reading the wrapper before the nested value is what makes this order
 * load-bearing rather than arbitrary: a P2010 carries `code` AND the driver's
 * SQLSTATE underneath, so returning `code` first hands back "P2010" for every
 * raw-query failure. That is why steps 3 and 4 go through `asSqlState`.
 *
 * This is the repo's single reading of "what SQLSTATE does this error carry".
 * Add callers here rather than re-deriving: `isLockTimeoutError` in
 * src/lib/auth/policy/account-lockout.ts kept its own copy for a while and
 * missed step 1 the whole time, silently rethrowing the lock timeouts it
 * existed to recognise.
 */
export function pgErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;

  const meta = (err as { meta?: unknown }).meta;
  if (meta && typeof meta === "object") {
    const adapter = (meta as { driverAdapterError?: unknown }).driverAdapterError;
    if (adapter && typeof adapter === "object") {
      const cause = (adapter as { cause?: unknown }).cause;
      if (cause && typeof cause === "object") {
        const nested = (cause as { code?: unknown }).code;
        if (typeof nested === "string") return nested;
      }
    }
    const flat = (meta as { code?: unknown }).code;
    if (typeof flat === "string") return flat;
  }

  const direct = asSqlState((err as { code?: unknown }).code);
  if (direct) return direct;

  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeCode = asSqlState((cause as { code?: unknown }).code);
    if (causeCode) return causeCode;
  }

  const message = err instanceof Error ? err.message : String(err);
  return /Code:\s*`([0-9A-Z]{5})`/.exec(message)?.[1] ?? null;
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
