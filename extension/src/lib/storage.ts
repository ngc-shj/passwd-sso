/** Keys stored in chrome.storage.local (settings only — never secrets) */
export interface StorageSchema {
  /** Base URL of the passwd-sso web app */
  serverUrl: string;
  /** Auto-lock timeout in minutes (0 = disabled) */
  autoLockMinutes: number;
}

const DEFAULTS: StorageSchema = {
  serverUrl: "https://localhost:3000",
  autoLockMinutes: 15,
};

export async function getSettings(): Promise<StorageSchema> {
  const result = await chrome.storage.local.get(DEFAULTS);
  return result as StorageSchema;
}

export async function setSettings(
  partial: Partial<StorageSchema>,
): Promise<void> {
  await chrome.storage.local.set(partial);
}
