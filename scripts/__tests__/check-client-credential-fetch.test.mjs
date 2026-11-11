/**
 * Self-test for scripts/checks/check-client-credential-fetch.mjs — proves the
 * redirect axis and the Authorization tripwire can both fire and stay quiet,
 * and that stripping `redirect` from a real shipped file turns the gate red.
 * Fixtures live in a temp directory; the real tree is only ever read.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-client-credential-fetch.mjs");

let root, cliRoot, extRoot;

function runGuard(env = {}) {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, CLIENT_CREDENTIAL_CLI_ROOT: cliRoot, CLIENT_CREDENTIAL_EXT_ROOT: extRoot, ...env },
  });
  return { exitCode: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

function write(base, rel, contents) {
  const full = join(base, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}
const cli = (rel, c) => write(cliRoot, rel, c);
const ext = (rel, c) => write(extRoot, rel, c);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "client-credential-fetch-"));
  cliRoot = join(root, "cli-src");
  extRoot = join(root, "ext-src");
  // Neutral file so neither root is empty (an empty root is itself an error).
  cli("placeholder.ts", "export const x = 1;\n");
  ext("placeholder.ts", "export const x = 1;\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function expectFail(substr) {
  const r = runGuard();
  expect(r.exitCode).toBe(1);
  if (substr) expect(r.out).toContain(substr);
}

describe("check-client-credential-fetch.mjs — redirect axis", () => {
  it("passes an inline redirect: error", () => {
    cli("a.ts", 'export const f = (u: string) => fetch(u, { method: "GET", redirect: "error" });\n');
    expect(runGuard().exitCode).toBe(0);
  });

  it("passes redirect: manual", () => {
    cli("a.ts", 'export const f = (u: string) => fetch(u, { redirect: "manual" });\n');
    expect(runGuard().exitCode).toBe(0);
  });

  it("passes a same-function const init identifier", () => {
    cli(
      "a.ts",
      'export async function f(u: string) {\n  const fetchOpts = { method: "GET", redirect: "error" as const };\n  let r = await fetch(u, fetchOpts);\n  r = await fetch(u, fetchOpts);\n  return r;\n}\n',
    );
    expect(runGuard().exitCode).toBe(0);
  });

  it("passes a spread BEFORE redirect", () => {
    cli("a.ts", 'export const f = (u: string, o: RequestInit) => fetch(u, { ...o, redirect: "error" });\n');
    expect(runGuard().exitCode).toBe(0);
  });

  it("passes an alias call that pins redirect, and typeof fetch in a type", () => {
    ext(
      "a.ts",
      'export interface C { fetchImpl?: typeof fetch }\nexport function g(c: C, u: string) {\n  const fetchFn = c.fetchImpl ?? fetch;\n  return fetchFn(u, { redirect: "error" });\n}\n',
    );
    expect(runGuard().exitCode).toBe(0);
  });

  it("passes a call whose result is bound to a const (not an alias)", () => {
    cli("a.ts", 'export async function f(u: string) {\n  const res = await fetch(u, { redirect: "error" });\n  return res.ok;\n}\n');
    expect(runGuard().exitCode).toBe(0);
  });

  it("FAILS on a missing init", () => {
    cli("a.ts", "export const f = (u: string) => fetch(u);\n");
    expectFail("no init argument");
  });

  it("FAILS on an init without redirect", () => {
    cli("a.ts", 'export const f = (u: string) => fetch(u, { method: "GET" });\n');
    expectFail("no `redirect` property");
  });

  it("FAILS on redirect: follow", () => {
    cli("a.ts", 'export const f = (u: string) => fetch(u, { redirect: "follow" });\n');
    expectFail("not the string literal");
  });

  it("FAILS on a non-literal redirect value", () => {
    cli("a.ts", "export const f = (u: string, m: any) => fetch(u, { redirect: m });\n");
    expectFail("not the string literal");
  });

  it("FAILS on an unreadable init (parameter)", () => {
    cli("a.ts", "export const f = (u: string, o: RequestInit) => fetch(u, o);\n");
    expectFail("does not resolve");
  });

  it("FAILS when redirect precedes a spread that can override it", () => {
    cli("a.ts", 'export const f = (u: string, o: RequestInit) => fetch(u, { redirect: "error", ...o });\n');
    expectFail("before a spread");
  });

  it("FAILS on a const init identifier whose literal lacks redirect", () => {
    cli("a.ts", 'export function f(u: string) {\n  const opts = { method: "GET" };\n  return fetch(u, opts);\n}\n');
    expectFail("no `redirect` property");
  });

  it("FAILS on globalThis.fetch / window.fetch / self.fetch without redirect", () => {
    for (const g of ["globalThis", "window", "self"]) {
      cli("a.ts", `export const f = (u: string) => ${g}.fetch(u, {});\n`);
      expectFail("no `redirect` property");
    }
  });

  it("FAILS on an alias call without redirect", () => {
    ext("a.ts", "export function g(c: any, u: string) {\n  const fetchFn = c.fetchImpl ?? fetch;\n  return fetchFn(u, {});\n}\n");
    expectFail("no `redirect` property");
  });

  it("FAILS on an unclassified reference (fetch passed as a value)", () => {
    cli("a.ts", "export const h = (run: (f: typeof fetch) => void) => run(fetch);\n");
    expectFail("unclassified fetch reference");
  });

  it("FAILS on a let alias (not a const initializer)", () => {
    cli("a.ts", 'let f = fetch;\nexport const g = (u: string) => f(u, { redirect: "error" });\n');
    expectFail("unclassified fetch reference");
  });

  it("FAILS on a shorthand { fetch } reference", () => {
    cli("a.ts", "export const o = { fetch };\n");
    expectFail("unclassified fetch reference");
  });

  it("FAILS when a root has no source files", () => {
    rmSync(join(cliRoot, "placeholder.ts"));
    expectFail("no scannable source files");
  });

  it("FAILS when a parameter shadows the const init's name", () => {
    cli(
      "a.ts",
      'const init = { redirect: "error" as const };\nexport const g = (u: string) => fetch(u, init);\nexport function f(u: string, init: RequestInit) {\n  return fetch(u, init);\n}\n',
    );
    expectFail("declared more than once");
  });

  it("FAILS when an inner let shadows the const init's name", () => {
    cli(
      "a.ts",
      'const init = { redirect: "error" as const };\nexport function f(u: string, o: RequestInit) {\n  {\n    let init = o;\n    void init;\n  }\n  return fetch(u, init);\n}\n',
    );
    expectFail("declared more than once");
  });

  it.each([
    ["assigned", 'opts.redirect = "follow";'],
    ["assigned through a string key", 'opts["redirect"] = "follow";'],
    ["assigned through a computed key", 'opts[k] = "follow";'],
    ["deleted", "delete (opts as Partial<RequestInit>).redirect;"],
    ["merged with Object.assign", "Object.assign(opts, o);"],
  ])("FAILS when the const init's redirect is %s after declaration", (_label, write) => {
    cli(
      "a.ts",
      `export function f(u: string, o: RequestInit, k: string) {\n  const opts: RequestInit & Record<string, unknown> = { redirect: "error" };\n  ${write}\n  return fetch(u, opts);\n}\n`,
    );
    expectFail("is written through");
  });

  it("passes when another property of the const init is assigned", () => {
    cli(
      "a.ts",
      'export function f(u: string, h: Record<string, string>) {\n  const opts: RequestInit = { redirect: "error" };\n  opts.headers = h;\n  return fetch(u, opts);\n}\n',
    );
    expect(runGuard().exitCode).toBe(0);
  });

  it("scans .js files", () => {
    ext("content/x.js", "export const f = (u) => fetch(u);\n");
    expectFail("fetch call without a pinned redirect");
  });

  it("FAILS on an init that is a call, not an object literal", () => {
    cli("a.ts", "const mk = (): RequestInit => ({});\nexport const f = (u: string) => fetch(u, mk());\n");
    expectFail("init is not an object literal");
  });

  it("FAILS on a computed key after redirect", () => {
    cli("a.ts", 'export const f = (u: string, k: string) => fetch(u, { redirect: "error", [k]: "follow" });\n');
    expectFail("computed property key");
  });

  it('FAILS on a globalThis["fetch"] call without redirect', () => {
    cli("a.ts", 'export const f = (u: string) => globalThis["fetch"](u);\n');
    expectFail("fetch call without a pinned redirect");
  });

  it('FAILS on globalThis["fetch"] used as a value', () => {
    cli("a.ts", 'export const run = (g: (f: unknown) => void) => g(globalThis["fetch"]);\n');
    expectFail("unclassified fetch reference");
  });

  it("FAILS on an import of a binding named fetch", () => {
    cli("a.ts", 'import { fetch } from "undici";\nexport const f = (u: string) => fetch(u, { redirect: "error" });\n');
    expectFail("import/export of a binding named fetch");
  });

  it("FAILS on an alias used as a value", () => {
    cli("a.ts", "const doFetch = fetch;\nexport const run = (g: (f: unknown) => void) => g(doFetch);\n");
    expectFail("unclassified fetch reference");
  });

  it("FAILS on a file with a syntax error", () => {
    cli("a.ts", 'export const f = (u: string) => fetch(u, { redirect: "error" ;\n');
    expectFail("failed to parse");
  });

  it("FAILS on a file that cannot be read", () => {
    cli("a.ts", "export const x = 1;\n");
    chmodSync(join(cliRoot, "a.ts"), 0o000);
    expectFail("failed to read");
  });

  it("ignores test files", () => {
    cli("a.test.ts", "export const f = (u: string) => fetch(u);\n");
    cli("__tests__/b.ts", "export const f = (u: string) => fetch(u);\n");
    expect(runGuard().exitCode).toBe(0);
  });
});

describe("check-client-credential-fetch.mjs — Authorization tripwire", () => {
  it("FAILS on an Authorization property outside the allowlist", () => {
    ext("lib/x.ts", 'export const h = { Authorization: "Bearer t" };\n');
    expectFail("Authorization header property");
  });

  it("FAILS on a string-keyed authorization property", () => {
    ext("lib/x.ts", 'export const h = { "authorization": "Bearer t" };\n');
    expectFail("Authorization header property");
  });

  it('FAILS on xhr.setRequestHeader("Authorization", …)', () => {
    ext("lib/x.ts", 'export const f = (x: XMLHttpRequest) => x.setRequestHeader("Authorization", "Bearer t");\n');
    expectFail('setRequestHeader("Authorization", …)');
  });

  it('FAILS on headers.set("Authorization", …)', () => {
    ext("lib/x.ts", 'export const f = (h: Headers) => h.set("Authorization", "Bearer t");\n');
    expectFail("outside the allowlist");
  });

  it('FAILS on h["Authorization"] = …', () => {
    ext("lib/x.ts", 'export const f = (h: Record<string, string>) => { h["Authorization"] = "Bearer t"; };\n');
    expectFail("Authorization header assignment");
  });

  it('FAILS on headers.append("Authorization", …)', () => {
    ext("lib/x.ts", 'export const f = (h: Headers) => h.append("Authorization", "Bearer t");\n');
    expectFail('append("Authorization", …)');
  });

  it("FAILS on a shorthand { Authorization } property", () => {
    ext("lib/x.ts", "export const f = (Authorization: string) => ({ Authorization });\n");
    expectFail("Authorization header property");
  });

  it("passes Authorization in an allowlisted file", () => {
    ext("background/dpop-fetch.ts", 'export const f = (h: Headers) => h.set("Authorization", "Bearer t");\n');
    ext("options/App.tsx", 'export const h = { "Authorization": "Bearer t" };\n');
    expect(runGuard().exitCode).toBe(0);
  });

  it("does not apply the tripwire under cli/src", () => {
    cli("a.ts", 'export const h = { Authorization: "Bearer t" };\n');
    expect(runGuard().exitCode).toBe(0);
  });
});

describe("check-client-credential-fetch.mjs — real repository", () => {
  it("the real repository passes", () => {
    const r = spawnSync("node", [GUARD], { encoding: "utf8" });
    expect(r.status, (r.stdout ?? "") + (r.stderr ?? "")).toBe(0);
  });

  it("MUTATION: stripping redirect from a copy of cli/src/commands/env.ts fails the gate", () => {
    const real = readFileSync(join(REPO_ROOT, "cli/src/commands/env.ts"), "utf8");
    // Positive control: the unmodified copy passes.
    cli("commands/env.ts", real);
    expect(runGuard().exitCode).toBe(0);
    const mutated = real.replace(/^\s*redirect:\s*"error",?\s*$/m, "");
    expect(mutated).not.toBe(real);
    cli("commands/env.ts", mutated);
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("commands/env.ts");
  });

  it("MUTATION: stripping redirect from a copy of cli/src/lib/api-client.ts (const-init shape) fails the gate", () => {
    const real = readFileSync(join(REPO_ROOT, "cli/src/lib/api-client.ts"), "utf8");
    cli("lib/api-client.ts", real);
    expect(runGuard().exitCode).toBe(0);
    const mutated = real.replace(/^\s*redirect:\s*"error",?\s*$/m, "");
    expect(mutated).not.toBe(real);
    cli("lib/api-client.ts", mutated);
    expect(runGuard().exitCode).toBe(1);
  });
});
