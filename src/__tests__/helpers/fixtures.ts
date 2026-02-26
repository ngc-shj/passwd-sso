import { TEAM_ROLE, INVITATION_STATUS } from "@/lib/constants";
/**
 * Test data factories for creating mock database records.
 */

export function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-user-id",
    name: "Test User",
    email: "user@example.com",
    image: null,
    vaultSetupAt: null as Date | null,
    accountSalt: null as string | null,
    encryptedSecretKey: null as string | null,
    secretKeyIv: null as string | null,
    secretKeyAuthTag: null as string | null,
    masterPasswordServerHash: null as string | null,
    masterPasswordServerSalt: null as string | null,
    keyVersion: 0,
    ...overrides,
  };
}

export function makePasswordEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "pwd-1",
    encryptedBlob: "blob-cipher",
    blobIv: "a".repeat(24),
    blobAuthTag: "b".repeat(32),
    encryptedOverview: "overview-cipher",
    overviewIv: "c".repeat(24),
    overviewAuthTag: "d".repeat(32),
    keyVersion: 1,
    isFavorite: false,
    isArchived: false,
    deletedAt: null as Date | null,
    expiresAt: null as Date | null,
    userId: "test-user-id",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    tags: [] as { id: string }[],
    ...overrides,
  };
}

export function makeTag(overrides: Record<string, unknown> = {}) {
  return {
    id: "tag-1",
    name: "Work",
    color: "#ff0000",
    userId: "test-user-id",
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { passwords: 5 },
    ...overrides,
  };
}

export function makeOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: "team-1",
    name: "Test Team",
    slug: "test-team",
    description: "A test team",
    encryptedTeamKey: "encrypted-key",
    teamKeyIv: "e".repeat(24),
    teamKeyAuthTag: "f".repeat(32),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeTeamMember(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    teamId: "team-1",
    userId: "test-user-id",
    role: TEAM_ROLE.OWNER,
    createdAt: new Date(),
    updatedAt: new Date(),
    user: {
      id: "test-user-id",
      name: "Test User",
      email: "user@example.com",
      image: null,
    },
    ...overrides,
  };
}

export function makeTeamPasswordEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "team-pwd-1",
    encryptedBlob: "team-blob-cipher",
    blobIv: "a".repeat(24),
    blobAuthTag: "b".repeat(32),
    encryptedOverview: "team-overview-cipher",
    overviewIv: "c".repeat(24),
    overviewAuthTag: "d".repeat(32),
    isFavorite: false,
    isArchived: false,
    deletedAt: null as Date | null,
    teamId: "team-1",
    createdById: "test-user-id",
    updatedById: "test-user-id",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    tags: [] as { id: string; name: string; color: string | null }[],
    createdBy: { id: "test-user-id", name: "Test User" },
    updatedBy: { id: "test-user-id", name: "Test User" },
    favorites: [] as { userId: string }[],
    ...overrides,
  };
}

export function makeTeamInvitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    teamId: "team-1",
    email: "invited@example.com",
    role: TEAM_ROLE.MEMBER,
    status: INVITATION_STATUS.PENDING,
    token: "token-abc-123",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    invitedById: "test-user-id",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function makeOrgTag(overrides: Record<string, unknown> = {}) {
  return {
    id: "team-tag-1",
    name: "Production",
    color: "#00ff00",
    teamId: "team-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    _count: { passwords: 3 },
    ...overrides,
  };
}