/**
 * Wire-level pin of the Jackson providers' token exchange (plan
 * sso-claim-connection-binding, C1 / M1, M8, M9).
 *
 * Drives `@auth/core`'s real sign-in and callback over the provider objects
 * `auth.config.ts` builds, with `fetch` mocked only at the network boundary
 * (discovery, token, jwks). What is pinned is what goes on the wire, because
 * that is what Jackson adjudicates: Jackson's PKCE branch skips client
 * authentication, and any `code_verifier` matching an attacker-chosen
 * challenge redeems a code minted for another connection's IdP. So each
 * provider must send no `code_challenge`, no `code_verifier`, and its OWN
 * connection's credentials as HTTP Basic — also when a valid PKCE cookie from
 * a Google sign-in sits in the same browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { Auth, skipCSRFCheck } from "@auth/core";
import type { NextAuthConfig } from "next-auth";

const APP = "http://app.test:3000";
const JACKSON = "http://jackson.test:5225";
const GOOGLE = "https://accounts.google.com";
const CODE = "authorization-code-1";

const CONNECTIONS = [
  { providerId: "saml-jackson", clientId: "legacy-client-1", clientSecret: "legacy-secret-1" },
  { providerId: "saml-jackson-a", clientId: "client-a-1", clientSecret: "secret-a-1" },
  { providerId: "saml-jackson-b", clientId: "client-b-1", clientSecret: "secret-b-1" },
] as const;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function idToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
  const payload = b64url(JSON.stringify({ iat: now, exp: now + 300, ...claims }));
  const signature = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function discovery(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    userinfo_endpoint: `${issuer}/oauth/userinfo`,
    jwks_uri: `${issuer}/oauth/jwks`,
    response_types_supported: ["code"],
    id_token_signing_alg_values_supported: ["RS256"],
    // Advertised, as Jackson does: a provider with `pkce` in its checks
    // would put a challenge on the authorize URL.
    code_challenge_methods_supported: ["S256"],
  };
}

type TokenRequest = { issuer: string; authorization: string | null; body: URLSearchParams };

/** The network boundary: discovery, token and jwks for Jackson and Google. */
function installFetch(nonceFor: () => { issuer: string; aud: string; nonce: string | undefined }) {
  const tokenRequests: TokenRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const issuer = url.origin === new URL(GOOGLE).origin ? GOOGLE : JACKSON;
    if (url.pathname === "/.well-known/openid-configuration") return json(discovery(issuer));
    if (url.pathname === "/oauth/jwks") return json({ keys: [JWK] });
    if (url.pathname === "/oauth/token") {
      const headers = new Headers(init?.headers);
      tokenRequests.push({
        issuer,
        authorization: headers.get("authorization"),
        body: new URLSearchParams(String(init?.body ?? "")),
      });
      const expected = nonceFor();
      return json({
        access_token: "access-token-1",
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken({
          iss: expected.issuer,
          aud: expected.aud,
          sub: "user-1",
          email: "user@example.com",
          ...(expected.nonce ? { nonce: expected.nonce } : {}),
        }),
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return tokenRequests;
}

async function loadAuthConfig(): Promise<NextAuthConfig> {
  vi.resetModules();
  const config = (await import("@/auth.config")).default;
  return {
    ...config,
    secret: "s".repeat(32),
    trustHost: true,
    basePath: "/api/auth",
    skipCSRFCheck,
  };
}

function setCookies(response: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return jar;
}

function cookieHeader(...jars: Map<string, string>[]): string {
  return jars
    .flatMap((jar) => [...jar].filter(([, value]) => value !== "").map(([name, value]) => `${name}=${value}`))
    .join("; ");
}

async function signIn(config: NextAuthConfig, providerId: string) {
  const response = await Auth(
    new Request(`${APP}/api/auth/signin/${providerId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ callbackUrl: `${APP}/dashboard` }),
    }),
    config,
  );
  const location = response.headers.get("location");
  if (!location) throw new Error(`sign-in for ${providerId} did not redirect (status ${response.status})`);
  return { authorizeUrl: new URL(location), cookies: setCookies(response) };
}

async function callback(config: NextAuthConfig, providerId: string, state: string | null, cookie: string) {
  const query = new URLSearchParams({ code: CODE, ...(state ? { state } : {}) });
  return Auth(
    new Request(`${APP}/api/auth/callback/${providerId}?${query}`, { headers: { cookie } }),
    config,
  );
}

function basic(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

describe("Jackson providers on the wire (@auth/core sign-in + callback)", () => {
  let expectedIdToken: { issuer: string; aud: string; nonce: string | undefined };
  let tokenRequests: TokenRequest[];

  beforeEach(() => {
    vi.stubEnv("JACKSON_URL", JACKSON);
    vi.stubEnv("AUTH_JACKSON_ID", CONNECTIONS[0].clientId);
    vi.stubEnv("AUTH_JACKSON_SECRET", CONNECTIONS[0].clientSecret);
    vi.stubEnv(
      "AUTH_JACKSON_CONNECTIONS",
      JSON.stringify(
        CONNECTIONS.slice(1).map((c) => ({
          id: c.providerId.replace("saml-jackson-", ""),
          name: `SSO ${c.providerId}`,
          clientId: c.clientId,
          clientSecret: c.clientSecret,
        })),
      ),
    );
    vi.stubEnv("AUTH_GOOGLE_ID", "google-client-1");
    vi.stubEnv("AUTH_GOOGLE_SECRET", "google-secret-1");
    vi.stubEnv("AUTH_CLAIM_BINDING", "strict");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    vi.stubEnv("AUTH_URL", APP);
    expectedIdToken = { issuer: JACKSON, aud: "", nonce: undefined };
    tokenRequests = installFetch(() => expectedIdToken);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the legacy provider and both entries from the parser", async () => {
    const config = await loadAuthConfig();
    const ids = config.providers.map((p) => (typeof p === "function" ? p().id : p.id));
    expect(ids).toEqual(expect.arrayContaining(CONNECTIONS.map((c) => c.providerId)));
  });

  describe.each(CONNECTIONS)("$providerId", ({ providerId, clientId, clientSecret }) => {
    it("puts state and nonce on the authorize URL, and no code_challenge", async () => {
      const config = await loadAuthConfig();
      const { authorizeUrl } = await signIn(config, providerId);

      expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${JACKSON}/oauth/authorize`);
      expect(authorizeUrl.searchParams.get("client_id")).toBe(clientId);
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${APP}/api/auth/callback/${providerId}`);
      expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
      expect(authorizeUrl.searchParams.get("nonce")).toBeTruthy();
      expect(authorizeUrl.searchParams.has("code_challenge")).toBe(false);
      expect(authorizeUrl.searchParams.has("code_challenge_method")).toBe(false);
    });

    it("redeems the code with its own credentials as Basic and no code_verifier", async () => {
      const config = await loadAuthConfig();
      const { authorizeUrl, cookies } = await signIn(config, providerId);
      expectedIdToken = { issuer: JACKSON, aud: clientId, nonce: authorizeUrl.searchParams.get("nonce") ?? undefined };

      const response = await callback(config, providerId, authorizeUrl.searchParams.get("state"), cookieHeader(cookies));

      expect(tokenRequests).toHaveLength(1);
      const [request] = tokenRequests;
      expect(request.issuer).toBe(JACKSON);
      expect(request.authorization).toBe(basic(clientId, clientSecret));
      expect(request.body.has("code_verifier")).toBe(false);
      expect(request.body.has("client_secret")).toBe(false);
      expect(request.body.get("code")).toBe(CODE);
      // Positive control: the exchange completed (state and nonce checked),
      // so the assertions above describe a sign-in that succeeds.
      expect(response.headers.get("location")).toBe(`${APP}/dashboard`);
    });

    it("sends no code_verifier when a valid Google PKCE cookie is present", async () => {
      const config = await loadAuthConfig();
      const google = await signIn(config, "google");
      // The cookie is real: Google's authorize URL carries its challenge.
      const googleChallenge = google.authorizeUrl.searchParams.get("code_challenge");
      expect(googleChallenge).toBeTruthy();
      expect([...google.cookies.keys()]).toContain("authjs.pkce.code_verifier");

      const { authorizeUrl, cookies } = await signIn(config, providerId);
      expectedIdToken = { issuer: JACKSON, aud: clientId, nonce: authorizeUrl.searchParams.get("nonce") ?? undefined };
      const response = await callback(
        config,
        providerId,
        authorizeUrl.searchParams.get("state"),
        cookieHeader(google.cookies, cookies),
      );

      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0].authorization).toBe(basic(clientId, clientSecret));
      expect(tokenRequests[0].body.has("code_verifier")).toBe(false);
      expect(response.headers.get("location")).toBe(`${APP}/dashboard`);
    });
  });

  // Positive control for the cookie cells above: the same Google cookie IS
  // redeemable — Google's own callback puts its verifier on the wire. Without
  // this, "no code_verifier" could pass because the cookie was never valid.
  it("the Google PKCE cookie is valid for Google's own callback", async () => {
    const config = await loadAuthConfig();
    const google = await signIn(config, "google");
    expectedIdToken = { issuer: GOOGLE, aud: "google-client-1", nonce: undefined };

    await callback(config, "google", null, cookieHeader(google.cookies));

    expect(tokenRequests).toHaveLength(1);
    const verifier = tokenRequests[0].body.get("code_verifier");
    expect(verifier).toBeTruthy();
    expect(createHash("sha256").update(verifier ?? "").digest("base64url")).toBe(
      google.authorizeUrl.searchParams.get("code_challenge"),
    );
  });
});
