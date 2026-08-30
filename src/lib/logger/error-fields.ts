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
function readCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const e = error as { code?: unknown; cause?: { code?: unknown } };

  // Order is load-bearing, and each step covers what the next cannot:
  //   1. the nested driver SQLSTATE — a Prisma raw-query failure arrives as
  //      P2010 with the real fault underneath, so the top level would report
  //      "raw query failed" for 42501, 23503 and 55P03 alike;
  //   2. the top-level code — Prisma's own non-raw codes (P2028) and a direct
  //      Node errno, neither of which pgErrorCode claims;
  //   3. ONE level of `cause.code` — undici puts the errno there and leaves the
  //      top level empty, so `fetch failed` reduced to `{TypeError, unknown}`
  //      for every network fault. That is the anchor-publisher's commonest
  //      failure (destination unreachable), and it is the shape
  //      docs/operations/alerts.md promises an errno for.
  // Exactly one level: a cause chain can be cyclic, and a walk is not needed to
  // reach what Node actually sets.
  return (
    asToken(pgErrorCode(error)) ??
    asToken(e.code) ??
    asToken(e.cause?.code) ??
    "unknown"
  );
}

export function errorLogFields(error: unknown): ErrorLogFields {
  // Two independent try blocks, not one. A single block let a throwing `name`
  // getter abort before `code` was computed, so a hostile value could suppress
  // the very SQLSTATE this helper exists to surface by throwing from an
  // unrelated accessor. Each field now degrades on its own.
  let name = "unknown";
  try {
    if (error instanceof Error) name = asToken(error.name) ?? "unknown";
  } catch {
    // A caught value may expose a throwing `name` getter.
  }

  let code = "unknown";
  try {
    code = readCode(error);
  } catch {
    // pgErrorCode walks `meta` and `cause`, either of which may throw. Logging
    // the failure must never replace the original control flow with a second
    // exception.
  }

  return { name, code };
}
