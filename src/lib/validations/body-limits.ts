// Request body size caps shared by route handlers and next.config.ts.
// Dependency-free on purpose: next.config.ts is loaded by Next's own config
// transpiler, which does not resolve the "@/" alias inside imported modules.
// Re-exported from ./common, which is where routes import them.

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Content-Length cap for the attachment-migrate JSON payload. Mirrors the
// upload route's Content-Length pre-check so the migrate endpoint cannot be
// abused as a memory-DoS vector via oversized base64 body submissions.
export const ATTACHMENT_MIGRATE_PAYLOAD_MAX = MAX_FILE_SIZE * 2;

// Declared Content-Length cap for a multipart attachment upload of a
// MAX_FILE_SIZE body (ciphertext plus form framing).
export const ATTACHMENT_UPLOAD_MULTIPART_MAX = MAX_FILE_SIZE * 2;

// Cap on a team entry re-key POST body (entry, history rows, CEK re-wraps).
export const REKEY_BODY_MAX = 16 * 1024 * 1024;

// Cap on a personal vault key rotation body (entries, history, CEK re-wraps).
export const VAULT_ROTATE_BODY_MAX = 16 * 1024 * 1024;

// next.config.ts `experimental.proxyClientMaxBodySize`. Past this size the
// proxy does not reject: it buffers up to the limit and hands the route a
// truncated body, so it must cover the largest route body cap. Each route
// still enforces its own cap on the bytes it reads.
export const PROXY_CLIENT_MAX_BODY_SIZE = Math.max(
  REKEY_BODY_MAX,
  VAULT_ROTATE_BODY_MAX,
  ATTACHMENT_MIGRATE_PAYLOAD_MAX,
  ATTACHMENT_UPLOAD_MULTIPART_MAX,
);
