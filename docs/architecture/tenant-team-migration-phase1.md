# Tenant/Team Migration Phase 1 (Additive)

## Goal

Introduce `Tenant` as the top-level boundary while keeping current behavior intact.
Current `Organization` is treated as `Team` in product terms, but DB table remains `organizations` during migration.

This phase is additive-only:
- no destructive changes
- no renames
- no NOT NULL enforcement on new tenant columns yet

## Scope

1. Add `tenants` table
2. Add `tenant_members` table (tenant-level role)
3. Add nullable `tenant_id` to tenant-scoped tables
4. Keep existing `org_id`-based constraints for compatibility

## Prisma Draft (Phase 1)

```prisma
// New enum

enum TenantRole {
  OWNER
  ADMIN
  MEMBER
}

// New top-level tenant

model Tenant {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique
  description String?  @db.Text
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  organizations         Organization[]
  members               TenantMember[]
  scimTokens            ScimToken[]
  scimExternalMappings  ScimExternalMapping[]

  @@map("tenants")
}

model TenantMember {
  id        String     @id @default(cuid())
  tenantId  String     @map("tenant_id")
  userId    String     @map("user_id")
  role      TenantRole @default(MEMBER)
  createdAt DateTime   @default(now()) @map("created_at")
  updatedAt DateTime   @updatedAt @map("updated_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([tenantId, userId])
  @@index([userId])
  @@map("tenant_members")
}

// Existing model updates (nullable in Phase 1)

model Organization {
  // ...existing fields...
  tenantId String? @map("tenant_id")
  tenant   Tenant? @relation(fields: [tenantId], references: [id], onDelete: SetNull)

  @@index([tenantId])
  @@map("organizations")
}

model ScimToken {
  // ...existing fields...
  tenantId String? @map("tenant_id")
  tenant   Tenant? @relation(fields: [tenantId], references: [id], onDelete: SetNull)

  @@index([tenantId, revokedAt])
  @@map("scim_tokens")
}

model ScimExternalMapping {
  // ...existing fields...
  tenantId String? @map("tenant_id")
  tenant   Tenant? @relation(fields: [tenantId], references: [id], onDelete: SetNull)

  @@index([tenantId, resourceType])
  @@map("scim_external_mappings")
}
```

Notes:
- Keep current `org_id` unique constraints in `ScimExternalMapping` during Phase 1.
- In later phases, switch constraints to tenant-aware keys after backfill and application cutover.

## SQL Draft (Phase 1 Additive)

A full SQL draft is provided in:

- `docs/architecture/tenant-team-phase1-additive.sql`

## Backfill Plan (next phase)

1. Create one tenant per existing organization (initially 1 org = 1 tenant)
2. Backfill:
   - `organizations.tenant_id`
   - `scim_tokens.tenant_id`
   - `scim_external_mappings.tenant_id`
3. Backfill `tenant_members` from current org owners/admins (policy to be confirmed)

## Validation Queries (after backfill)

- `tenant_id` null checks on migrated tables
- orphan checks (`tenant_id` without parent tenant)
- duplicate checks for planned tenant-level unique constraints

## Out of Scope (Phase 1)

- API path changes (`/tenants/:tenantId/...`)
- RLS enablement
- dropping old constraints/columns
- renaming `organizations` table
