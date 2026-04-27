import type { Namespace } from "./messages";

/** Namespaces needed by every page (error boundary, dialogs, language switcher). */
export const NS_GLOBAL: readonly Namespace[] = [
  "Common",
  "NotFound",
  "Error",
  "LanguageSwitcher",
  "SearchBar",
  "ApiErrors",
];

/** Namespaces needed by the vault gate and header (auth / unlock). */
export const NS_VAULT: readonly Namespace[] = ["Vault", "Extension", "Auth"];

/**
 * Namespaces used across dashboard pages.
 *
 * Includes feature-specific namespaces (Watchtower, Import, Export, etc.)
 * so that Phase 2 works without Phase 3 per-page layouts.
 * Phase 3 can move these to dedicated layouts for further optimisation.
 */
export const NS_DASHBOARD_CORE: readonly Namespace[] = [
  "Dashboard",
  "Team",
  "Teams",
  "Tag",
  "Shortcuts",
  "CopyButton",
  "PasswordCard",
  "PasswordList",
  "RepromptDialog",
  "PasswordDetail",
  "PasswordForm",
  "PasswordGenerator",
  "SecureNoteForm",
  "CreditCardForm",
  "IdentityForm",
  "PasskeyForm",
  "BankAccountForm",
  "SoftwareLicenseForm",
  "SshKeyForm",
  "Trash",
  "TOTP",
  "Attachments",
  "Share",
  // Feature-specific — included here to guarantee all pages work.
  "Watchtower",
  "Import",
  "Export",
  "AuditLog",
  "EmergencyAccess",
  "ShareLinks",
  "Sessions",
  "Notifications",
  "TeamPolicy",
  "TeamWebhook",
  "TenantWebhook",
  "AuditDownload",
  "CliToken",
  "TenantAdmin",
  "ApiKey",
  "TravelMode",
  "WebAuthn",
  "DirectorySync",
  "Breakglass",
  "MachineIdentity",
];

/** Union of all dashboard namespaces (must be a superset of NS_GLOBAL). */
export const NS_DASHBOARD_ALL: readonly Namespace[] = [
  ...NS_GLOBAL,
  ...NS_VAULT,
  ...NS_DASHBOARD_CORE,
];

/** Namespaces needed by admin console pages. */
export const NS_ADMIN_ALL: readonly Namespace[] = [
  ...NS_GLOBAL,
  "Vault",
  "AdminConsole",
  "TenantAdmin",
  "TenantWebhook",
  "MachineIdentity",
  "DirectorySync",
  "AuditLog",
  "AuditDownload",
  "Team",
  "Teams",
  "TeamPolicy",
  "TeamWebhook",
  "Sessions",
  "Breakglass",
  "CopyButton",
  "AuditDeliveryTarget",
  "OperatorToken",
];

/**
 * Whitelist for the unauthenticated share page (/s/).
 * Keep minimal to avoid leaking internal feature names.
 */
export const NS_PUBLIC_SHARE: readonly Namespace[] = [
  "Common",
  "Share",
  "CopyButton",
];

/** Recovery page namespaces. */
export const NS_RECOVERY: readonly Namespace[] = [
  ...NS_GLOBAL,
  "Recovery",
  "Vault",
];

/** Vault reset page namespaces. */
export const NS_VAULT_RESET: readonly Namespace[] = [
  ...NS_GLOBAL,
  "VaultReset",
];

/** Privacy policy page namespaces. */
export const NS_PRIVACY_POLICY: readonly Namespace[] = [
  ...NS_GLOBAL,
  "PrivacyPolicy",
];

/** MCP OAuth consent page namespaces. */
export const NS_MCP_CONSENT: readonly Namespace[] = ["McpConsent"];
