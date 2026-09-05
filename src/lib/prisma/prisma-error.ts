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

/**
 * `check_violation`. Exported from here rather than spelled at the call site so
 * the SQLSTATE vocabulary stays in the module that already owns the reading of
 * it — the same reason `pgErrorCode` is not re-derived per caller.
 */
export const SQLSTATE_CHECK_VIOLATION = "23514";

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
 * `constraint "…"` — the quoted name PostgreSQL puts in the message.
 *
 * Anchored on the keyword rather than searched for a name we already have: a
 * caller must be able to ask WHICH constraint fired and compare the answer by
 * exact equality. A `message.includes("users_not_system_tenant")` reads true for
 * any error that merely mentions the name — including one raised on a different
 * table by a trigger that quotes it — and cannot report the name it did not
 * expect.
 */
const CONSTRAINT_NAME_RE = /\bconstraint\s+"([^"]+)"/;

/**
 * The name of the constraint an error names, or null when there is none.
 *
 * The nestings below are MEASURED against real 23514s raised on this repo's own
 * CHECKs, the same way `pgErrorCode`'s order was — not guessed. Three facts came
 * out of that measurement and each one shapes this function:
 *
 *   1. There is NO structured field. The pg driver's native error carries
 *      `.constraint`, but `@prisma/adapter-pg` normalises it away: the
 *      `DriverAdapterError`'s cause carries `originalCode`, `originalMessage`,
 *      `kind`, `code`, `severity`, `message` and `detail`, and nothing else. The
 *      message text is the only channel, which is why this is a parse.
 *   2. The ORM path and the raw-query path differ in Prisma's own code —
 *      `user.create` surfaces as **P2039**, a raw-query call as **P2010** —
 *      while both nest the driver error identically. A reader keyed on P2010
 *      would see the raw path and miss every ORM write. (The raw primitive is
 *      named without its sigil deliberately: `check-raw-sql-usage.mjs` matches
 *      the spelling by regex, so writing it here would demand an allowlist
 *      entry for a file that issues no SQL — and the gate's own STALE_EXEMPT
 *      arm would then fail the day someone reworded this comment.)
 *   3. `err.message` also renders the text, so it is kept as the last step: it
 *      survives an adapter that changes the nesting.
 *
 * KNOWN LIMIT, stated rather than hidden: PostgreSQL localises its messages, so
 * on a server with a non-English `lc_messages` the keyword does not appear and
 * this returns null. That is a fail-CLOSED degradation for every caller intended
 * here — an unrecognised constraint is handled as an unclassified error, not as
 * a matched one — and it is why callers must pair a match with an explicit
 * "could not extract" arm rather than treating null as "some other constraint".
 */
export function pgConstraintName(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;

  const candidates: unknown[] = [];
  const meta = (err as { meta?: unknown }).meta;
  if (meta && typeof meta === "object") {
    const adapter = (meta as { driverAdapterError?: unknown }).driverAdapterError;
    if (adapter && typeof adapter === "object") {
      const cause = (adapter as { cause?: unknown }).cause;
      if (cause && typeof cause === "object") {
        candidates.push(
          (cause as { originalMessage?: unknown }).originalMessage,
          (cause as { message?: unknown }).message,
        );
      }
      candidates.push((adapter as { message?: unknown }).message);
    }
  }
  candidates.push(err instanceof Error ? err.message : undefined);

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const name = CONSTRAINT_NAME_RE.exec(candidate)?.[1];
    if (name) return name;
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
