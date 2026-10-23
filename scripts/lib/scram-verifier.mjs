#!/usr/bin/env node
// SCRAM-SHA-256 verifier for a role password, in the form PostgreSQL stores in
// pg_authid.rolpassword. Sending this instead of the cleartext in
// `CREATE/ALTER ROLE … PASSWORD '…'` is what psql's \password does
// (PQencryptPasswordConn): a refused statement, `log_statement = ddl|all` and
// pg_stat_statements then record a verifier, never the password. The server
// stores a string it recognises as a SCRAM secret unchanged, under any
// `password_encryption`.
//
// RFC 5802 §3 built from node:crypto primitives only:
//   SaltedPassword = PBKDF2-HMAC-SHA-256(password, salt, i, 32)
//   StoredKey      = SHA-256(HMAC(SaltedPassword, "Client Key"))
//   ServerKey      = HMAC(SaltedPassword, "Server Key")
//
// Non-ASCII passwords are refused. The server and node-postgres both apply
// SASLprep to the password before deriving; this helper does not implement it.
// For ASCII, SASLprep is the identity, so the raw bytes derived here are what
// login compares; for anything else the verifier could store a password no
// client can log in with.
//
// CLI: `node scram-verifier.mjs --iterations <server value>` reads the password
// from stdin verbatim and prints the verifier. <server value> is what
// current_setting('scram_iterations', true) returned — digits, or empty before
// PostgreSQL 16. A refusal prints only its reason, never the input.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

/** PostgreSQL's default `scram_iterations`; the floor this helper applies. */
export const MIN_SCRAM_ITERATIONS = 4096;
/** node-postgres refuses to log in above this (DEFAULT_MAX_SCRAM_ITERATIONS). */
export const MAX_SCRAM_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/**
 * The iteration count to derive with: the server's own, never below its
 * default, never above what node-postgres accepts.
 *
 * @param {string | number | null | undefined} serverValue current_setting's text, or NULL
 * @returns {number}
 */
export function resolveIterations(serverValue) {
  if (serverValue === null || serverValue === undefined || serverValue === "") {
    return MIN_SCRAM_ITERATIONS;
  }
  const text = String(serverValue);
  if (!/^[0-9]+$/.test(text)) {
    throw new Error("scram_iterations is not an unsigned integer");
  }
  const n = Number(text);
  if (n > MAX_SCRAM_ITERATIONS) {
    throw new Error(
      `scram_iterations above ${MAX_SCRAM_ITERATIONS}: node-postgres would refuse to log in with it`,
    );
  }
  return Math.max(MIN_SCRAM_ITERATIONS, n);
}

/**
 * Throws unless `password` can be turned into a verifier that logs in.
 * The message names the reason only.
 *
 * @param {string} password
 */
export function assertUsablePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password is empty");
  }
  if (!/^[\x00-\x7f]*$/.test(password)) {
    throw new Error("password contains a non-ASCII character");
  }
}

/**
 * @param {string} password
 * @param {{ iterations: number, salt?: Buffer }} opts `salt` is for tests only
 * @returns {string} `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`
 */
export function scramSha256Verifier(password, { iterations, salt }) {
  assertUsablePassword(password);
  if (!Number.isInteger(iterations) || iterations < MIN_SCRAM_ITERATIONS) {
    throw new Error(`iterations must be an integer >= ${MIN_SCRAM_ITERATIONS}`);
  }
  const s = salt ?? randomBytes(SALT_BYTES);
  const salted = pbkdf2Sync(Buffer.from(password, "utf8"), s, iterations, KEY_BYTES, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return (
    `SCRAM-SHA-256$${iterations}:${s.toString("base64")}` +
    `$${storedKey.toString("base64")}:${serverKey.toString("base64")}`
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const at = process.argv.indexOf("--iterations");
  if (at === -1 || at + 1 >= process.argv.length) {
    throw new Error("usage: scram-verifier.mjs --iterations <server value> < password");
  }
  const iterations = resolveIterations(process.argv[at + 1]);
  process.stdout.write(`${scramSha256Verifier(await readStdin(), { iterations })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`scram-verifier: ${e instanceof Error ? e.message : "failed"}\n`);
    process.exit(1);
  });
}
