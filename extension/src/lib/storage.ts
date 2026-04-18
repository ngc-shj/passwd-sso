export const Theme = { LIGHT: "light", DARK: "dark", SYSTEM: "system" } as const;
export type Theme = (typeof Theme)[keyof typeof Theme];

export const TimeoutAction = { LOCK: "lock", LOGOUT: "logout" } as const;
export type TimeoutAction = (typeof TimeoutAction)[keyof typeof TimeoutAction];

export const CLIPBOARD_CLEAR_OPTIONS = [10, 20, 30, 60, 120, 300] as const;

/** Keys stored in chrome.storage.local (settings only — never secrets) */
export interface StorageSchema {
  /** Base URL of the passwd-sso web app */
  serverUrl: string;
  /** Auto-lock timeout in minutes (0 = disabled) */
  autoLockMinutes: number;
  /** UI theme */
  theme: Theme;
  /** Show per-tab match count badge on extension icon */
  showBadgeCount: boolean;
  /** Show inline suggestion dropdown on form focus */
  enableInlineSuggestions: boolean;
  /** Show right-click context menu autofill entries */
  enableContextMenu: boolean;
  /** Auto-copy TOTP code to clipboard after autofilling a login */
  autoCopyTotp: boolean;
  /** Show save login banner on new credential detection */
  showSavePrompt: boolean;
  /** Show update password banner on password change detection */
  showUpdatePrompt: boolean;
  /** Clipboard auto-clear delay in seconds */
  clipboardClearSeconds: number;
  /** What to do when vault timeout fires */
  vaultTimeoutAction: TimeoutAction;
}

export const DEFAULTS: StorageSchema = {
  serverUrl: "https://localhost:3000",
  autoLockMinutes: 15,
  theme: Theme.SYSTEM,
  showBadgeCount: true,
  enableInlineSuggestions: true,
  enableContextMenu: true,
  autoCopyTotp: true,
  showSavePrompt: true,
  showUpdatePrompt: true,
  clipboardClearSeconds: 30,
  vaultTimeoutAction: TimeoutAction.LOCK,
};

const VALID_THEMES = Object.values(Theme) as readonly string[];
const VALID_CLIPBOARD_SECONDS: readonly number[] = CLIPBOARD_CLEAR_OPTIONS;
const VALID_TIMEOUT_ACTIONS = Object.values(TimeoutAction) as readonly string[];

function ensureBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function ensureFiniteNonNeg(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/**
 * Clamp a stored auto-lock value to the new 5-minute minimum.
 * Legacy extensions may have persisted 0 ("never") or 1-4 minutes; those
 * values are no longer valid (vault must auto-lock within the token/session
 * idle window). Clamps upward instead of silently falling back to the default.
 */
function ensureAutoLockAtLeastMin(v: unknown, fallback: number): number {
  const MIN = 5;
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < MIN) return MIN;
  return v;
}

/** Validate all settings with defense-in-depth — never trust raw storage values */
export function validateSettings(raw: StorageSchema): StorageSchema {
  return {
    serverUrl:
      typeof raw.serverUrl === "string" && raw.serverUrl.length > 0
        ? raw.serverUrl
        : DEFAULTS.serverUrl,
    autoLockMinutes: ensureAutoLockAtLeastMin(
      raw.autoLockMinutes,
      DEFAULTS.autoLockMinutes,
    ),
    theme: (VALID_THEMES as readonly string[]).includes(raw.theme)
      ? raw.theme
      : DEFAULTS.theme,
    showBadgeCount: ensureBool(raw.showBadgeCount, DEFAULTS.showBadgeCount),
    enableInlineSuggestions: ensureBool(
      raw.enableInlineSuggestions,
      DEFAULTS.enableInlineSuggestions,
    ),
    enableContextMenu: ensureBool(
      raw.enableContextMenu,
      DEFAULTS.enableContextMenu,
    ),
    autoCopyTotp: ensureBool(raw.autoCopyTotp, DEFAULTS.autoCopyTotp),
    showSavePrompt: ensureBool(raw.showSavePrompt, DEFAULTS.showSavePrompt),
    showUpdatePrompt: ensureBool(
      raw.showUpdatePrompt,
      DEFAULTS.showUpdatePrompt,
    ),
    clipboardClearSeconds: (
      VALID_CLIPBOARD_SECONDS as readonly number[]
    ).includes(raw.clipboardClearSeconds)
      ? raw.clipboardClearSeconds
      : DEFAULTS.clipboardClearSeconds,
    vaultTimeoutAction: (VALID_TIMEOUT_ACTIONS as readonly string[]).includes(
      raw.vaultTimeoutAction,
    )
      ? raw.vaultTimeoutAction
      : DEFAULTS.vaultTimeoutAction,
  };
}

export async function getSettings(): Promise<StorageSchema> {
  const result = await chrome.storage.local.get(DEFAULTS);
  return result as StorageSchema;
}

export async function setSettings(
  partial: Partial<StorageSchema>,
): Promise<void> {
  await chrome.storage.local.set(partial);
}
