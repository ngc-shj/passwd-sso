/**
 * Database helper for E2E test seeding and cleanup.
 *
 * Safety guards:
 * 1. DATABASE_URL must contain "test", "ci", "e2e", or "localhost"
 * 2. E2E_ALLOW_DB_MUTATION=true must be explicitly set
 * 3. All operations are scoped to emails matching 'e2e-%@test.local'
 */
import pg from "pg";

// ─── Safety Guards ──────────────────────────────────────────────

export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!/\b(test|ci|e2e|localhost)\b/i.test(url)) {
    throw new Error(
      `E2E tests require a test/CI database. Current DATABASE_URL does not match safety pattern. Aborting.`
    );
  }
  if (process.env.E2E_ALLOW_DB_MUTATION !== "true") {
    throw new Error(
      "Set E2E_ALLOW_DB_MUTATION=true to confirm E2E DB writes."
    );
  }
}

// ─── Pool Management ────────────────────────────────────────────

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ─── Test User Constants ────────────────────────────────────────

export const TEST_USERS = {
  vaultReady: {
    id: "e2e-user-vault-ready",
    email: "e2e-vault-ready@test.local",
    name: "E2E Vault Ready",
  },
  fresh: {
    id: "e2e-user-fresh",
    email: "e2e-fresh@test.local",
    name: "E2E Fresh User",
  },
} as const;

export const TEST_PASSPHRASE = "E2ETestPassphrase!2026";

// ─── Seeding ────────────────────────────────────────────────────

export interface SeedUserOptions {
  id: string;
  email: string;
  name: string;
  vaultFields?: {
    accountSalt: string;
    encryptedSecretKey: string;
    secretKeyIv: string;
    secretKeyAuthTag: string;
    masterPasswordServerHash: string;
    masterPasswordServerSalt: string;
    passphraseVerifierHmac: string;
    keyVersion: number;
  };
}

export async function seedUser(options: SeedUserOptions): Promise<void> {
  const p = getPool();
  const now = new Date().toISOString();

  if (options.vaultFields) {
    const v = options.vaultFields;
    await p.query(
      `INSERT INTO "User" (
        id, email, name,
        "emailVerified", "vaultSetupAt",
        "accountSalt", "encryptedSecretKey", "secretKeyIv", "secretKeyAuthTag",
        "masterPasswordServerHash", "masterPasswordServerSalt",
        "passphraseVerifierHmac", "passphraseVerifierVersion",
        "keyVersion"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO NOTHING`,
      [
        options.id,
        options.email,
        options.name,
        now,
        now,
        v.accountSalt,
        v.encryptedSecretKey,
        v.secretKeyIv,
        v.secretKeyAuthTag,
        v.masterPasswordServerHash,
        v.masterPasswordServerSalt,
        v.passphraseVerifierHmac,
        1, // verifier version
        v.keyVersion,
      ]
    );
  } else {
    await p.query(
      `INSERT INTO "User" (id, email, name, "emailVerified")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [options.id, options.email, options.name, now]
    );
  }
}

export async function seedSession(
  userId: string,
  sessionToken: string,
  expiresHours = 8
): Promise<void> {
  const p = getPool();
  const expires = new Date(Date.now() + expiresHours * 60 * 60 * 1000);
  await p.query(
    `INSERT INTO "Session" (id, "sessionToken", "userId", expires)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ("sessionToken") DO NOTHING`,
    [
      `e2e-session-${userId}`,
      sessionToken,
      userId,
      expires.toISOString(),
    ]
  );
}

export async function seedVaultKey(
  userId: string,
  verificationArtifact: {
    ciphertext: string;
    iv: string;
    authTag: string;
  }
): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO "VaultKey" (
      id, "userId", version,
      "verificationCiphertext", "verificationIv", "verificationAuthTag",
      "createdAt"
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO NOTHING`,
    [
      `e2e-vaultkey-${userId}`,
      userId,
      1,
      verificationArtifact.ciphertext,
      verificationArtifact.iv,
      verificationArtifact.authTag,
      new Date().toISOString(),
    ]
  );
}

// ─── Cleanup ────────────────────────────────────────────────────

/**
 * Delete all E2E test data. Scoped to e2e-%@test.local users only.
 * Order follows FK dependencies (children first).
 */
export async function cleanup(): Promise<void> {
  const p = getPool();

  // Find e2e user IDs
  const { rows } = await p.query<{ id: string }>(
    `SELECT id FROM "User" WHERE email LIKE 'e2e-%@test.local'`
  );
  if (rows.length === 0) return;

  const userIds = rows.map((r) => r.id);

  // Delete in FK dependency order
  for (const table of [
    "AuditLog",
    "Attachment",
    "PasswordShare",
    "PasswordEntry",
    "Tag",
    "VaultKey",
    "Session",
  ]) {
    const col = table === "PasswordShare" ? "createdById" : "userId";
    await p.query(
      `DELETE FROM "${table}" WHERE "${col}" = ANY($1)`,
      [userIds]
    );
  }

  // Delete the users themselves
  await p.query(
    `DELETE FROM "User" WHERE id = ANY($1)`,
    [userIds]
  );
}
