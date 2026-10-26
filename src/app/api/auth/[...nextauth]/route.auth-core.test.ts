/**
 * Acceptance pin for withoutSessionCookieOnCallback against the real
 * `@auth/core` callback (issue #966). A browser holding the victim's session
 * cookie completes an OIDC callback with an IdP account linked to no one.
 * Through the wrapper Auth.js must treat it as a fresh sign-in: it never
 * resolves the victim's session and never links the account to the victim.
 * The control cell drives the same request into `Auth` directly and shows
 * the link happening, so the fixture is one Auth.js would act on.
 *
 * `fetch` is mocked only at the network boundary (discovery, token, jwks);
 * the adapter is an in-memory fake that records which session its
 * createSession is told it replaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { NextRequest } from "next/server";
import { Auth, skipCSRFCheck, type AuthConfig } from "@auth/core";
import type { Adapter, AdapterSession, AdapterUser } from "@auth/core/adapters";
import { sessionMetaStorage } from "@/lib/auth/session/session-meta";

vi.mock("@/auth", () => ({ handlers: { GET: vi.fn(), POST: vi.fn() } }));
vi.mock("@/lib/http/with-request-log", () => ({ withRequestLog: <T>(h: T) => h }));
vi.mock("@/lib/audit/audit", () => ({ extractRequestMeta: () => ({}) }));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: vi.fn(async () => ({ allowed: true })) }),
}));

const APP = "http://app.test:3000";
const IDP = "https://idp.test";
const CLIENT_ID = "client-1";
const VICTIM_TOKEN = "aaaa";
const VICTIM: AdapterUser = {
  id: "victim-user",
  email: "victim@example.com",
  emailVerified: null,
};

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function idToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
  const payload = b64url(
    JSON.stringify({
      iss: IDP,
      aud: CLIENT_ID,
      sub: "attacker-sub",
      email: "attacker@example.com",
      iat: now,
      exp: now + 300,
    }),
  );
  const signature = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function installFetch({ tokenFails = false } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return json({
          issuer: IDP,
          authorization_endpoint: `${IDP}/authorize`,
          token_endpoint: `${IDP}/token`,
          // Required by Auth.js's discovery check; never fetched for an oidc
          // provider, whose profile comes from the ID token.
          userinfo_endpoint: `${IDP}/userinfo`,
          jwks_uri: `${IDP}/jwks`,
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["RS256"],
        });
      }
      if (url.pathname === "/jwks") return json({ keys: [JWK] });
      if (url.pathname === "/token") {
        if (tokenFails) {
          return new Response(JSON.stringify({ error: "invalid_grant" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return json({
          access_token: "access-token-1",
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken(),
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

function fakeAdapter() {
  const sessions = new Map<string, AdapterSession>([
    [VICTIM_TOKEN, { sessionToken: VICTIM_TOKEN, userId: VICTIM.id, expires: new Date(Date.now() + 60_000) }],
  ]);
  const users = new Map<string, AdapterUser>([[VICTIM.id, VICTIM]]);
  // The real adapter's createSession deletes the session its meta names in
  // the transaction that creates the new one; record what it would read.
  const replaced: (string | null | undefined)[] = [];
  const adapter = {
    createUser: vi.fn(async (data: AdapterUser) => {
      const user = { ...data, id: "new-user" };
      users.set(user.id, user);
      return user;
    }),
    getUser: vi.fn(async (id: string) => users.get(id) ?? null),
    getUserByEmail: vi.fn(async () => null),
    getUserByAccount: vi.fn(async () => null),
    updateUser: vi.fn(async (data: Partial<AdapterUser> & { id: string }) => ({ ...VICTIM, ...data })),
    linkAccount: vi.fn(async () => undefined),
    createSession: vi.fn(async (session: AdapterSession) => {
      replaced.push(sessionMetaStorage.getStore()?.replacesSessionToken);
      sessions.set(session.sessionToken, session);
      return session;
    }),
    getSessionAndUser: vi.fn(async (token: string) => {
      const session = sessions.get(token);
      const user = session ? users.get(session.userId) : undefined;
      return session && user ? { session, user } : null;
    }),
    updateSession: vi.fn(async () => null),
    deleteSession: vi.fn(async () => null),
  } satisfies Adapter;
  return { adapter, replaced, sessions };
}

function authConfig(adapter: Adapter): AuthConfig {
  return {
    adapter,
    session: { strategy: "database" },
    providers: [
      {
        id: "idp",
        name: "IdP",
        type: "oidc",
        issuer: IDP,
        clientId: CLIENT_ID,
        clientSecret: "secret-1",
        checks: ["pkce", "state"],
      },
    ],
    callbacks: { signIn: () => true },
    secret: "s".repeat(32),
    trustHost: true,
    basePath: "/api/auth",
    skipCSRFCheck,
  };
}

function setCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .filter((pair) => !pair.endsWith("="));
}

/** Sign in at the IdP, then build the callback a browser holding the victim's cookie sends. */
async function callbackRequest(config: AuthConfig): Promise<NextRequest> {
  const signIn = await Auth(
    new Request(`${APP}/api/auth/signin/idp`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ callbackUrl: `${APP}/dashboard` }),
    }),
    config,
  );
  const location = signIn.headers.get("location");
  if (!location) throw new Error(`sign-in did not redirect (status ${signIn.status})`);
  const state = new URL(location).searchParams.get("state") ?? "";
  const cookie = [`authjs.session-token=${VICTIM_TOKEN}`, ...setCookies(signIn)].join("; ");
  return new NextRequest(`${APP}/api/auth/callback/idp?${new URLSearchParams({ code: "code-1", state })}`, {
    headers: { cookie },
  });
}

describe("callback through withoutSessionCookieOnCallback (@auth/core)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
    vi.stubEnv("AUTH_URL", APP);
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("signs in fresh: the victim's session is never read and nothing is linked to the victim", async () => {
    const { adapter, replaced } = fakeAdapter();
    const config = authConfig(adapter);
    const { _withoutSessionCookieOnCallback } = await import("@/app/api/auth/[...nextauth]/route");

    const response = await _withoutSessionCookieOnCallback((req: NextRequest) => Auth(req, config))(
      await callbackRequest(config),
    );

    expect(adapter.getSessionAndUser).not.toHaveBeenCalled();
    expect(adapter.linkAccount).not.toHaveBeenCalledWith(expect.objectContaining({ userId: VICTIM.id }));
    // Positive control: the callback completed as a new user's sign-in.
    expect(adapter.linkAccount).toHaveBeenCalledWith(expect.objectContaining({ userId: "new-user" }));
    expect(response.headers.get("location")).toBe(`${APP}/dashboard`);
    // ...and the new session is created as the replacement of the one the
    // browser held, so that session is deleted rather than left alive.
    expect(replaced).toEqual([VICTIM_TOKEN]);
  });

  // The replaced session goes only with a session the sign-in creates.
  it("keeps the session the browser held when the callback fails", async () => {
    installFetch({ tokenFails: true });
    const { adapter, replaced, sessions } = fakeAdapter();
    const config = authConfig(adapter);
    const { _withoutSessionCookieOnCallback } = await import("@/app/api/auth/[...nextauth]/route");

    const response = await _withoutSessionCookieOnCallback((req: NextRequest) => Auth(req, config))(
      await callbackRequest(config),
    );

    expect(response.headers.get("location")).toContain("error=");
    expect(adapter.createSession).not.toHaveBeenCalled();
    expect(adapter.deleteSession).not.toHaveBeenCalled();
    expect(replaced).toEqual([]);
    expect(sessions.has(VICTIM_TOKEN)).toBe(true);
  });

  it("control: Auth.js called directly links the IdP account to the signed-in victim", async () => {
    const { adapter } = fakeAdapter();
    const config = authConfig(adapter);

    await Auth(await callbackRequest(config), config);

    expect(adapter.getSessionAndUser).toHaveBeenCalledWith(VICTIM_TOKEN);
    expect(adapter.linkAccount).toHaveBeenCalledWith(expect.objectContaining({ userId: VICTIM.id }));
  });
});
