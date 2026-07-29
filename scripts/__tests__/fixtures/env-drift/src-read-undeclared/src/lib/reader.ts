// Fixture-only reader (check 12 [src-read-undeclared] negative case: the var
// is declared in neither the Zod schema nor the allowlist — must be flagged).
export function readVar(): string | undefined {
  return process.env.SRC_READ_UNDECLARED_VAR;
}
