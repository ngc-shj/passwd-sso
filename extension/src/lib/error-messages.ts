const ERROR_MAP: Record<string, string> = {
  INVALID_PASSPHRASE: "Passphrase is incorrect.",
  VAULT_LOCKED: "Vault is locked.",
  FETCH_FAILED: "Failed to load entries.",
  NO_PASSWORD: "No password available for this entry.",
  PERMISSION_DENIED: "Host permission was denied.",
  CLIPBOARD_FAILED: "Clipboard write failed.",
  COPY_FAILED: "Copy failed.",
  NO_ACTIVE_TAB: "No active tab found.",
  AUTOFILL_FAILED: "Autofill failed.",
};

export function humanizeError(code: string): string {
  return ERROR_MAP[code] ?? code;
}
