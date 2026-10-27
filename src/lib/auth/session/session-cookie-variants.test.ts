import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteOtherSessionCookieVariantFirst,
  sessionCookieDeletionLine,
} from "./session-cookie-variants";

const TOKEN = "0b6f1c2e-8d4a-4f7e-9a1b-3c5d7e9f0a2b";
const HOST = "__Host-authjs.session-token";
const SECURE = "__Secure-authjs.session-token";

const isPartitioned = (line: string) => /;\s*Partitioned/i.test(line);
const isDeletion = (line: string) => /;\s*Max-Age=0/i.test(line) || /Expires=Thu, 01 Jan 1970/i.test(line);
const nameOf = (line: string) => line.slice(0, line.indexOf("="));

describe("sessionCookieDeletionLine", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_URL", "https://app.example.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([true, false])("deletes one variant at the cookie path, Secure (partitioned=%s)", (partitioned) => {
    const line = sessionCookieDeletionLine(SECURE, "/passwd-sso", partitioned);
    expect(nameOf(line)).toBe(SECURE);
    expect(line.startsWith(`${SECURE}=;`)).toBe(true);
    expect(isDeletion(line)).toBe(true);
    expect(line).toMatch(/;\s*Path=\/passwd-sso\/(;|$)/);
    expect(line).toMatch(/;\s*Secure/i);
    expect(line).not.toMatch(/;\s*Domain=/i);
    expect(isPartitioned(line)).toBe(partitioned);
  });

  it("omits Secure over http", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    expect(sessionCookieDeletionLine("authjs.session-token", "", false)).not.toMatch(/;\s*Secure/i);
  });
});

describe("deleteOtherSessionCookieVariantFirst", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_URL", "https://app.example.test");
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const setLine = (partitioned: boolean) =>
    `${HOST}=${TOKEN}; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax${partitioned ? "; Partitioned" : ""}`;

  it.each([
    ["partitioned", true],
    ["unpartitioned", false],
  ])("deletes the other variant immediately before a %s session cookie write", (_label, partitioned) => {
    const before = ["authjs.callback-url=; Path=/; Max-Age=0", setLine(partitioned), "x=1; Path=/"];
    const after = deleteOtherSessionCookieVariantFirst(before, "");
    expect(after).toHaveLength(4);
    expect(after[0]).toBe(before[0]);
    expect(nameOf(after[1])).toBe(HOST);
    expect(isDeletion(after[1])).toBe(true);
    expect(isPartitioned(after[1])).toBe(!partitioned);
    expect(after[1]).toMatch(/;\s*Path=\/(;|$)/);
    expect(after.slice(2)).toEqual(before.slice(1));
  });

  // Sign-out: Auth.js deletes the variant its options name; the other one
  // goes too.
  it("deletes the other variant before Auth.js's own deletion", () => {
    const authjsDeletion = sessionCookieDeletionLine(HOST, "", true);
    const after = deleteOtherSessionCookieVariantFirst([authjsDeletion], "");
    expect(after).toHaveLength(2);
    expect(isPartitioned(after[0])).toBe(false);
    expect(isDeletion(after[0])).toBe(true);
    expect(after[1]).toBe(authjsDeletion);
  });

  it("inserts once, before the first line naming the session cookie", () => {
    const after = deleteOtherSessionCookieVariantFirst([setLine(true), setLine(true)], "");
    expect(after.filter((line) => isDeletion(line))).toHaveLength(1);
    expect(isDeletion(after[0])).toBe(true);
  });

  it("leaves a response that does not name the session cookie alone", () => {
    const lines = ["authjs.csrf-token=abc; Path=/", `${HOST}.0=x; Path=/`];
    expect(deleteOtherSessionCookieVariantFirst(lines, "")).toEqual(lines);
  });

  // Partitioned requires Secure, so over http there is no other variant.
  it("leaves the lines alone over http", () => {
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    const lines = [`authjs.session-token=${TOKEN}; Path=/; HttpOnly; SameSite=Lax`];
    expect(deleteOtherSessionCookieVariantFirst(lines, "")).toEqual(lines);
  });

  it("uses the basePath cookie path and the __Secure- name under a basePath", () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/passwd-sso");
    const line = `${SECURE}=${TOKEN}; Path=/passwd-sso/; HttpOnly; Secure; SameSite=Lax`;
    const after = deleteOtherSessionCookieVariantFirst([line], "/passwd-sso");
    expect(after).toHaveLength(2);
    expect(nameOf(after[0])).toBe(SECURE);
    expect(after[0]).toMatch(/;\s*Path=\/passwd-sso\/(;|$)/);
    expect(isPartitioned(after[0])).toBe(true);
  });
});
