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

// ─── Test Tenant Constant ────────────────────────────────────────

export const E2E_TENANT = {
  id: "00000000-0000-4000-a000-00000000e2e0",
  name: "E2E Test Tenant",
  slug: "e2e-test-tenant",
} as const;

// ─── Test User Constants ────────────────────────────────────────

export const TEST_USERS = {
  /** Vault fully set up — general unlock/CRUD/lock/relock/locale tests */
  vaultReady: {
    id: "00000000-0000-4000-e2e0-000000000001",
    email: "e2e-vault-ready@test.local",
    name: "E2E Vault Ready",
  },
  /** No vault setup — setup wizard tests */
  fresh: {
    id: "00000000-0000-4000-e2e0-000000000002",
    email: "e2e-fresh@test.local",
    name: "E2E Fresh User",
  },
  /** Vault set up — dedicated to lockout test (destructive: triggers account lock) */
  lockout: {
    id: "00000000-0000-4000-e2e0-000000000003",
    email: "e2e-lockout@test.local",
    name: "E2E Lockout User",
  },
  /** Vault set up — dedicated to vault-reset test (destructive: deletes vault) */
  reset: {
    id: "00000000-0000-4000-e2e0-000000000004",
    email: "e2e-reset@test.local",
    name: "E2E Reset User",
  },
  /** Vault set up — dedicated to vault-reset validation test (non-destructive) */
  resetValidation: {
    id: "00000000-0000-4000-e2e0-000000000005",
    email: "e2e-reset-validation@test.local",
    name: "E2E Reset Validation User",
  },
  /** Vault set up — team owner for team tests */
  teamOwner: {
    id: "00000000-0000-4000-e2e0-000000000006",
    email: "e2e-team-owner@test.local",
    name: "E2E Team Owner",
  },
  /** Vault set up — team member for invitation tests */
  teamMember: {
    id: "00000000-0000-4000-e2e0-000000000007",
    email: "e2e-team-member@test.local",
    name: "E2E Team Member",
  },
  /** Vault set up — emergency access grantor */
  eaGrantor: {
    id: "00000000-0000-4000-e2e0-000000000008",
    email: "e2e-ea-grantor@test.local",
    name: "E2E EA Grantor",
  },
  /** Vault set up — emergency access grantee */
  eaGrantee: {
    id: "00000000-0000-4000-e2e0-000000000009",
    email: "e2e-ea-grantee@test.local",
    name: "E2E EA Grantee",
  },
  /** Vault set up — tenant admin with ADMIN role */
  tenantAdmin: {
    id: "00000000-0000-4000-e2e0-00000000000a",
    email: "e2e-tenant-admin@test.local",
    name: "E2E Tenant Admin",
  },
  /** Vault set up — dedicated to passphrase change test (destructive) */
  passphraseChange: {
    id: "00000000-0000-4000-e2e0-00000000000b",
    email: "e2e-passphrase-change@test.local",
    name: "E2E Passphrase Change",
  },
  /** Vault set up — dedicated to key rotation test (destructive) */
  keyRotation: {
    id: "00000000-0000-4000-e2e0-00000000000c",
    email: "e2e-key-rotation@test.local",
    name: "E2E Key Rotation",
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

export async function seedTenant(): Promise<void> {
  const p = getPool();
  const now = new Date().toISOString();
  await p.query(
    `INSERT INTO tenants (id, name, slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, updated_at = EXCLUDED.updated_at`,
    [E2E_TENANT.id, E2E_TENANT.name, E2E_TENANT.slug, now, now]
  );
}

export async function seedTenantMember(
  userId: string,
  role: "OWNER" | "ADMIN" | "MEMBER" = "MEMBER"
): Promise<void> {
  const p = getPool();
  const now = new Date().toISOString();
  await p.query(
    `INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = EXCLUDED.updated_at`,
    [crypto.randomUUID(), E2E_TENANT.id, userId, role, now, now]
  );
}

export async function seedUser(options: SeedUserOptions): Promise<void> {
  const p = getPool();
  const now = new Date().toISOString();

  if (options.vaultFields) {
    const v = options.vaultFields;
    await p.query(
      `INSERT INTO users (
        id, email, name,
        tenant_id, email_verified, vault_setup_at, created_at, updated_at,
        account_salt, encrypted_secret_key, secret_key_iv, secret_key_auth_tag,
        master_password_server_hash, master_password_server_salt,
        passphrase_verifier_hmac, passphrase_verifier_version,
        key_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        tenant_id = EXCLUDED.tenant_id,
        email_verified = EXCLUDED.email_verified,
        vault_setup_at = EXCLUDED.vault_setup_at,
        updated_at = EXCLUDED.updated_at,
        account_salt = EXCLUDED.account_salt,
        encrypted_secret_key = EXCLUDED.encrypted_secret_key,
        secret_key_iv = EXCLUDED.secret_key_iv,
        secret_key_auth_tag = EXCLUDED.secret_key_auth_tag,
        master_password_server_hash = EXCLUDED.master_password_server_hash,
        master_password_server_salt = EXCLUDED.master_password_server_salt,
        passphrase_verifier_hmac = EXCLUDED.passphrase_verifier_hmac,
        passphrase_verifier_version = EXCLUDED.passphrase_verifier_version,
        key_version = EXCLUDED.key_version`,
      [
        options.id,
        options.email,
        options.name,
        E2E_TENANT.id,
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
      `INSERT INTO users (id, email, name, tenant_id, email_verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         tenant_id = EXCLUDED.tenant_id,
         email_verified = EXCLUDED.email_verified,
         updated_at = EXCLUDED.updated_at`,
      [options.id, options.email, options.name, E2E_TENANT.id, now, now, now]
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
    `INSERT INTO sessions (id, session_token, user_id, tenant_id, expires)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_token) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       tenant_id = EXCLUDED.tenant_id,
       expires = EXCLUDED.expires`,
    [
      crypto.randomUUID(),
      sessionToken,
      userId,
      E2E_TENANT.id,
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
      id, user_id, tenant_id, version,
      verification_ciphertext, verification_iv, verification_auth_tag,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (user_id, version) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      verification_ciphertext = EXCLUDED.verification_ciphertext,
      verification_iv = EXCLUDED.verification_iv,
      verification_auth_tag = EXCLUDED.verification_auth_tag`,
    [
      crypto.randomUUID(),
      userId,
      E2E_TENANT.id,
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
 *   PersonalLogAccessGrant → personal_log_access_grants (requester_id, target_user_id) — onDelete: Restrict
 *   WebAuthnCredential     → webauthn_credentials       (user_id)
 *   PasswordEntryHistory   → password_entry_histories   (entry_id via password_entries)
 *   TeamPasswordEntryHistory→team_password_entry_histories (entry_id via team_password_entries)
 *   TeamPasswordEntry      → team_password_entries      (team_id)
 *   TeamTag                → team_tags                  (team_id)
 *   TeamFolder             → team_folders               (team_id)
 *   TeamMemberKey          → team_member_keys           (team_id)
 *   TeamInvitation         → team_invitations           (team_id)
 *   TeamMember             → team_members               (team_id)
 *   Team                   → teams                      (tenant_id)
 *   EmergencyAccessGrant   → emergency_access_grants    (owner_id, grantee_id)
 *   ApiKey                 → api_keys                   (user_id)
 *   Notification           → notifications              (user_id)
 *   Folder                 → folders                    (user_id)
 *   AuditLog               → audit_logs                 (user_id)
 *   Attachment             → attachments                (created_by_id)
 *   PasswordShare          → password_shares            (created_by_id)
 *   PasswordEntry          → password_entries           (user_id)
 *   Tag                    → tags                       (user_id)
 *   VaultKey               → vault_keys                 (user_id)
 *   ExtensionToken         → extension_tokens           (user_id)
 *   Session                → sessions                   (user_id)
 *   User                   → users
 *   TenantMember           → tenant_members             (tenant_id)
 *   Tenant                 → tenants
 */
export async function cleanup(): Promise<void> {
  const p = getPool();

  // Find e2e user IDs
  const { rows } = await p.query<{ id: string }>(
    `SELECT id FROM users WHERE email LIKE 'e2e-%@test.local'`
  );
  if (rows.length === 0) {
    // Still clean up tenant even if no users found
    await p.query(
      `DELETE FROM tenant_members WHERE tenant_id = $1`,
      [E2E_TENANT.id]
    );
    await p.query(`DELETE FROM tenants WHERE id = $1`, [E2E_TENANT.id]);
    return;
  }

  const userIds = rows.map((r) => r.id);

  // Phase 1: Leaf tables with onDelete: Restrict (must delete before users)
  await p.query(
    `DELETE FROM personal_log_access_grants WHERE requester_id = ANY($1) OR target_user_id = ANY($1)`,
    [userIds]
  );
  await p.query(
    `DELETE FROM webauthn_credentials WHERE user_id = ANY($1)`,
    [userIds]
  );

  // Phase 1b: Team tables — find all teams belonging to the E2E tenant, then delete children
  const { rows: teamRows } = await p.query<{ id: string }>(
    `SELECT id FROM teams WHERE tenant_id = $1`,
    [E2E_TENANT.id]
  );
  if (teamRows.length > 0) {
    const teamIds = teamRows.map((r) => r.id);
    await p.query(
      `DELETE FROM team_password_entry_histories WHERE entry_id IN (
        SELECT id FROM team_password_entries WHERE team_id = ANY($1)
      )`,
      [teamIds]
    );
    await p.query(
      `DELETE FROM team_password_entries WHERE team_id = ANY($1)`,
      [teamIds]
    );
    await p.query(`DELETE FROM team_tags WHERE team_id = ANY($1)`, [teamIds]);
    await p.query(
      `DELETE FROM team_folders WHERE team_id = ANY($1)`,
      [teamIds]
    );
    await p.query(
      `DELETE FROM team_member_keys WHERE team_id = ANY($1)`,
      [teamIds]
    );
    await p.query(
      `DELETE FROM team_invitations WHERE team_id = ANY($1)`,
      [teamIds]
    );
    await p.query(
      `DELETE FROM team_members WHERE team_id = ANY($1)`,
      [teamIds]
    );
  }
  await p.query(`DELETE FROM teams WHERE tenant_id = $1`, [E2E_TENANT.id]);

  // Phase 1c: Other user-scoped tables
  await p.query(
    `DELETE FROM emergency_access_grants WHERE owner_id = ANY($1) OR grantee_id = ANY($1)`,
    [userIds]
  );
  await p.query(`DELETE FROM api_keys WHERE user_id = ANY($1)`, [userIds]);
  await p.query(`DELETE FROM notifications WHERE user_id = ANY($1)`, [userIds]);
  await p.query(`DELETE FROM folders WHERE user_id = ANY($1)`, [userIds]);

  // Phase 2: Existing cleanup (FK dependency order)
  // password_entry_histories references password_entries, must delete first
  await p.query(
    `DELETE FROM password_entry_histories WHERE entry_id IN (
      SELECT id FROM password_entries WHERE user_id = ANY($1)
    )`,
    [userIds]
  );

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

  // Phase 3: Delete users
  await p.query(`DELETE FROM users WHERE id = ANY($1)`, [userIds]);

  // Phase 4: Tenant cleanup
  await p.query(
    `DELETE FROM tenant_members WHERE tenant_id = $1`,
    [E2E_TENANT.id]
  );
  await p.query(`DELETE FROM tenants WHERE id = $1`, [E2E_TENANT.id]);
}
