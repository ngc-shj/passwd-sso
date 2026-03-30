/**
 * OAuth 2.1 Authorization Code + PKCE client for the CLI.
 *
 * Uses only Node.js built-in modules (node:crypto, node:http, node:child_process).
 * Implements DCR (RFC 7591) for client registration against the MCP OAuth endpoints.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";

const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes

const CLI_CLIENT_NAME = "passwd-sso-cli";
const CLI_SCOPES =
  "credentials:list credentials:use vault:status vault:unlock-data passwords:read passwords:write";

const MCP_TOKEN_ENDPOINT = "/api/mcp/token";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OAuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  clientId: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

interface CallbackResult {
  code: string;
  state: string;
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function computeS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ─── HTML templates ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Login successful</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.box{text-align:center;max-width:400px}</style></head>
<body><div class="box">
<h2>Login successful</h2>
<p>You can close this tab and return to the terminal.</p>
</div></body></html>`;

function errorHtml(msg: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Login failed</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.box{text-align:center;max-width:400px}</style></head>
<body><div class="box">
<h2>Login failed</h2>
<p>${escapeHtml(msg)}</p>
<p>Please return to the terminal.</p>
</div></body></html>`;
}

// ─── Loopback callback server ─────────────────────────────────────────────────

/**
 * Start a local HTTP server on port 0 (OS-assigned) that waits for the
 * OAuth redirect callback. Returns the assigned port and a promise that
 * resolves with the authorization code.
 *
 * Verifies the state parameter using constant-time comparison (RFC 9700 §2.1.2).
 */
export async function startCallbackServer(expectedState: string): Promise<{
  port: number;
  waitForCallback: () => Promise<CallbackResult>;
}> {
  let resolve: (result: CallbackResult) => void;
  let reject: (err: Error) => void;
  const callbackPromise = new Promise<CallbackResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Prevent unhandled rejection — errors are consumed via waitForCallback()
  callbackPromise.catch(() => {});

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${p}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        const desc = url.searchParams.get("error_description") ?? error;
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml(`Authorization error: ${desc}`));
        reject(new Error(`OAuth error: ${desc}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml("Missing code or state parameter."));
        reject(new Error("Callback missing code or state parameter"));
        return;
      }

      const expectedBuf = Buffer.from(expectedState, "utf-8");
      const receivedBuf = Buffer.from(state, "utf-8");
      const stateValid =
        expectedBuf.length === receivedBuf.length &&
        timingSafeEqual(expectedBuf, receivedBuf);

      if (!stateValid) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml("State mismatch — possible CSRF attack."));
        reject(new Error("OAuth state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      resolve({ code, state });
    },
  );

  // Bind to port 0 so the OS assigns a free ephemeral port — no TOCTOU race
  const port = await new Promise<number>((res, rej) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        res(addr.port);
      } else {
        server.close();
        rej(new Error("Failed to determine callback server port"));
      }
    });
    server.on("error", rej);
  });

  const waitForCallback = (): Promise<CallbackResult> => {
    return new Promise<CallbackResult>((res, rej) => {
      const timer = setTimeout(() => {
        server.close();
        rej(new Error(`Timed out waiting for OAuth callback after ${CALLBACK_TIMEOUT_MS / 1000}s`));
      }, CALLBACK_TIMEOUT_MS);

      callbackPromise
        .then((result) => { clearTimeout(timer); server.close(); res(result); })
        .catch((err) => { clearTimeout(timer); server.close(); rej(err); });
    });
  };

  return { port, waitForCallback };
}

// ─── DCR client registration ──────────────────────────────────────────────────

/** Register a new public OAuth client via Dynamic Client Registration (RFC 7591). */
export async function registerClient(
  serverUrl: string,
  redirectUri: string,
): Promise<{ clientId: string }> {
  const response = await fetch(`${serverUrl}/api/mcp/register`, { // codeql[js/file-system-data-in-network-request] serverUrl is user-provided config, not untrusted file data
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLI_CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: CLI_SCOPES,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DCR registration failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const clientId = data.client_id;
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("DCR response missing client_id");
  }

  const registeredUris = data.redirect_uris;
  if (Array.isArray(registeredUris) && !registeredUris.includes(redirectUri)) {
    throw new Error("DCR: server registered unexpected redirect_uri");
  }

  return { clientId };
}

// ─── Token endpoint helpers ──────────────────────────────────────────────────

/** Parse an OAuth token endpoint response into a structured result. */
function parseTokenResponse(data: Record<string, unknown>): TokenResponse {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = data.expires_in;
  const scope = data.scope;

  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("Token response missing access_token");
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error("Token response missing refresh_token");
  }

  return {
    accessToken,
    refreshToken,
    expiresIn: typeof expiresIn === "number" ? expiresIn : 3600,
    scope: typeof scope === "string" ? scope : CLI_SCOPES,
  };
}

/** Exchange an authorization code for access + refresh tokens. */
export async function exchangeCode(
  serverUrl: string,
  params: {
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
  },
): Promise<OAuthResult> {
  const response = await fetch(`${serverUrl}${MCP_TOKEN_ENDPOINT}`, { // codeql[js/file-system-data-in-network-request] OAuth code exchange sends authorization code to the token endpoint
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const token = parseTokenResponse(data);
  return { ...token, clientId: params.clientId };
}

/** Exchange a refresh token for a new access + refresh token pair. */
export async function refreshTokenGrant(
  serverUrl: string,
  refreshToken: string,
  clientId: string,
): Promise<TokenResponse | null> {
  const response = await fetch(`${serverUrl}${MCP_TOKEN_ENDPOINT}`, { // codeql[js/file-system-data-in-network-request] OAuth refresh grant sends stored refresh token to the token endpoint
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }).toString(),
  });

  if (!response.ok) return null;

  const data = (await response.json()) as Record<string, unknown>;
  return parseTokenResponse(data);
}

// ─── Token revocation (RFC 7009) ─────────────────────────────────────────────

/** Revoke a token via the server's revocation endpoint. Best-effort — does not throw. */
export async function revokeTokenRequest(
  serverUrl: string,
  token: string,
  clientId: string,
  tokenTypeHint?: "access_token" | "refresh_token",
): Promise<void> {
  const params: Record<string, string> = { token, client_id: clientId };
  if (tokenTypeHint) params.token_type_hint = tokenTypeHint;

  try {
    await fetch(`${serverUrl}/api/mcp/revoke`, { // codeql[js/file-system-data-in-network-request] OAuth token revocation sends stored token to the revocation endpoint
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  } catch {
    // Best-effort — network errors are silently ignored
  }
}

// ─── Browser launcher ─────────────────────────────────────────────────────────

/**
 * Attempt to open the URL in the system browser.
 * Returns false when running in a headless environment (no display server).
 */
export function openBrowser(url: string): boolean {
  const platform = process.platform;

  if (platform === "linux") {
    const hasDisplay =
      process.env.DISPLAY ||
      process.env.WAYLAND_DISPLAY ||
      process.env.TERM_PROGRAM;
    if (!hasDisplay) return false;
  }

  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

// ─── URL validation ───────────────────────────────────────────────────────────

/** Reject non-HTTPS URLs except for loopback development. */
export function validateServerUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid server URL: ${url}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol} (only https and http are allowed)`);
  }

  if (parsed.protocol === "http:") {
    const isLoopback =
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]";
    if (!isLoopback) {
      throw new Error(
        "Server URL must use HTTPS (http is only allowed for localhost/127.0.0.1/::1)",
      );
    }
  }
}

// ─── Main OAuth flow ──────────────────────────────────────────────────────────

export async function runOAuthFlow(serverUrl: string): Promise<OAuthResult> {
  validateServerUrl(serverUrl);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeS256Challenge(codeVerifier);
  const state = randomBytes(16).toString("hex");

  // Start callback server on OS-assigned port (no TOCTOU)
  const { port, waitForCallback } = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const { clientId } = await registerClient(serverUrl, redirectUri);

  const authUrl = new URL(`${serverUrl}/api/mcp/authorize`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", CLI_SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const urlString = authUrl.toString();
  const opened = openBrowser(urlString);

  if (opened) {
    process.stderr.write("Opening browser for authentication...\n");
  } else {
    process.stderr.write(
      "Cannot open browser. Please visit:\n  " + urlString + "\n",
    );
    process.stderr.write(
      "Waiting for authorization... (press Ctrl+C to cancel)\n",
    );
  }

  const { code } = await waitForCallback();

  return exchangeCode(serverUrl, { code, redirectUri, clientId, codeVerifier });
}
