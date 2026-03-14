/**
 * Scope-specific configuration for unified form hooks.
 * Uses discriminated union to prevent cross-scope misuse at compile time.
 */

// Personal scope: client-side encryption
interface PersonalScopeConfig {
  scope: "personal";
  // Personal vault encryption key — NEVER available in team scope
  encryptionKey: CryptoKey;
  userId: string;
  tagType: "personal";
  folderField: "folderId";
}

// Team scope: server-side encryption via submitEntry callback
interface TeamScopeConfig {
  scope: "team";
  teamId: string;
  // Team submit does NOT receive encryptionKey — encryption handled server-side
  tagType: "team";
  folderField: "teamFolderId";
}

export type FormScopeConfig = PersonalScopeConfig | TeamScopeConfig;

// Type guard helpers
export function isPersonalScope(
  config: FormScopeConfig,
): config is PersonalScopeConfig {
  return config.scope === "personal";
}

export function isTeamScope(config: FormScopeConfig): config is TeamScopeConfig {
  return config.scope === "team";
}
