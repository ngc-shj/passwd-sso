#!/usr/bin/env node
/**
 * Load test user seeder for k6 scenarios.
 *
 * Seeds users, sessions, and vault keys into the database,
 * then writes session credentials to .load-test-auth.json.
 *
 * Usage:
 *   node load-test/setup/seed-load-test-users.mjs [--users N] [--cleanup] [--smoke]
 *
 * Environment:
 *   DATABASE_URL             - PostgreSQL connection string
 *   ALLOW_LOAD_TEST_SEED=true - Explicit opt-in required
 *   VERIFIER_PEPPER_KEY      - 64-char hex for HMAC verifier (or ORG_MASTER_KEY for dev fallback)
 *   ORG_MASTER_KEY           - 64-char hex master key (for dev verifier pepper derivation)
 *   BASE_URL                 - App base URL for smoke check (default: http://localhost:3000)
 *
 * Safety guards (all three must pass):
 *   1. DATABASE_URL hostname in allowlist + dbname contains test/loadtest/ci
 *   2. NODE_ENV !== "production"
 *   3. ALLOW_LOAD_TEST_SEED=true
 */

import { randomBytes, createHash, createHmac, pbkdf2Sync, hkdfSync, createCipheriv } from "node:crypto";
import { writeFileSync, chmodSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

// ─── Constants ─────────────────────────────────────────────────

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AUTH_FILE = join(SCRIPT_DIR, ".load-test-auth.json");
const EMAIL_PATTERN = "lt-user-{i}@loadtest.local";
const DEFAULT_PASSPHRASE = "LoadTest!Passphrase2026";
const DEFAULT_USER_COUNT = 50;
const SESSION_HOURS = 8;

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
 * Returns { valid: true } or { valid: false, reason: string }.
 */
export function validateDatabaseUrl(databaseUrl) {
  if (!databaseUrl) {
    return { valid: false, reason: "DATABASE_URL is not set" };
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return { valid: false, reason: `DATABASE_URL is not a valid URL: ${databaseUrl}` };
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
    return {
      valid: false,
      reason: `DATABASE_URL dbname "${dbname}" must contain one of [${DBNAME_PATTERNS.join(", ")}]`,
    };
  }

  return { valid: true };
}

/**
 * Run all three safety guards. Returns { safe: true } or { safe: false, reason: string }.
 */
export function checkSafetyGuards(env = process.env) {
  // Guard 1: URL parse + allowlist
  const urlCheck = validateDatabaseUrl(env.DATABASE_URL);
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

function computeAuthHash(authKey) {
  return createHash("sha256").update(authKey).digest("hex");
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
  // Dev fallback: derive from ORG_MASTER_KEY
  const masterHex = process.env.ORG_MASTER_KEY;
  if (masterHex && masterHex.length === 64) {
    return createHash("sha256").update("verifier-pepper:").update(Buffer.from(masterHex, "hex")).digest();
  }
  throw new Error("VERIFIER_PEPPER_KEY or ORG_MASTER_KEY required for verifier HMAC");
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

// ─── Database Operations ───────────────────────────────────────

async function seedUsers(pool, userCount) {
  const now = new Date().toISOString();
  const credentials = [];

  console.log(`Generating vault crypto for ${userCount} users (PBKDF2 600k × 2 per user)...`);
  const startTime = Date.now();

  for (let i = 0; i < userCount; i++) {
    const userId = `lt-user-${i}`;
    const email = EMAIL_PATTERN.replace("{i}", String(i));
    const sessionToken = randomBytes(32).toString("hex");

    const crypto = setupVaultCrypto(DEFAULT_PASSPHRASE);

    // Insert user with vault fields
    await pool.query(
      `INSERT INTO users (
        id, email, name,
        email_verified, vault_setup_at, created_at, updated_at,
        account_salt, encrypted_secret_key, secret_key_iv, secret_key_auth_tag,
        master_password_server_hash, master_password_server_salt,
        passphrase_verifier_hmac, passphrase_verifier_version,
        key_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      ON CONFLICT (id) DO NOTHING`,
      [
        userId,
        email,
        `Load Test User ${i}`,
        now, now, now, now,
        crypto.accountSalt,
        crypto.encryptedSecretKey,
        crypto.secretKeyIv,
        crypto.secretKeyAuthTag,
        crypto.serverHash,
        crypto.serverSalt,
        crypto.verifierHmac,
        1,
        1,
      ],
    );

    // Insert session (raw token, same as Auth.js database strategy)
    // ON CONFLICT (id) handles re-seed: update token + expiry
    const expires = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO sessions (id, session_token, user_id, expires)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET session_token = $2, expires = $4`,
      [`lt-session-${userId}`, sessionToken, userId, expires.toISOString()],
    );

    // Insert vault key (verification artifact)
    await pool.query(
      `INSERT INTO vault_keys (id, user_id, version, verification_ciphertext, verification_iv, verification_auth_tag, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        `lt-vaultkey-${userId}`,
        userId,
        1,
        crypto.verificationArtifact.ciphertext,
        crypto.verificationArtifact.iv,
        crypto.verificationArtifact.authTag,
        now,
      ],
    );

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
    `SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local'`,
  );
  if (rows.length === 0) {
    console.log("No load test users found to clean up.");
    return;
  }

  const userIds = rows.map((r) => r.id);
  console.log(`Cleaning up ${userIds.length} load test users...`);

  // Delete in FK dependency order
  const tables = [
    { table: "audit_logs", column: "user_id" },
    { table: "attachments", column: "created_by_id" },
    { table: "password_shares", column: "created_by_id" },
    { table: "password_entries", column: "user_id" },
    { table: "tags", column: "user_id" },
    { table: "vault_keys", column: "user_id" },
    { table: "extension_tokens", column: "user_id" },
    { table: "sessions", column: "user_id" },
  ];

  for (const { table, column } of tables) {
    await pool.query(`DELETE FROM ${table} WHERE ${column} = ANY($1)`, [userIds]);
  }

  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
  console.log(`Cleaned up ${userIds.length} load test users.`);

  // Remove auth file
  if (existsSync(AUTH_FILE)) {
    unlinkSync(AUTH_FILE);
    console.log(`Removed ${AUTH_FILE}`);
  }
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
  if (!existsSync(AUTH_FILE)) {
    // Write the single user for smoke
    writeFileSync(AUTH_FILE, JSON.stringify(credentials, null, 2));
    chmodSync(AUTH_FILE, 0o600);
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

    // Write auth file
    writeFileSync(AUTH_FILE, JSON.stringify(credentials, null, 2));
    chmodSync(AUTH_FILE, 0o600);
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
    console.error("Seed failed:", err.message);
    console.error("\nManual cleanup SQL:");
    console.error("  DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local');");
    console.error("  DELETE FROM vault_keys WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'lt-user-%@loadtest.local');");
    console.error("  DELETE FROM users WHERE email LIKE 'lt-user-%@loadtest.local';");
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
