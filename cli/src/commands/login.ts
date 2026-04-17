/**
 * `passwd-sso login` — Authenticate via OAuth 2.1 PKCE or manual token paste.
 */

import { createInterface } from "node:readline";
import { loadConfig, saveConfig, loadCredentials, saveCredentials } from "../lib/config.js";
import { setTokenCache } from "../lib/api-client.js";
import { runOAuthFlow, revokeTokenRequest, validateServerUrl } from "../lib/oauth.js";
import * as output from "../lib/output.js";
import { MS_PER_MINUTE, MS_PER_SECOND } from "../lib/time.js";

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export interface LoginOptions {
  useToken?: boolean;
  server?: string;
}

export async function loginCommand(opts: LoginOptions = {}): Promise<void> {
  const config = loadConfig();

  // Resolve server URL
  const serverInput = opts.server ?? await prompt(
    `Server URL${config.serverUrl ? ` [${config.serverUrl}]` : ""}: `,
  );
  if (serverInput) {
    config.serverUrl = serverInput.replace(/\/$/, "");
  }
  if (!config.serverUrl) {
    output.error("Server URL is required.");
    return;
  }

  try {
    validateServerUrl(config.serverUrl);
  } catch (err) {
    output.error(err instanceof Error ? err.message : "Invalid server URL");
    return;
  }

  saveConfig(config);

  // Revoke previous session before starting new login
  await revokeExistingSession(config.serverUrl);

  if (opts.useToken) {
    // Manual token paste fallback (CI / headless without callback)
    await manualTokenLogin(config.serverUrl);
  } else {
    // OAuth 2.1 Authorization Code + PKCE (default)
    await oauthLogin(config.serverUrl);
  }
}

/** Best-effort revocation of the previous session's tokens. */
async function revokeExistingSession(serverUrl: string): Promise<void> {
  const creds = loadCredentials();
  if (!creds || !creds.refreshToken || !creds.clientId) return;

  try {
    // Revoking the refresh token also revokes all access tokens in the family
    await revokeTokenRequest(serverUrl, creds.refreshToken, creds.clientId, "refresh_token");
  } catch {
    // Best-effort — failure here should not block login
  }
}

async function oauthLogin(serverUrl: string): Promise<void> {
  try {
    const result = await runOAuthFlow(serverUrl);

    const expiresAt = new Date(Date.now() + result.expiresIn * MS_PER_SECOND).toISOString();
    saveCredentials({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      clientId: result.clientId,
      expiresAt,
    });
    setTokenCache(result.accessToken, expiresAt, result.refreshToken, result.clientId);

    output.success(`Logged in to ${serverUrl}`);
  } catch (err) {
    output.error(err instanceof Error ? err.message : "OAuth login failed");
  }
}

async function manualTokenLogin(serverUrl: string): Promise<void> {
  output.info(
    "Open your browser and go to the token page to generate a CLI token.",
  );
  output.info(`  ${serverUrl}/dashboard/settings/developer`);
  console.log();

  const token = await prompt("Paste your token: ");
  if (!token) {
    output.error("Token is required.");
    return;
  }

  // 15 minutes — rough default for manually-pasted tokens; server re-verifies expiry
  const expiresAt = new Date(Date.now() + 15 * MS_PER_MINUTE).toISOString();
  saveCredentials({
    accessToken: token,
    refreshToken: "",
    clientId: "",
    expiresAt,
  });
  setTokenCache(token, expiresAt);

  output.warn("Manual token will not auto-refresh. Use `passwd-sso login` for persistent sessions.");
  output.success(`Logged in to ${serverUrl}`);
}
