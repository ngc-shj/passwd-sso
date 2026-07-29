// Fixture-only reader (check 12 [src-read-undeclared] positive case: the var
// is declared in the Zod schema, so this read must NOT be flagged).
export function readVar(): string | undefined {
  return process.env.SRC_READ_IN_ZOD_VAR;
}
