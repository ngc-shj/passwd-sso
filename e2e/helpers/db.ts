/**
 * Database helper for E2E test seeding and cleanup.
 *
 * Safety guards:
 * 1. DATABASE_URL must contain "test", "ci", "e2e", or "localhost"
 * 2. E2E_ALLOW_DB_MUTATION=true must be explicitly set
 * 3. All operations are scoped to emails matching 'e2e-%@test.local'
 *
 * IMPORTANT: Table/column names use the actual PostgreSQL names (snake_case)
 * as defined by @@map / @map in prisma/schema.prisma, NOT Prisma model names.
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
  /** Vault fully set up — general unlock/CRUD/lock/relock/locale tests */
  vaultReady: {
    id: "e2e-user-vault-ready",
    email: "e2e-vault-ready@test.local",
    name: "E2E Vault Ready",
  },
  /** No vault setup — setup wizard tests */
  fresh: {
    id: "e2e-user-fresh",
    email: "e2e-fresh@test.local",
    name: "E2E Fresh User",
  },
  /** Vault set up — dedicated to lockout test (destructive: triggers account lock) */
  lockout: {
    id: "e2e-user-lockout",
    email: "e2e-lockout@test.local",
    name: "E2E Lockout User",
  },
  /** Vault set up — dedicated to vault-reset test (destructive: deletes vault) */
  reset: {
    id: "e2e-user-reset",
    email: "e2e-reset@test.local",
    name: "E2E Reset User",
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
        options.id,
        options.email,
        options.name,
        now, // email_verified
        now, // vault_setup_at
        now, // created_at
        now, // updated_at
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
      `INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [options.id, options.email, options.name, now, now, now]
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
    `INSERT INTO sessions (id, session_token, user_id, expires)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_token) DO NOTHING`,
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
    `INSERT INTO vault_keys (
      id, user_id, version,
      verification_ciphertext, verification_iv, verification_auth_tag,
      created_at
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
 *
 * Table/column mapping (Prisma model → PostgreSQL):
 *   AuditLog     → audit_logs       (user_id)
 *   Attachment   → attachments      (created_by_id)
 *   PasswordShare→ password_shares  (created_by_id)
 *   PasswordEntry→ password_entries (user_id)
 *   Tag          → tags             (user_id)
 *   VaultKey     → vault_keys       (user_id)
 *   ExtensionToken→ extension_tokens(user_id)
 *   Session      → sessions         (user_id)
 *   User         → users
 */
export async function cleanup(): Promise<void> {
  const p = getPool();

  // Find e2e user IDs
  const { rows } = await p.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE 'e2e-%@test.local'`
  );
  if (rows.length === 0) return;

  const userIds = rows.map((r) => r.id);

  // Delete in FK dependency order (children → parents)
  const deletions: Array<{ table: string; column: string }> = [
    { table: "audit_logs", column: "user_id" },
    { table: "attachments", column: "created_by_id" },
    { table: "password_shares", column: "created_by_id" },
    { table: "password_entries", column: "user_id" },
    { table: "tags", column: "user_id" },
    { table: "vault_keys", column: "user_id" },
    { table: "extension_tokens", column: "user_id" },
    { table: "sessions", column: "user_id" },
  ];

  for (const { table, column } of deletions) {
    await p.query(
      `DELETE FROM ${table} WHERE ${column} = ANY($1)`,
      [userIds]
    );
  }

  // Delete the users themselves
  await p.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);
}
