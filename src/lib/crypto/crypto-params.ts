// Dependency-free shared cipher-parameter module.
// Importable from both client and server bundles without triggering
// server-only imports (e.g. node:crypto). All values are pure numeric
// constants — no logic, no side effects.

export const AES_KEY_LENGTH = 256;
export const IV_LENGTH = 12;
export const AUTH_TAG_LENGTH = 16;
export const PBKDF2_ITERATIONS = 600_000;
