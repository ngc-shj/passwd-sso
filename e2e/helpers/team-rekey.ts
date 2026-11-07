/**
 * Database helpers for E2E specs of the team re-key pass
 * (docs/archive/review/team-key-rotation-rekey-plan.md A8): a team at a given
 * key version, member-key rows for its holders, and an entry pending re-key.
 *
 * The ciphertext is opaque random hex: the routes these specs reach never
 * decrypt, and a refusal before any write needs no key that opens anything.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { E2E_TENANT, getPool } from "./db";

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export interface SeedTeamAtKeyVersionOptions {
  id: string;
  name: string;
  slug: string;
  teamKeyVersion: number;
  tenantId?: string;
}

export async function seedTeamAtKeyVersion(options: SeedTeamAtKeyVersionOptions): Promise<void> {
  if (!Number.isInteger(options.teamKeyVersion) || options.teamKeyVersion < 1) {
    throw new Error(`teamKeyVersion must be a positive integer, got ${options.teamKeyVersion}`);
  }
  await getPool().query(
    `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [options.id, options.tenantId ?? E2E_TENANT.id, options.name, options.slug, options.teamKeyVersion],
  );
}

export interface SeedTeamKeyHolderOptions {
  teamId: string;
  userId: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
  /** Team key versions the member holds a member-key row for. */
  keyVersions: number[];
  tenantId?: string;
}

/** An active, key-distributed member with one member-key row per version. */
export async function seedTeamKeyHolder(options: SeedTeamKeyHolderOptions): Promise<void> {
  const p = getPool();
  const tenantId = options.tenantId ?? E2E_TENANT.id;
  await p.query(
    `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, true, now(), now())`,
    [randomUUID(), options.teamId, options.userId, tenantId, options.role],
  );
  for (const keyVersion of options.keyVersions) {
    await p.query(
      `INSERT INTO team_member_keys (
         id, team_id, tenant_id, user_id, encrypted_team_key, team_key_iv, team_key_auth_tag,
         ephemeral_public_key, hkdf_salt, key_version, wrap_version, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, now(), now())`,
      [randomUUID(), options.teamId, tenantId, options.userId, hex(32), hex(12), hex(16), hex(32), hex(32), keyVersion],
    );
  }
}

export interface SeedPendingTeamEntryOptions {
  teamId: string;
  createdById: string;
  /** The team key version the entry's ItemKey wrap is under. */
  teamKeyVersion: number;
  /** item_key_team_key_version: the team key version its ItemKey was created at (< the team's). */
  itemKeyCreatedAt: number;
  tenantId?: string;
}

export interface SeededPendingTeamEntry {
  id: string;
  blobIv: string;
  overviewIv: string;
  itemKeyIv: string;
  itemKeyVersion: number;
}

/** A v1 entry whose ItemKey predates `teamKeyVersion` of its team: pending re-key. */
export async function seedPendingTeamEntry(options: SeedPendingTeamEntryOptions): Promise<SeededPendingTeamEntry> {
  if (options.itemKeyCreatedAt >= options.teamKeyVersion) {
    throw new Error("a pending entry's ItemKey must predate the team key version");
  }
  const entry: SeededPendingTeamEntry = {
    id: randomUUID(),
    blobIv: hex(12),
    overviewIv: hex(12),
    itemKeyIv: hex(12),
    itemKeyVersion: 1,
  };
  await getPool().query(
    `INSERT INTO team_password_entries (
       id, team_id, tenant_id, created_by_id, updated_by_id,
       encrypted_blob, blob_iv, blob_auth_tag, encrypted_overview, overview_iv, overview_auth_tag,
       aad_version, team_key_version, item_key_version,
       encrypted_item_key, item_key_iv, item_key_auth_tag,
       item_key_id, item_key_team_key_version, item_key_version_high_water,
       entry_type, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $4,
       $5, $6, $7, $8, $9, $10,
       1, $11, $12, $13, $14, $15, $16, $17, $12, 'LOGIN', now(), now()
     )`,
    [
      entry.id, options.teamId, options.tenantId ?? E2E_TENANT.id, options.createdById,
      hex(64), entry.blobIv, hex(16), hex(64), entry.overviewIv, hex(16),
      options.teamKeyVersion, entry.itemKeyVersion,
      hex(48), entry.itemKeyIv, hex(16), randomUUID(), options.itemKeyCreatedAt,
    ],
  );
  return entry;
}

/** Remove a team seeded by these helpers with its entries, history, members and keys. */
export async function deleteSeededTeam(teamId: string): Promise<void> {
  const p = getPool();
  await p.query(
    `DELETE FROM team_password_entry_histories WHERE entry_id IN (SELECT id FROM team_password_entries WHERE team_id = $1)`,
    [teamId],
  );
  await p.query(`DELETE FROM team_password_entries WHERE team_id = $1`, [teamId]);
  await p.query(`DELETE FROM team_member_keys WHERE team_id = $1`, [teamId]);
  await p.query(`DELETE FROM team_members WHERE team_id = $1`, [teamId]);
  await p.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
}
