// Fixture-only .tsx reader (round-2 M17 / RT4 liveness pin): proves
// scanAppEnvReaders walks .tsx files, not just .ts. The var is declared in
// neither the Zod schema nor the allowlist — check 12 must flag it.
export function Widget() {
  const flag = process.env.SRC_READ_TSX_UNDECLARED_VAR;
  return flag;
}
