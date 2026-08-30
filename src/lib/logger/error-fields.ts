import { pgErrorCode } from "@/lib/prisma/prisma-error";

export type ErrorLogFields = {
  name: string;
  code: string;
};

/** Token shape: no whitespace, no newlines, bounded length. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function asToken(value: unknown): string | null {
  return typeof value === "string" && TOKEN_RE.test(value) ? value : null;
}

/**
 * Reduce an unknown caught value to bounded, non-narrative log fields.
 *
 * Error objects must not be handed to pino: its serializer includes message
 * and stack, which can carry connection targets, role names, URLs, and other
 * operational details. Keep only token-shaped names/codes so a hostile custom
 * Error cannot move free-form text back into the log through either field.
 *
 * `code` is resolved through `pgErrorCode` FIRST, because the top-level `code`
 * on a Prisma error is the wrapper, not the fault. A raw-query failure arrives
 * as `P2010` with the driver's SQLSTATE nested underneath, and reading the top
 * level reports "raw query failed" for every SQL error alike. That collapses a
 * documented recovery procedure: docs/operations/alerts.md tells the operator
 * to tell `outbox.depth.check_failed`'s two known causes apart by this field —
 * 22P02 (the depth query ran outside a bypass transaction) versus P2028 (the
 * aggregate outgrew the transaction budget) — and only one of the two is a bug.
 *
 * Using `pgErrorCode` rather than a second unwrap is the other half: it is the
 * repo's single adjudicator for "what code does this error carry", already
 * shared with `sqlStateOf` in the db-integration helpers. Two readings of one
 * predicate drift, and the one that drifts is the one nobody is looking at.
 */
export function errorLogFields(error: unknown): ErrorLogFields {
  let name = "unknown";
  let code = "unknown";

  try {
    if (error instanceof Error) {
      name = asToken(error.name) ?? "unknown";
    }

    // Nested driver SQLSTATE first, then the top-level code — which covers a
    // plain Node errno (ENOTFOUND, ECONNREFUSED) and Prisma's own non-raw codes
    // (P2028), neither of which pgErrorCode claims.
    code =
      asToken(pgErrorCode(error)) ??
      asToken(
        typeof error === "object" && error !== null
          ? (error as { code?: unknown }).code
          : undefined,
      ) ??
      "unknown";
  } catch {
    // A caught value may expose throwing name/code getters, and pgErrorCode
    // walks `meta`/`cause` which may do the same. Logging the failure must
    // never replace the original control flow with a second exception.
  }

  return { name, code };
}
