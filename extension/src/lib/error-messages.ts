import { t } from "./i18n";

const ERROR_KEY_MAP: Record<string, string> = {
  INVALID_PASSPHRASE: "errors.invalidPassphrase",
  VAULT_LOCKED: "errors.vaultLocked",
  FETCH_FAILED: "errors.fetchFailed",
  NO_PASSWORD: "errors.noPassword",
  PERMISSION_DENIED: "errors.permissionDenied",
  CLIPBOARD_FAILED: "errors.clipboardFailed",
  COPY_FAILED: "errors.copyFailed",
  NO_ACTIVE_TAB: "errors.noActiveTab",
  AUTOFILL_FAILED: "errors.autofillFailed",
  INVALID_URL: "errors.invalidUrl",
  HTTPS_REQUIRED: "errors.httpsRequired",
  AUTO_LOCK_INVALID: "errors.autoLockInvalid",
  NO_TOTP: "errors.noTotpConfigured",
  INVALID_TOTP: "errors.invalidTotp",
  NETWORK_ERROR: "errors.networkError",
  INVALID_ENTRY: "errors.invalidEntry",
  ORIGIN_MISMATCH: "errors.originMismatch",
  UNKNOWN_ORIGIN: "errors.unknownOrigin",
  FILL_FAILED: "errors.autofillFailed",
  NO_CARD_NUMBER: "errors.noCardNumber",
  AUTOFILL_INJECT_FAILED: "errors.autofillInjectFailed",
  COPY_TOTP_FAILED: "errors.copyTotpFailed",
  UNLOCK_FAILED: "errors.unlockFailed",
  NO_TOKEN: "errors.noToken",
};

export function humanizeError(code: string): string {
  const key = ERROR_KEY_MAP[code];
  return key ? t(key) : code;
}
