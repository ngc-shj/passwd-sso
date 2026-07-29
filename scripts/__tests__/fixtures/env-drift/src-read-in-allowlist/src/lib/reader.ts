// Fixture-only reader (check 12 [src-read-undeclared] positive case: the var
// is declared in the allowlist with readByApp: true, so this read must NOT
// be flagged by either check 9 or check 12).
export function readVar(): string | undefined {
  return process.env.SRC_READ_IN_ALLOWLIST_VAR;
}
