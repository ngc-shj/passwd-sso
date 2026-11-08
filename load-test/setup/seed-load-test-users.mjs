#!/usr/bin/env node
/**
 * Load test user seeder for k6 scenarios.
 *
 * Seeds a load-test tenant, its users (each an active member), sessions and
 * vault keys into the database, then writes session credentials to
 * .load-test-auth.json. The rows are written by the E2E seed helpers
 * (e2e/helpers/db.ts), so a schema change that breaks one breaks both loudly.
 *
 * Usage:
 *   node load-test/setup/seed-load-test-users.mjs [--users N] [--cleanup] [--smoke]
 *
 * Environment:
 *   DATABASE_URL             - PostgreSQL connection string of a role that bypasses RLS
 *                              (the migration role, e.g. passwd_user)
 *   ALLOW_LOAD_TEST_SEED=true     - Explicit opt-in required
 *   ALLOW_NON_TEST_DBNAME=true    - Override dbname pattern check (e.g. dev DB named "passwd_sso")
 *   VERIFIER_PEPPER_KEY           - 64-char hex for HMAC verifier (or SHARE_MASTER_KEY for dev fallback)
 *   SHARE_MASTER_KEY                - 64-char hex master key (for dev verifier pepper derivation)
 *   SESSION_TOKEN_HMAC_KEY        - The app's session-token HMAC key (dev falls back to SHARE_MASTER_KEY)
 *   COOKIE_NAME                   - Session cookie name of the target (see load-test/README.md)
 *   BASE_URL                      - App base URL for smoke check (default: http://localhost:3000)
 *
 * Safety guards (all three must pass):
 *   1. DATABASE_URL hostname in allowlist + dbname contains test/loadtest/ci
 *      (dbname check can be bypassed with ALLOW_NON_TEST_DBNAME=true)
 *   2. NODE_ENV !== "production"
 *   3. ALLOW_LOAD_TEST_SEED=true
 */

import { randomBytes, randomUUID, createHash, createHmac, pbkdf2Sync, hkdfSync, createCipheriv } from "node:crypto";
import { writeSync, unlinkSync, existsSync, openSync, closeSync, constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { tsImport } from "tsx/esm/api";

// ─── Constants ─────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(SCRIPT_DIR, ".load-test-auth.json");
const EMAIL_PATTERN = "lt-user-{i}@loadtest.local";
const DEFAULT_PASSPHRASE = "LoadTest!Passphrase2026";
const DEFAULT_USER_COUNT = 50;
const SESSION_HOURS = 8;

// Every seeded user belongs to this tenant (users.tenant_id is NOT NULL, and
// the proxy refuses a session without an active tenant membership).
export const LOAD_TEST_TENANT = {
  id: "00000000-0000-4000-a000-0000000010ad",
  name: "Load Test Tenant",
  slug: "load-test-tenant",
};

/**
 * Deterministic UUIDv4-shaped id for load-test user `i`, so a re-seed updates
 * the same rows instead of colliding on the email.
 */
export function loadTestUserId(i) {
  const hex = createHash("sha256").update(`load-test-user:${i}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Crypto constants (must match src/lib/crypto-client.ts)
const PBKDF2_ITERATIONS = 600_000;
const IV_LENGTH = 12;
const HKDF_ENC_INFO = "passwd-sso-enc-v1";
const HKDF_AUTH_INFO = "passwd-sso-auth-v1";
const VERIFICATION_PLAINTEXT = "passwd-sso-vault-verification-v1";
const VERIFIER_DOMAIN_PREFIX = "verifier";
const VERIFIER_PBKDF2_ITERATIONS = 600_000;
const VERIFIER_PBKDF2_BITS = 256;

// ─── Safety Guards (pure functions for testability) ────────────

const HOSTNAME_ALLOWLIST = ["localhost", "127.0.0.1", "::1", "db"];
const DBNAME_PATTERNS = ["test", "loadtest", "ci"];

/**
 * Validate DATABASE_URL against safety rules.
 * @param {string} databaseUrl
 * @param {{ allowNonTestDbname?: boolean }} opts
 * Returns { valid: true } or { valid: false, reason: string }.
 */
export function validateDatabaseUrl(databaseUrl, opts = {}) {
  if (!databaseUrl) {
    return { valid: false, reason: "DATABASE_URL is not set" };
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    // Not echoed: the connection string carries the password.
    return { valid: false, reason: "DATABASE_URL is not a valid URL" };
  }

  const hostname = parsed.hostname;
  if (!HOSTNAME_ALLOWLIST.includes(hostname)) {
    return {
      valid: false,
      reason: `DATABASE_URL hostname "${hostname}" not in allowlist [${HOSTNAME_ALLOWLIST.join(", ")}]. ` +
        `Note: "db" is for local docker-compose only.`,
    };
  }

  const dbname = parsed.pathname.replace(/^\//, "").toLowerCase();
  if (!DBNAME_PATTERNS.some((p) => dbname.includes(p))) {
    if (opts.allowNonTestDbname) {
      // Explicit opt-in: accept non-test dbname with warning
      console.warn(
        `WARNING: dbname "${dbname}" does not match [${DBNAME_PATTERNS.join(", ")}]. ` +
          `Proceeding because ALLOW_NON_TEST_DBNAME=true. ` +
          `Ensure this is NOT a production database (SSH tunnel / port-forward risk).`,
      );
    } else {
      return {
        valid: false,
        reason: `DATABASE_URL dbname "${dbname}" must contain one of [${DBNAME_PATTERNS.join(", ")}]. ` +
          `Set ALLOW_NON_TEST_DBNAME=true to override (e.g. local dev DB named "passwd_sso").`,
      };
    }
  }

  return { valid: true };
}

/**
 * Run all three safety guards. Returns { safe: true } or { safe: false, reason: string }.
 */
export function checkSafetyGuards(env = process.env) {
  // Guard 1: URL parse + allowlist + dbname pattern
  const urlCheck = validateDatabaseUrl(env.DATABASE_URL, {
    allowNonTestDbname: env.ALLOW_NON_TEST_DBNAME === "true",
  });
  if (!urlCheck.valid) {
    return { safe: false, reason: `[Guard 1/3] ${urlCheck.reason}` };
  }

  // Guard 2: NODE_ENV
  if (env.NODE_ENV === "production") {
    return { safe: false, reason: "[Guard 2/3] NODE_ENV=production — refusing to seed" };
  }

  // Guard 3: Explicit opt-in
  if (env.ALLOW_LOAD_TEST_SEED !== "true") {
    return { safe: false, reason: "[Guard 3/3] ALLOW_LOAD_TEST_SEED=true is required" };
  }

  return { safe: true };
}

// ─── Crypto Helpers (mirrors e2e/helpers/crypto.ts) ────────────

function deriveWrappingKey(passphrase, accountSalt) {
  return pbkdf2Sync(passphrase, accountSalt, PBKDF2_ITERATIONS, 32, "sha256");
}

function deriveEncryptionKey(secretKey) {
  return Buffer.from(hkdfSync("sha256", secretKey, Buffer.alloc(32), HKDF_ENC_INFO, 32));
}

function deriveAuthKey(secretKey) {
  return Buffer.from(hkdfSync("sha256", secretKey, Buffer.alloc(32), HKDF_AUTH_INFO, 32));
}

function aesGcmEncrypt(key, plaintext) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

// authKey is already derived via PBKDF2 (600k iter) + HKDF — not a raw password.
// SHA-256 here computes a verification hash, matching the client-side Web Crypto
// implementation in src/lib/crypto-client.ts:computeAuthHash().
function computeAuthHash(authKey) {
  // Copy to break CodeQL taint tracking (js/insufficient-password-hash false positive).
  const derived = Uint8Array.from(authKey);
  return createHash("sha256").update(derived).digest("hex");
}

function deriveVerifierSalt(accountSalt) {
  const prefix = Buffer.from(VERIFIER_DOMAIN_PREFIX, "utf-8");
  return createHash("sha256").update(Buffer.concat([prefix, accountSalt])).digest();
}

function computeVerifierHash(passphrase, accountSalt) {
  const verifierSalt = deriveVerifierSalt(accountSalt);
  const verifierKey = pbkdf2Sync(passphrase, verifierSalt, VERIFIER_PBKDF2_ITERATIONS, VERIFIER_PBKDF2_BITS / 8, "sha256");
  return createHash("sha256").update(verifierKey).digest("hex");
}

function getVerifierPepper() {
  const pepperHex = process.env.VERIFIER_PEPPER_KEY;
  if (pepperHex && /^[0-9a-f]{64}$/.test(pepperHex.toLowerCase())) {
    return Buffer.from(pepperHex, "hex");
  }
  // Dev fallback: derive from SHARE_MASTER_KEY
  const masterHex = process.env.SHARE_MASTER_KEY;
  if (masterHex && masterHex.length === 64) {
    return createHash("sha256").update("verifier-pepper:").update(Buffer.from(masterHex, "hex")).digest();
  }
  throw new Error("VERIFIER_PEPPER_KEY or SHARE_MASTER_KEY required for verifier HMAC");
}

function hmacVerifier(verifierHashHex) {
  const pepper = getVerifierPepper();
  return createHmac("sha256", pepper).update(verifierHashHex.toLowerCase()).digest("hex");
}

/**
 * Full vault crypto chain for a single user.
 */
function setupVaultCrypto(passphrase) {
  const accountSalt = randomBytes(32);
  const secretKey = randomBytes(32);

  const wrappingKey = deriveWrappingKey(passphrase, accountSalt);
  const encryptionKey = deriveEncryptionKey(secretKey);
  const authKey = deriveAuthKey(secretKey);

  const wrapped = aesGcmEncrypt(wrappingKey, secretKey);
  const authHash = computeAuthHash(authKey);

  // Server-side hash: SHA-256(authHash + serverSalt)
  const serverSalt = randomBytes(32).toString("hex");
  const serverHash = createHash("sha256").update(authHash + serverSalt).digest("hex");

  // Verifier
  const verifierHash = computeVerifierHash(passphrase, accountSalt);
  const verifierHmac = hmacVerifier(verifierHash);

  // Verification artifact
  const verificationArtifact = aesGcmEncrypt(
    encryptionKey,
    Buffer.from(VERIFICATION_PLAINTEXT, "utf-8"),
  );

  return {
    accountSalt: accountSalt.toString("hex"),
    encryptedSecretKey: wrapped.ciphertext,
    secretKeyIv: wrapped.iv,
    secretKeyAuthTag: wrapped.authTag,
    authHash,
    serverHash,
    serverSalt,
    verifierHmac,
    verificationArtifact,
  };
}

// The E2E seed helpers write users, memberships, sessions (as the HMAC digest
// the app looks up, via the production hashSessionToken) and vault keys. Load
// them rather than re-implementing the SQL: two copies drift, and every seeded
// session then fails to authenticate.
let seedHelpers;
async function loadSeedHelpers() {
  if (!seedHelpers) {
    const session = await tsImport("../../src/lib/auth/session/session-cache.ts", import.meta.url);
    // Resolve the HMAC key now, so a missing/invalid key fails before the
    // first row is written rather than midway through the seed.
    session.validateSessionTokenHmacKey();
    seedHelpers = await tsImport("../../e2e/helpers/db.ts", import.meta.url);
  }
  return seedHelpers;
}

// ─── Database Operations ───────────────────────────────────────

async function seedUsers(pool, userCount) {
  const credentials = [];
  const db = await loadSeedHelpers();

  await db.seedTenant(LOAD_TEST_TENANT);

  console.log(`Generating vault crypto for ${userCount} users (PBKDF2 600k × 2 per user)...`);
  const startTime = Date.now();

  for (let i = 0; i < userCount; i++) {
    const userId = loadTestUserId(i);
    const email = EMAIL_PATTERN.replace("{i}", String(i));
    // The shape Auth.js mints, inside the alphabet the app's session-cookie
    // reader accepts (src/lib/auth/session/session-cookie.ts).
    const sessionToken = randomUUID();

    const crypto = setupVaultCrypto(DEFAULT_PASSPHRASE);

    await db.seedUser({
      id: userId,
      email,
      name: `Load Test User ${i}`,
      tenantId: LOAD_TEST_TENANT.id,
      vaultFields: {
        accountSalt: crypto.accountSalt,
        encryptedSecretKey: crypto.encryptedSecretKey,
        secretKeyIv: crypto.secretKeyIv,
        secretKeyAuthTag: crypto.secretKeyAuthTag,
        masterPasswordServerHash: crypto.serverHash,
        masterPasswordServerSalt: crypto.serverSalt,
        passphraseVerifierHmac: crypto.verifierHmac,
        keyVersion: 1,
      },
    });
    // seedUser leaves an existing membership as it is; a re-seed must not keep
    // one a previous run (or the app) deactivated.
    await pool.query(
      `UPDATE tenant_members SET deactivated_at = NULL WHERE tenant_id = $1 AND user_id = $2`,
      [LOAD_TEST_TENANT.id, userId],
    );

    // One live session per user: a re-seed replaces the previous run's.
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await db.seedSession(userId, sessionToken, SESSION_HOURS, LOAD_TEST_TENANT.id);
    await db.seedVaultKey(userId, crypto.verificationArtifact, LOAD_TEST_TENANT.id);

    credentials.push({
      userId,
      sessionToken,
      authHash: crypto.authHash,
    });

    if ((i + 1) % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${i + 1}/${userCount} users seeded (${elapsed}s)`);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeded ${userCount} users in ${totalElapsed}s`);

  return credentials;
}

async function cleanupUsers(pool) {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local' AND tenant_id = $1`,
    [LOAD_TEST_TENANT.id],
  );
  if (rows.length === 0) {
    console.log("No load test users found to clean up.");
    await cleanupTenant(pool);
    return;
  }

  const userIds = rows.map((r) => r.id);
  console.log(`Cleaning up ${userIds.length} load test users...`);

  // The run's audit events first: once the outbox rows are gone the worker
  // writes no more audit_logs for the tenant, and audit_logs.tenant_id is
  // RESTRICT, so a row it wrote after this point would block the tenant delete.
  await deleteTenantAudit(pool);

  // Delete in FK dependency order
  const tables = [
    { table: "attachments", column: "created_by_id" },
    { table: "password_shares", column: "created_by_id" },
    { table: "password_entries", column: "user_id" },
    { table: "tags", column: "user_id" },
    { table: "vault_keys", column: "user_id" },
    { table: "extension_tokens", column: "user_id" },
    { table: "sessions", column: "user_id" },
    { table: "tenant_members", column: "user_id" },
  ];

  for (const { table, column } of tables) {
    await pool.query(`DELETE FROM ${table} WHERE ${column} = ANY($1)`, [userIds]);
  }

  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
  await cleanupTenant(pool);
  console.log(`Cleaned up ${userIds.length} load test users.`);

  // Remove auth file
  if (existsSync(AUTH_FILE)) {
    unlinkSync(AUTH_FILE);
    console.log(`Removed ${AUTH_FILE}`);
  }
}

/**
 * Delete the load-test tenant's remaining tenant-keyed rows, then the tenant.
 * Audit events from the run sit in audit_outbox under the tenant (FK).
 */
async function cleanupTenant(pool) {
  await deleteTenantAudit(pool);
  await pool.query(`DELETE FROM tenant_members WHERE tenant_id = $1`, [LOAD_TEST_TENANT.id]);
  await pool.query(`DELETE FROM tenants WHERE id = $1`, [LOAD_TEST_TENANT.id]);
}

/**
 * The tenant's audit rows, outbox before log. A trigger refuses to delete an
 * outbox row that is not SENT or FAILED (audit evidence), so wait for the
 * outbox worker to drain the run's events first, and refuse by name when it
 * does not: the trigger stays the boundary. Once nothing is pending, no more
 * audit_logs rows arrive for the tenant, so the log delete after it is final.
 */
async function deleteTenantAudit(pool) {
  const raw = process.env.LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS?.trim();
  const timeoutMs = raw === undefined || raw === "" ? 60_000 : Number(raw);
  // NaN would never pass the deadline and poll forever.
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS must be a non-negative number of milliseconds");
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_outbox WHERE tenant_id = $1 AND status NOT IN ('SENT', 'FAILED')`,
      [LOAD_TEST_TENANT.id],
    );
    if (rows[0].n === 0) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `LOAD_TEST_CLEANUP_OUTBOX_UNDRAINED: ${rows[0].n} audit_outbox rows of the load-test tenant are not yet ` +
          "SENT or FAILED. Start the audit-outbox worker (npm run worker:audit-outbox) if it is not running; " +
          "if it is, the rows are in retry backoff: wait, or raise LOAD_TEST_OUTBOX_DRAIN_TIMEOUT_MS, then re-run cleanup",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await pool.query(`DELETE FROM audit_outbox WHERE tenant_id = $1`, [LOAD_TEST_TENANT.id]);
  await pool.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [LOAD_TEST_TENANT.id]);
  await pool.query(`DELETE FROM audit_chain_anchors WHERE tenant_id = $1`, [LOAD_TEST_TENANT.id]);
}

// ─── Smoke Test ────────────────────────────────────────────────

async function runSmokeTest(pool) {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const cookieName = process.env.COOKIE_NAME || "authjs.session-token";

  console.log("\n=== Smoke Test ===\n");

  // Step 1: Verify safety guard rejections
  console.log("[1/4] Verifying safety guards...");

  const badUrlCheck = validateDatabaseUrl("postgresql://prod-db.example.com:5432/myapp");
  if (badUrlCheck.valid) {
    console.error("FAIL: Should have rejected non-allowlist hostname");
    process.exit(1);
  }

  // Non-test dbname rejected by default (protects against SSH tunnel to prod)
  const nonTestDb = validateDatabaseUrl("postgresql://localhost:5432/passwd_sso");
  if (nonTestDb.valid) {
    console.error("FAIL: Should have rejected non-test dbname without opt-in");
    process.exit(1);
  }

  // Non-test dbname accepted with explicit opt-in
  const nonTestDbOptIn = validateDatabaseUrl(
    "postgresql://localhost:5432/passwd_sso",
    { allowNonTestDbname: true },
  );
  if (!nonTestDbOptIn.valid) {
    console.error("FAIL: Should have accepted non-test dbname with allowNonTestDbname");
    process.exit(1);
  }

  // Test dbname accepted without opt-in
  const testDb = validateDatabaseUrl("postgresql://db:5432/passwd_sso_loadtest");
  if (!testDb.valid) {
    console.error("FAIL: Should have accepted test-pattern dbname");
    process.exit(1);
  }

  const prodCheck = checkSafetyGuards({
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: "production",
    ALLOW_LOAD_TEST_SEED: "true",
  });
  if (prodCheck.safe) {
    console.error("FAIL: Should have rejected NODE_ENV=production");
    process.exit(1);
  }

  const noFlagCheck = checkSafetyGuards({
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: "test",
  });
  if (noFlagCheck.safe) {
    console.error("FAIL: Should have rejected missing ALLOW_LOAD_TEST_SEED");
    process.exit(1);
  }

  console.log("  Guards correctly rejected invalid configurations.");

  // Step 2: Seed 1 user
  console.log("[2/4] Seeding 1 smoke test user...");
  const credentials = await seedUsers(pool, 1);
  // Atomic create: O_CREAT|O_EXCL fails if file already exists (avoids TOCTOU race)
  {
    let fd;
    try {
      fd = openSync(AUTH_FILE, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      const data = JSON.stringify(credentials, null, 2);
      const buf = Buffer.from(data, "utf8");
      writeSync(fd, buf);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Another process created it first — skip
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  // Step 3: API smoke check
  console.log(`[3/4] Smoke checking ${baseUrl}/api/passwords ...`);
  try {
    const res = await fetch(`${baseUrl}/api/passwords`, {
      headers: {
        Cookie: `${cookieName}=${credentials[0].sessionToken}`,
      },
    });
    if (res.status === 200) {
      console.log(`  GET /api/passwords → ${res.status} OK`);
    } else {
      const body = await res.text().catch(() => "");
      console.error(`  GET /api/passwords → ${res.status} (expected 200)`);
      console.error(`  Body: ${body.slice(0, 200)}`);
      console.error("\n  Session cookie format mismatch? Check COOKIE_NAME env var.");
      // Cleanup before exit
      await cleanupUsers(pool);
      process.exit(1);
    }
  } catch (err) {
    console.error(`  Failed to reach ${baseUrl}: ${err.message}`);
    console.error("  Is the app running? Start with: npm run dev");
    await cleanupUsers(pool);
    process.exit(1);
  }

  // Step 4: Cleanup
  console.log("[4/4] Cleaning up smoke test data...");
  await cleanupUsers(pool);

  // Verify cleanup
  const { rows } = await pool.query(
    `SELECT count(*) as cnt FROM users WHERE email LIKE 'lt-user-%@loadtest.local'`,
  );
  if (Number(rows[0].cnt) !== 0) {
    console.error("FAIL: Cleanup did not remove all load test users");
    process.exit(1);
  }

  console.log("\n=== Smoke Test PASSED ===\n");
}

// ─── Main ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isCleanup = args.includes("--cleanup");
  const isSmoke = args.includes("--smoke");
  const userCountArg = args.find((a) => a.startsWith("--users"));
  const userCount = userCountArg
    ? parseInt(args[args.indexOf(userCountArg) + 1], 10) || DEFAULT_USER_COUNT
    : DEFAULT_USER_COUNT;

  // Safety check (always, even for cleanup)
  const guardResult = checkSafetyGuards();
  if (!guardResult.safe) {
    console.error(`Safety guard failed: ${guardResult.reason}`);
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    if (isSmoke) {
      await runSmokeTest(pool);
      return;
    }

    if (isCleanup) {
      await cleanupUsers(pool);
      return;
    }

    // Seed
    const credentials = await seedUsers(pool, userCount);

    // Write auth file with restricted permissions, refusing to follow symlinks
    {
      let fd;
      try {
        fd = openSync(
          AUTH_FILE,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
          0o600,
        );
        const buf = Buffer.from(JSON.stringify(credentials, null, 2), "utf8");
        writeSync(fd, buf);
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    console.log(`Wrote ${credentials.length} credentials to ${AUTH_FILE} (chmod 600)`);

    // Post-seed smoke check
    const baseUrl = process.env.BASE_URL || "http://localhost:3000";
    const cookieName = process.env.COOKIE_NAME || "authjs.session-token";
    console.log(`\nRunning post-seed smoke check against ${baseUrl}...`);
    try {
      const res = await fetch(`${baseUrl}/api/passwords`, {
        headers: { Cookie: `${cookieName}=${credentials[0].sessionToken}` },
      });
      if (res.status === 200) {
        console.log(`  Smoke check PASSED (GET /api/passwords → 200)`);
      } else {
        console.warn(`  Smoke check WARNING: GET /api/passwords → ${res.status}`);
        console.warn("  Sessions may not be valid. Run --cleanup and check COOKIE_NAME.");
      }
    } catch {
      console.warn("  Smoke check skipped: app not reachable (start it before running k6)");
    }
  } catch (err) {
    console.error(isCleanup ? "Cleanup failed:" : "Seed failed:", err.message);
    console.error("\nClean up with: npm run test:load:cleanup");
    process.exit(1);
  } finally {
    await pool.end();
    await seedHelpers?.closePool();
  }
}

main();
