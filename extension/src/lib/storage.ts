/** Keys stored in chrome.storage.local (settings only — never secrets) */
interface StorageSchema {
  /** Base URL of the passwd-sso web app */
  serverUrl: string;
}

const DEFAULTS: StorageSchema = {
  serverUrl: "https://localhost:3000",
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
