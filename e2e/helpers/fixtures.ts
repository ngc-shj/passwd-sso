/**
 * Shared test fixtures — loads auth state from global-setup output.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  sessionToken: string;
  passphrase?: string;
}

interface AuthState {
  vaultReady: AuthUser;
  fresh: AuthUser;
  /** Dedicated user for lockout tests (destructive: triggers account lock) */
  lockout: AuthUser;
  /** Dedicated user for vault-reset tests (destructive: deletes vault) */
  reset: AuthUser;
}

let _authState: AuthState | null = null;

export function getAuthState(): AuthState {
  if (!_authState) {
    const path = join(__dirname, "..", ".auth-state.json");
    _authState = JSON.parse(readFileSync(path, "utf-8"));
  }
  return _authState!;
}
