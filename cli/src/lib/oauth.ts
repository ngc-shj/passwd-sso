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

// How long to wait for the browser callback before giving up
const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes

const CLI_CLIENT_NAME = "passwd-sso-cli";
const CLI_SCOPES =
  "credentials:list credentials:use vault:status vault:unlock-data passwords:read passwords:write";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OAuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  clientId: string;
}

interface CallbackResult {
  code: string;
  state: string;
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function computeCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ─── Port discovery ───────────────────────────────────────────────────────────

/** Bind to port 0 so the OS assigns a free ephemeral port, then return it. */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to determine free port")));
      }
    });
    server.on("error", reject);
  });
}

// ─── Loopback callback server ─────────────────────────────────────────────────

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Login successful</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.box{text-align:center;max-width:400px}</style></head>
<body><div class="box">
<h2>Login successful</h2>
<p>You can close this tab and return to the terminal.</p>
</div></body></html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Login failed</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.box{text-align:center;max-width:400px}</style></head>
<body><div class="box">
<h2>Login failed</h2>
<p>${msg}</p>
<p>Please return to the terminal.</p>
</div></body></html>`;

/**
 * Start a local HTTP server that waits for the OAuth redirect callback.
 * Verifies the state parameter using constant-time comparison (RFC 9700 §2.1.2).
 */
export function startCallbackServer(
  port: number,
  expectedState: string,
): {
  server: ReturnType<typeof createServer>;
  waitForCallback: () => Promise<CallbackResult>;
} {
  let resolveCallback: (result: CallbackResult) => void;
  let rejectCallback: (err: Error) => void;

  // Two independent promises: one for internal tracking (silenced), one for the caller
  let resolveWait: (result: CallbackResult) => void;
  let rejectWait: (err: Error) => void;
  const waitPromise = new Promise<CallbackResult>((res, rej) => {
    resolveWait = res;
    rejectWait = rej;
  });

  const promise = new Promise<CallbackResult>((res, rej) => {
    resolveCallback = (r) => { res(r); resolveWait(r); };
    rejectCallback = (e) => { rej(e); rejectWait(e); };
  });
  // Silence unhandled rejections — errors are forwarded via waitForCallback()
  promise.catch(() => {});
  waitPromise.catch(() => {});

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

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
        res.end(ERROR_HTML(`Authorization error: ${desc}`));
        rejectCallback(new Error(`OAuth error: ${desc}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ERROR_HTML("Missing code or state parameter."));
        rejectCallback(new Error("Callback missing code or state parameter"));
        return;
      }

      // Constant-time state comparison to prevent timing oracle on CSRF token
      const expectedBuf = Buffer.from(expectedState, "utf-8");
      const receivedBuf = Buffer.from(state, "utf-8");
      const stateValid =
        expectedBuf.length === receivedBuf.length &&
        timingSafeEqual(expectedBuf, receivedBuf);

      if (!stateValid) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(ERROR_HTML("State mismatch — possible CSRF attack."));
        rejectCallback(new Error("OAuth state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      resolveCallback({ code, state });
    },
  );

  server.listen(port, "127.0.0.1");

  const waitForCallback = (): Promise<CallbackResult> => {
    return new Promise<CallbackResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(
          new Error(
            `Timed out waiting for OAuth callback after ${CALLBACK_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, CALLBACK_TIMEOUT_MS);

      waitPromise
        .then((result) => { clearTimeout(timer); server.close(); resolve(result); })
        .catch((err) => { clearTimeout(timer); server.close(); reject(err); });
    });
  };

  return { server, waitForCallback };
}

// ─── DCR client registration ──────────────────────────────────────────────────

/** Register a new public OAuth client via Dynamic Client Registration (RFC 7591). */
export async function registerClient(
  serverUrl: string,
  redirectUri: string,
): Promise<{ clientId: string }> {
  const endpoint = `${serverUrl}/api/mcp/register`;

  const body = JSON.stringify({
    client_name: CLI_CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: CLI_SCOPES,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `DCR registration failed (${response.status}): ${text}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;
  const clientId = data.client_id;
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("DCR response missing client_id");
  }

  // Verify server registered the expected redirect URI (defense against MITM)
  const registeredUris = data.redirect_uris;
  if (Array.isArray(registeredUris) && !registeredUris.includes(redirectUri)) {
    throw new Error("DCR: server registered unexpected redirect_uri");
  }

  return { clientId };
}

// ─── Authorization code exchange ──────────────────────────────────────────────

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
  const endpoint = `${serverUrl}/api/mcp/token`;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

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
    clientId: params.clientId,
  };
}

// ─── Browser launcher ─────────────────────────────────────────────────────────

/**
 * Attempt to open the URL in the system browser.
 * Returns false when running in a headless environment (no display server).
 */
export function openBrowser(url: string): boolean {
  const platform = process.platform;

  // Detect headless Linux: no DISPLAY, no WAYLAND_DISPLAY, no TERM_PROGRAM
  if (platform === "linux") {
    const hasDisplay =
      process.env.DISPLAY ||
      process.env.WAYLAND_DISPLAY ||
      process.env.TERM_PROGRAM;
    if (!hasDisplay) {
      return false;
    }
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
    // Linux / other Unix
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

/** Reject non-HTTPS URLs except for localhost development. */
export function validateServerUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid server URL: ${url}`);
  }

  if (parsed.protocol !== "https:") {
    // Allow loopback for local development (consistent with MCP DCR server-side validation)
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

/**
 * Run the full OAuth 2.1 Authorization Code + PKCE flow:
 *   1. Find a free loopback port
 *   2. Register public client via DCR
 *   3. Generate PKCE verifier + challenge and state nonce
 *   4. Start loopback callback server
 *   5. Build authorization URL and open browser (or print URL)
 *   6. Wait for callback
 *   7. Exchange code for tokens
 */
export async function runOAuthFlow(serverUrl: string): Promise<OAuthResult> {
  validateServerUrl(serverUrl);

  // 1. Ephemeral loopback port
  const port = await findFreePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 2. DCR client registration
  const { clientId } = await registerClient(serverUrl, redirectUri);

  // 3. PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);

  // 4. State nonce (CSRF protection)
  const state = randomBytes(16).toString("hex");

  // 5. Callback server
  const { waitForCallback } = startCallbackServer(port, state);

  // 6. Authorization URL
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

  // 7. Wait for callback
  const { code } = await waitForCallback();

  // 8. Exchange code for tokens
  return exchangeCode(serverUrl, {
    code,
    redirectUri,
    clientId,
    codeVerifier,
  });
}
