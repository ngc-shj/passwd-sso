// Fixture-only reader (check 12 [src-read-undeclared] positive case:
// dynamic key construction). SRC_READ_DYNAMIC_KEY_UNDECLARED is read via
// process.env[name] and is declared nowhere — this is the enumerated
// non-member of check 12's domain (lexically invisible to
// scanAppEnvReaders by design) and must NOT be flagged.
//
// SRC_READ_DYNAMIC_KEY_DECLARED is read statically AND is declared in the
// Zod schema, pinning that the scanner is actually alive for this fixture
// (a dead scanner would make the dynamic-key assertion vacuous).
const DYNAMIC_NAME = "SRC_READ_DYNAMIC_KEY_UNDECLARED";

export function readDynamic(): string | undefined {
  return process.env[DYNAMIC_NAME];
}

export function readDeclared(): string | undefined {
  return process.env.SRC_READ_DYNAMIC_KEY_DECLARED;
}
