import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
// Auth.js's own parser and session-cookie collector, imported by file path:
// neither is in @auth/core's package `exports`. A static import fails this
// whole file loudly if the layout moves, rather than skipping the
// differential silently.
import { parse as authjsParse } from "../../../../node_modules/@auth/core/lib/vendored/cookie.js";
import { SessionStore } from "../../../../node_modules/@auth/core/lib/utils/cookie.js";
import {
  hasAnySessionCookie,
  parseCookiePairs,
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

/** What `auth()` resolves the session token to from this Cookie header. */
function authjsSessionToken(header: string, name: string): string {
  return new SessionStore({ name, options: {} }, authjsParse(header), console).value;
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
    it(`never names a token auth() would not resolve (${label})`, () => {
      stubDeployment(deployment.env);
      const name = deployment.name;
      let tokens = 0;
      let refusals = 0;
      for (const header of corpus(name)) {
        const read = readSessionCookie(header);
        const resolved = authjsSessionToken(header, name);
        if (read.kind === SESSION_COOKIE_READ.TOKEN) {
          tokens++;
          expect({ header, resolved }).toEqual({ header, resolved: read.token });
        } else if (read.kind === SESSION_COOKIE_READ.NONE) {
          expect({ header, resolved }).toEqual({ header, resolved: "" });
        } else {
          refusals++;
        }
      }
      // The corpus must exercise both arms or the property is vacuous.
      expect(tokens).toBeGreaterThan(100);
      expect(refusals).toBeGreaterThan(100);
    });

    it(`reads every header with one clean configured pair (${label})`, () => {
      stubDeployment(deployment.env);
      const name = deployment.name;
      const r = prng(0xa11);
      const others = ["other=1", "__Host-authjs.session-token=zz", "next-auth.session-token=q", "csrf=a%20b"]
        .filter((c) => !c.startsWith(name));
      for (let i = 0; i < 500; i++) {
        const segments = others.filter(() => r() < 0.5);
        const pad = r() < 0.5 ? " " : "\t";
        segments.splice(Math.floor(r() * (segments.length + 1)), 0, `${pad}${name}${pad}=${pad}${TOKEN_A}`);
        const header = segments.join(";");
        expect({ header, read: readSessionCookie(header) }).toEqual({ header, read: token(TOKEN_A) });
        expect(authjsSessionToken(header, name)).toBe(TOKEN_A);
      }
    });
  }
});
