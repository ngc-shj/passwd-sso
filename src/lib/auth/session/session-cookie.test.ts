import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
// Auth.js's own request conversion and session-cookie collector, imported by
// file path: neither is in @auth/core's package `exports`. A static import
// fails this whole file loudly if the layout moves, rather than skipping the
// differential silently.
import { toInternalRequest } from "../../../../node_modules/@auth/core/lib/utils/web.js";
import { SessionStore } from "../../../../node_modules/@auth/core/lib/utils/cookie.js";
import { ALL_KNOWN_SESSION_COOKIE_NAMES } from "./cookie-name";
import {
  hasAnySessionCookie,
  parseCookiePairs,
  presentedSessionTokens,
  readSessionCookie,
  SESSION_COOKIE_READ,
} from "./session-cookie";

const DEPLOYMENTS = {
  plainHttp: {
    env: { AUTH_URL: "http://localhost:3000", NEXT_PUBLIC_BASE_PATH: "" },
    name: "authjs.session-token",
  },
  secureBasePath: {
    env: { AUTH_URL: "https://app.example.test/passwd-sso", NEXT_PUBLIC_BASE_PATH: "/passwd-sso" },
    name: "__Secure-authjs.session-token",
  },
  hostRoot: {
    env: { AUTH_URL: "https://app.example.test", NEXT_PUBLIC_BASE_PATH: "" },
    name: "__Host-authjs.session-token",
  },
} as const;

function stubDeployment(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

const N = DEPLOYMENTS.plainHttp.name;
const TOKEN_A = "0b6f1c2e-8d4a-4f7e-9a1b-3c5d7e9f0a2b";
const TOKEN_B = "5a7c9e1f-2b4d-4c6e-8f0a-1b3d5f7a9c0e";

const token = (t: string) => ({ kind: SESSION_COOKIE_READ.TOKEN, token: t });
const NONE = { kind: SESSION_COOKIE_READ.NONE };
const AMBIGUOUS = { kind: SESSION_COOKIE_READ.AMBIGUOUS };

/**
 * One request built from a raw Cookie header, and the header as production
 * code reads it back (`request.headers.get("cookie")`). The Headers object
 * normalizes the value (it strips leading/trailing whitespace), so both
 * readers below must be handed what it delivers, not the raw string.
 */
function deliver(header: string): { request: Request; delivered: string } {
  const request = new Request("http://localhost/api/auth/session", { headers: { cookie: header } });
  return { request, delivered: request.headers.get("cookie") ?? "" };
}

/**
 * The cookies `auth()` sees on this request. `toInternalRequest` is Auth.js's
 * own conversion (it parses the header with its vendored parser).
 */
async function authjsCookies(request: Request): Promise<Record<string, string>> {
  const internal = await toInternalRequest(request, { basePath: "/api/auth", providers: [] });
  if (!internal) throw new Error(`toInternalRequest rejected the request for header ${JSON.stringify(request.headers.get("cookie"))}`);
  return internal.cookies;
}

/**
 * What `auth()` resolves the session token to under `name`. Reproduces the
 * construction in `@auth/core/lib/index.js` (`new SessionStore(
 * options.cookies.sessionToken, request.cookies, options.logger)`), which runs
 * inside `Auth()` and is not reachable on its own.
 */
function authjsSessionToken(cookies: Record<string, string>, name: string): string {
  return new SessionStore({ name, options: {} }, cookies, console).value;
}

describe("parseCookiePairs", () => {
  it("splits on ';' at the first '=', trimming space and tab only, keeping duplicates", () => {
    expect(parseCookiePairs(" a = 1 ;\tb=x=y\t; novalue ; a=2; c=\n")).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "x=y" },
      { key: "a", value: "2" },
      { key: "c", value: "\n" },
    ]);
  });
});

describe("readSessionCookie", () => {
  beforeEach(() => stubDeployment(DEPLOYMENTS.plainHttp.env));
  afterEach(() => vi.unstubAllEnvs());

  it("reads a plain configured cookie", () => {
    expect(readSessionCookie(`other=1; ${N}=${TOKEN_A}`)).toEqual(token(TOKEN_A));
  });

  it("reads the key with space or tab before '=' as Auth.js does", () => {
    expect(readSessionCookie(`${N} =${TOKEN_A}`)).toEqual(token(TOKEN_A));
    expect(readSessionCookie(`${N}\t=${TOKEN_A}`)).toEqual(token(TOKEN_A));
  });

  it("reads the value with surrounding space or tab as Auth.js does", () => {
    expect(readSessionCookie(`${N}= ${TOKEN_A}\t`)).toEqual(token(TOKEN_A));
  });

  // Auth.js keeps the first; so does every reader now, since they all come
  // through here. A browser sends a duplicate when another app on the host
  // sets the same name at a shorter path.
  it("reads the first of a duplicated configured name, in either order", () => {
    expect(readSessionCookie(`${N}=${TOKEN_A}; ${N}=${TOKEN_B}`)).toEqual(token(TOKEN_A));
    expect(readSessionCookie(`${N}=${TOKEN_B}; ${N}=${TOKEN_A}`)).toEqual(token(TOKEN_B));
  });

  it("reads a whitespace-spelled first occurrence as the first", () => {
    expect(readSessionCookie(`${N} =${TOKEN_B}; ${N}=${TOKEN_A}`)).toEqual(token(TOKEN_B));
  });

  // SessionStore joins <name>.0, <name>.1: the database strategy never
  // writes them, so their presence alone is a crafted header.
  it("refuses chunk-named cookies, alone or with the plain name", () => {
    expect(readSessionCookie(`${N}.0=${TOKEN_A}`)).toEqual(AMBIGUOUS);
    expect(readSessionCookie(`${N}.0=${TOKEN_A}; ${N}.1=${TOKEN_B}`)).toEqual(AMBIGUOUS);
    expect(readSessionCookie(`${N}=${TOKEN_A}; ${N}.0=${TOKEN_B}`)).toEqual(AMBIGUOUS);
  });

  it("refuses any other key that starts with the configured name", () => {
    expect(readSessionCookie(`${N}X=${TOKEN_A}`)).toEqual(AMBIGUOUS);
  });

  it("is none for an empty first value followed by a real one", () => {
    // Auth.js keeps the empty first occurrence and resolves no session.
    expect(readSessionCookie(`${N}=; ${N}=${TOKEN_A}`)).toEqual(NONE);
  });

  it("is none for an empty value alone", () => {
    expect(readSessionCookie(`${N}=`)).toEqual(NONE);
  });

  it("refuses a %-encoded value (Auth.js decodes it)", () => {
    expect(readSessionCookie(`${N}=%30b6f`)).toEqual(AMBIGUOUS);
  });

  it("refuses a quoted value", () => {
    expect(readSessionCookie(`${N}="${TOKEN_A}"`)).toEqual(AMBIGUOUS);
  });

  it("refuses a value outside the token alphabet", () => {
    expect(readSessionCookie(`${N}=sess-1`)).toEqual(AMBIGUOUS);
    expect(readSessionCookie(`${N}=${TOKEN_A.toUpperCase()}`)).toEqual(AMBIGUOUS);
  });

  it("is none when only non-configured known names are present", () => {
    expect(
      readSessionCookie(
        `__Host-authjs.session-token=${TOKEN_A}; __Secure-authjs.session-token=${TOKEN_B}`,
      ),
    ).toEqual(NONE);
  });

  it("is none for legacy next-auth names", () => {
    expect(
      readSessionCookie(
        `next-auth.session-token=${TOKEN_A}; __Secure-next-auth.session-token=${TOKEN_B}`,
      ),
    ).toEqual(NONE);
  });

  it("is none for a missing or empty header", () => {
    expect(readSessionCookie(null)).toEqual(NONE);
    expect(readSessionCookie("")).toEqual(NONE);
  });

  it("reads only __Secure- on an https basePath deployment", () => {
    stubDeployment(DEPLOYMENTS.secureBasePath.env);
    expect(
      readSessionCookie(`__Host-authjs.session-token=${TOKEN_A}; __Secure-authjs.session-token=${TOKEN_B}`),
    ).toEqual(token(TOKEN_B));
  });
});

describe("presentedSessionTokens", () => {
  const P = "__Host-authjs.session-token";
  const LEGACY = "next-auth.session-token";

  it("returns every duplicate of a name in header order, not only the first", () => {
    expect(presentedSessionTokens(`${P}=${TOKEN_A}; other=x; ${P}=${TOKEN_B}`, [P])).toEqual([
      TOKEN_A,
      TOKEN_B,
    ]);
  });

  it("collects across the names it is given and ignores the rest", () => {
    expect(
      presentedSessionTokens(`${LEGACY}=${TOKEN_A}; ${N}=${TOKEN_B}`, ALL_KNOWN_SESSION_COOKIE_NAMES),
    ).toEqual([TOKEN_A, TOKEN_B]);
    expect(presentedSessionTokens(`${LEGACY}=${TOKEN_A}; ${N}=${TOKEN_B}`, [N])).toEqual([TOKEN_B]);
  });

  it("returns a token once when it repeats", () => {
    expect(presentedSessionTokens(`${P}=${TOKEN_A}; ${P}=${TOKEN_A}`, [P])).toEqual([TOKEN_A]);
  });

  // A chunk was never written by Auth.js under the database strategy; it is
  // what makes a header ambiguous, never a token to revoke.
  it("skips a chunk or other prefixed key", () => {
    expect(presentedSessionTokens(`${P}.0=${TOKEN_A}; ${P}X=${TOKEN_B}`, [P])).toEqual([]);
  });

  it.each([
    ["%-encoded", `${encodeURIComponent(TOKEN_A).replace("-", "%2D")}`],
    ["quoted", `"${TOKEN_A}"`],
    ["uppercase", TOKEN_A.toUpperCase()],
    ["empty", ""],
  ])("skips a value outside the token alphabet (%s)", (_label, value) => {
    expect(presentedSessionTokens(`${P}=${value}; ${P}=${TOKEN_B}`, [P])).toEqual([TOKEN_B]);
  });

  it("stops at a lower limit when the caller gives one", () => {
    expect(presentedSessionTokens(`${P}=${TOKEN_A}; ${P}=${TOKEN_B}; ${P}=0-${TOKEN_A}`, [P], 2)).toEqual([
      TOKEN_A,
      TOKEN_B,
    ]);
  });

  it("returns nothing for a missing header", () => {
    expect(presentedSessionTokens(null, [P])).toEqual([]);
  });

  it("stops at 16 distinct tokens", () => {
    const tokens = Array.from({ length: 20 }, (_, i) => `${i.toString(16)}-${TOKEN_A}`);
    const header = tokens.map((t) => `${P}=${t}`).join("; ");
    expect(presentedSessionTokens(header, [P])).toEqual(tokens.slice(0, 16));
  });
});

describe("hasAnySessionCookie", () => {
  it("sees every known name", () => {
    expect(hasAnySessionCookie(`__Host-authjs.session-token=${TOKEN_A}`)).toBe(true);
    expect(hasAnySessionCookie(`__Secure-authjs.session-token=${TOKEN_A}`)).toBe(true);
    expect(hasAnySessionCookie(`authjs.session-token=${TOKEN_A}`)).toBe(true);
    expect(hasAnySessionCookie(`next-auth.session-token=${TOKEN_A}`)).toBe(true);
  });

  it("sees chunk-named and other prefix-named session cookies", () => {
    expect(hasAnySessionCookie(`authjs.session-token.0=${TOKEN_A}`)).toBe(true);
    expect(hasAnySessionCookie(`__Secure-authjs.session-tokenX=${TOKEN_A}`)).toBe(true);
  });

  it("does not count an empty value, which SessionStore skips", () => {
    expect(hasAnySessionCookie("authjs.session-token=")).toBe(false);
    expect(hasAnySessionCookie("authjs.session-token.0=; other=1")).toBe(false);
    // Control: the same name with a value is seen.
    expect(hasAnySessionCookie(`authjs.session-token.0=${TOKEN_A}`)).toBe(true);
  });

  it("sees a whitespace-spelled key", () => {
    expect(hasAnySessionCookie(`foo=1;\tauthjs.session-token =${TOKEN_A}`)).toBe(true);
  });

  it("ignores unrelated and suffix-colliding names", () => {
    expect(hasAnySessionCookie("foo=bar")).toBe(false);
    expect(hasAnySessionCookie(`evil-authjs.session-token=${TOKEN_A}`)).toBe(false);
    expect(hasAnySessionCookie("")).toBe(false);
  });
});

/**
 * Differential against Auth.js's own parser + SessionStore. The safety
 * property: whenever readSessionCookie names a token, auth() resolves exactly
 * that token from the same header (and none ⇒ auth() resolves nothing). The
 * allow property: a header with one clean configured pair is always read.
 */
describe("readSessionCookie agrees with Auth.js (differential)", () => {
  afterEach(() => vi.unstubAllEnvs());

  // Deterministic PRNG so a failure reproduces.
  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  function corpus(name: string): string[] {
    const keys = [
      name,
      `${name}.0`,
      `${name}.1`,
      `${name}X`,
      "__Host-authjs.session-token",
      "__Secure-authjs.session-token",
      "authjs.session-token",
      "next-auth.session-token",
      "other",
    ];
    const values = [TOKEN_A, TOKEN_B, "", "%30b6f", `"${TOKEN_A}"`, "sess-1", "a b", "x=y"];
    const pads = ["", " ", "\t", " \t"];
    const seps = [";", "; ", " ;\t"];
    const pick = <T,>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const r = prng(0x5e55);
    const headers: string[] = [];
    for (let i = 0; i < 6000; i++) {
      const count = 1 + Math.floor(r() * 4);
      const segments: string[] = [];
      for (let j = 0; j < count; j++) {
        if (r() < 0.05) {
          segments.push("novalue");
          continue;
        }
        segments.push(`${pick(r, pads)}${pick(r, keys)}${pick(r, pads)}=${pick(r, pads)}${pick(r, values)}${pick(r, pads)}`);
      }
      let header = segments[0];
      for (const segment of segments.slice(1)) header += pick(r, seps) + segment;
      headers.push(header);
    }
    return headers;
  }

  for (const [label, deployment] of Object.entries(DEPLOYMENTS)) {
    it(`never names a token auth() would not resolve (${label})`, async () => {
      stubDeployment(deployment.env);
      const name = deployment.name;
      let tokens = 0;
      let nones = 0;
      let refusals = 0;
      let seenUnderKnownName = 0;
      for (const raw of corpus(name)) {
        const { request, delivered: header } = deliver(raw);
        const read = readSessionCookie(header);
        const cookies = await authjsCookies(request);
        const resolved = authjsSessionToken(cookies, name);
        // The CSRF gate and the Bearer-bypass decision rest on this: any
        // header from which auth() could resolve a session, under any name a
        // deployment might configure, counts as carrying one.
        for (const knownName of ALL_KNOWN_SESSION_COOKIE_NAMES) {
          if (authjsSessionToken(cookies, knownName) !== "") {
            seenUnderKnownName++;
            expect({ header, knownName, has: hasAnySessionCookie(header) }).toEqual({
              header,
              knownName,
              has: true,
            });
          }
        }
        if (read.kind === SESSION_COOKIE_READ.TOKEN) {
          tokens++;
          expect({ header, resolved }).toEqual({ header, resolved: read.token });
        } else if (read.kind === SESSION_COOKIE_READ.NONE) {
          nones++;
          expect({ header, resolved }).toEqual({ header, resolved: "" });
        } else {
          refusals++;
        }
      }
      // The corpus must exercise every arm or the property is vacuous.
      expect(tokens).toBeGreaterThan(100);
      expect(nones).toBeGreaterThan(100);
      expect(refusals).toBeGreaterThan(100);
      expect(seenUnderKnownName).toBeGreaterThan(100);
    });

    it(`reads every header with one clean configured pair (${label})`, async () => {
      stubDeployment(deployment.env);
      const name = deployment.name;
      const r = prng(0xa11);
      const others = ["other=1", "__Host-authjs.session-token=zz", "next-auth.session-token=q", "csrf=a%20b"]
        .filter((c) => !c.startsWith(name));
      for (let i = 0; i < 500; i++) {
        const segments = others.filter(() => r() < 0.5);
        const pad = r() < 0.5 ? " " : "\t";
        segments.splice(Math.floor(r() * (segments.length + 1)), 0, `${pad}${name}${pad}=${pad}${TOKEN_A}`);
        const { request, delivered: header } = deliver(segments.join(";"));
        expect({ header, read: readSessionCookie(header) }).toEqual({ header, read: token(TOKEN_A) });
        expect(authjsSessionToken(await authjsCookies(request), name)).toBe(TOKEN_A);
      }
    });
  }
});
