/**
 * POSIX shell quoting for values interpolated into `console.log`-emitted
 * shell syntax (`export`, `eval`-able assignments, `trap` bodies).
 *
 * Promoted from `commands/env.ts`'s private `shellEscape` — this is the
 * single quoting helper for the CLI; do not write a second one.
 */

/** Quote `s` so that a POSIX shell reads it back as exactly one word equal to `s`. */
export function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-/:@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
