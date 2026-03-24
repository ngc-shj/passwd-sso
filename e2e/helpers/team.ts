/**
 * Database helper for seeding Team and TeamMember rows in E2E tests.
 */
import { E2E_TENANT, getPool } from "./db";

export interface SeedTeamOptions {
  id: string;
  tenantId?: string;
  name: string;
  slug: string;
  /** The user who creates the team (will also be added as OWNER via seedTeamMember) */
  createdById: string;
}

export async function seedTeam(options: SeedTeamOptions): Promise<void> {
  const p = getPool();
  const tenantId = options.tenantId ?? E2E_TENANT.id;
  const now = new Date().toISOString();

  await p.query(
    `INSERT INTO teams (id, tenant_id, name, slug, team_key_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       name = EXCLUDED.name,
       slug = EXCLUDED.slug,
       team_key_version = EXCLUDED.team_key_version,
       updated_at = EXCLUDED.updated_at`,
    [options.id, tenantId, options.name, options.slug, 1, now, now]
  );
}

export interface SeedTeamMemberOptions {
  teamId: string;
  userId: string;
  tenantId?: string;
  role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
}

export async function seedTeamMember(
  options: SeedTeamMemberOptions
): Promise<void> {
  const p = getPool();
  const tenantId = options.tenantId ?? E2E_TENANT.id;
  const now = new Date().toISOString();

  await p.query(
    `INSERT INTO team_members (id, team_id, user_id, tenant_id, role, key_distributed, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (team_id, user_id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       role = EXCLUDED.role,
       key_distributed = EXCLUDED.key_distributed,
       updated_at = EXCLUDED.updated_at`,
    [
      crypto.randomUUID(),
      options.teamId,
      options.userId,
      tenantId,
      options.role,
      false, // key_distributed — full key exchange handled by the app
      now,
      now,
    ]
  );
}
