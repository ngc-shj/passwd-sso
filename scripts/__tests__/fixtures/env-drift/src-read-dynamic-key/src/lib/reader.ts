// Fixture-only reader (check 12 [src-read-undeclared]: dynamic key
// construction). Three reads, and the case is self-pinning because the same
// run must produce different verdicts for them:
//
//  - SRC_READ_DYNAMIC_KEY_UNDECLARED is read via process.env[name] and is
//    declared nowhere — the enumerated non-member of check 12's domain
//    (lexically invisible to scanAppEnvReaders by design). It must NOT be
//    reported.
//  - SRC_READ_DYNAMIC_KEY_STATIC_UNDECLARED is read statically and is also
//    declared nowhere, so it MUST be reported. This is what pins the scanner
//    as alive: a declared read produces no output whether the scanner runs or
//    not, so it could not tell the two apart (round-1 Test F11).
//  - SRC_READ_DYNAMIC_KEY_DECLARED is read statically and declared in Zod —
//    the not-reported-because-declared control.
const DYNAMIC_NAME = "SRC_READ_DYNAMIC_KEY_UNDECLARED";

export function readDynamic(): string | undefined {
  return process.env[DYNAMIC_NAME];
}

export function readStaticUndeclared(): string | undefined {
  return process.env.SRC_READ_DYNAMIC_KEY_STATIC_UNDECLARED;
}

export function readDeclared(): string | undefined {
  return process.env.SRC_READ_DYNAMIC_KEY_DECLARED;
}
