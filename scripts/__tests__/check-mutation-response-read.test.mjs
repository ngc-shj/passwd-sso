/**
 * Self-test for check-mutation-response-read.mjs (plan:
 * close-coverage-and-clipboard-gaps, C11). Each row runs the real CLI against an
 * isolated fixture tree (mkdtemp + MUTATION_RESPONSE_READ_ROOT), never the
 * tracked repo files.
 *
 * Deny: a literal POST, an unresolvable method, the `.then(r => r.json())`
 * form, and the other tracked shapes, in src/components, src/hooks, src/app
 * pages and src/lib client modules. Allow: a GET, `parseJsonBodyOnce`, a
 * src/lib server module, a route handler.
 * Refuse: an empty file set and a parse error.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../checks/check-mutation-response-read.mjs", import.meta.url));

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function run(files, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "mutation-response-read-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  try {
    const stdout = execFileSync("node", [CHECKER], {
      env: {
        ...process.env,
        MUTATION_RESPONSE_READ_ROOT: root,
        MUTATION_RESPONSE_READ_FIXTURE_MODE: "1",
        ...env,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

const PRELUDE =
  "declare function fetchApi(path: string, init?: RequestInit): Promise<Response>;\n" +
  "declare function parseJsonBodyOnce(res: Response): Promise<unknown>;\n";

// One client module whose handler body is `body`.
const component = (body) => `${PRELUDE}export async function handler(m: string) {\n${body}\n}\n`;

describe("check-mutation-response-read", () => {
  it.each([
    [
      "a literal POST",
      '  const res = await fetchApi("/x", { method: "POST" });\n  return res.json();',
      "src/components/a.tsx:5",
    ],
    [
      "a lower-case literal DELETE",
      '  const res = await fetchApi("/x", { method: "delete" });\n  return res.json();',
      "src/components/a.tsx:5",
    ],
    [
      "an unresolvable method (a parameter)",
      '  const res = await fetchApi("/x", { method: m });\n  return res.json();',
      "src/components/a.tsx:5",
    ],
    [
      "an unresolvable init (a spread)",
      '  const opts = { method: "GET" };\n  const res = await fetchApi("/x", { ...opts, ...JSON.parse(m) });\n  return res.json();',
      "src/components/a.tsx:6",
    ],
    [
      "an init that is not a local const literal",
      '  const res = await fetchApi("/x", JSON.parse(m));\n  return res.json();',
      "src/components/a.tsx:5",
    ],
    [
      "a conditional method with one mutating branch",
      '  const res = await fetchApi("/x", { method: m ? "GET" : "PUT" });\n  return res.json();',
      "src/components/a.tsx:5",
    ],
    [
      "a .then((r) => r.json()) form",
      '  return fetchApi("/x", { method: "POST" }).then((r) => r.json());',
      "src/components/a.tsx:4",
    ],
    [
      "a .then(function (r) { return r.json(); }) form",
      '  return fetchApi("/x", { method: "PATCH" }).then(function (r) { return r.json(); });',
      "src/components/a.tsx:4",
    ],
    [
      "an inline (await fetchApi(...)).json()",
      '  return (await fetchApi("/x", { method: "POST" })).json();',
      "src/components/a.tsx:4",
    ],
    [
      "a promise held in a const, then awaited",
      '  const p = fetchApi("/x", { method: "POST" });\n  return (await p).json();',
      "src/components/a.tsx:5",
    ],
    [
      "a let assigned later",
      '  let res: Response;\n  res = await fetchApi("/x", { method: "POST" });\n  return res.json();',
      "src/components/a.tsx:6",
    ],
    [
      "a method held in a local const",
      '  const method = "POST";\n  const res = await fetchApi("/x", { method });\n  return res.json();',
      "src/components/a.tsx:6",
    ],
    [
      "either branch of cond ? await a : await b",
      '  const res = m ? await fetchApi("/a") : await fetchApi("/b", { method: "DELETE" });\n  return res.json();',
      "src/components/a.tsx:5",
    ],
    [
      "a .json().catch(() => null) read",
      '  const res = await fetchApi("/x", { method: "POST" });\n  return res.json().catch(() => null);',
      "src/components/a.tsx:5",
    ],
  ])("denies %s", (_label, body, site) => {
    const r = run({ "src/components/a.tsx": component(body) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MUTATION_RESPONSE_JSON_READ: 1 read(s)");
    expect(r.stderr).toContain(site);
  });

  it("denies in src/hooks and src/app pages too", () => {
    const body = '  const res = await fetchApi("/x", { method: "POST" });\n  return res.json();';
    const r = run({ "src/hooks/use-a.ts": component(body), "src/app/[locale]/p/page.tsx": component(body) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MUTATION_RESPONSE_JSON_READ: 2 read(s)");
    expect(r.stderr).toContain("src/hooks/use-a.ts:5");
    expect(r.stderr).toContain("src/app/[locale]/p/page.tsx:5");
  });

  it("denies a parameter that defaults to fetchApi", () => {
    const r = run({
      "src/components/a.ts":
        PRELUDE +
        "export async function f(fetcher: typeof fetchApi = fetchApi) {\n" +
        '  const res = await fetcher("/x", { method: "POST" });\n' +
        "  return res.json();\n}\n",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("src/components/a.ts:5  .json() on the response of fetcher(…)");
  });

  it("denies an injected x.fetchApi", () => {
    const r = run({
      "src/components/a.ts":
        PRELUDE +
        "export async function f(deps: { fetchApi: typeof fetchApi }) {\n" +
        '  const res = await deps.fetchApi("/x", { method: "POST" });\n' +
        "  return res.json();\n}\n",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("src/components/a.ts:5");
  });

  it("denies the response of a src/lib helper that returns a mutating fetchApi call", () => {
    const r = run({
      "src/lib/save.ts":
        PRELUDE + 'export function save(body: string) {\n  return fetchApi("/x", { method: "PUT", body });\n}\n',
      "src/components/a.tsx":
        'import { save } from "@/lib/save";\n' +
        "export async function f() {\n  const res = await save(\"b\");\n  return res.json();\n}\n",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("src/components/a.tsx:4  .json() on the response of save(…)");
  });

  it("denies the response of a helper that forwards its init, called with a mutating method", () => {
    const r = run({
      "src/lib/send.ts":
        PRELUDE + "export function send(path: string, init?: RequestInit) {\n  return fetchApi(path, init);\n}\n",
      "src/components/a.tsx":
        'import { send } from "@/lib/send";\n' +
        "export async function f() {\n" +
        '  const ok = await send("/a");\n  await ok.json();\n' +
        '  const res = await send("/x", { method: "POST" });\n  return res.json();\n}\n',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MUTATION_RESPONSE_JSON_READ: 1 read(s)");
    expect(r.stderr).toContain("src/components/a.tsx:6");
  });

  it("denies a useCallback-wrapped helper's response", () => {
    const r = run({
      "src/components/a.tsx":
        PRELUDE +
        "declare function useCallback<T>(fn: T, deps: unknown[]): T;\n" +
        "export function C() {\n" +
        '  const create = useCallback(async () => fetchApi("/x", { method: "POST" }), []);\n' +
        "  return async () => {\n    const res = await create();\n    return res.json();\n  };\n}\n",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(".json() on the response of create(…)");
  });

  it.each([
    ["an absent init (GET)", '  const res = await fetchApi("/x");\n  return res.json();'],
    ["an explicit GET", '  const res = await fetchApi("/x", { method: "GET" });\n  return res.json();'],
    ["a HEAD", '  const res = await fetchApi("/x", { method: "HEAD" });\n  return res.json();'],
    ["an options literal without a method", '  const res = await fetchApi("/x", { cache: "no-store" });\n  return res.json();'],
    ["a GET .then((r) => r.json())", '  return fetchApi("/x").then((r) => r.json());'],
    [
      "parseJsonBodyOnce on a POST",
      '  const res = await fetchApi("/x", { method: "POST" });\n  return parseJsonBodyOnce(res);',
    ],
    [
      "a POST whose response is never read",
      '  const res = await fetchApi("/x", { method: "POST" });\n  return res.ok;',
    ],
  ])("allows %s", (_label, body) => {
    const r = run({ "src/components/a.tsx": component(body) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-mutation-response-read: OK (1 files");
  });

  it("allows a same-named binding in another function that holds a GET", () => {
    const r = run({
      "src/components/a.tsx":
        PRELUDE +
        'export async function a() {\n  const res = await fetchApi("/x", { method: "POST" });\n  return res.ok;\n}\n' +
        'export async function b() {\n  const res = await fetchApi("/y");\n  return res.json();\n}\n',
    });
    expect(r.code).toBe(0);
  });

  it("does not deny src/app/api route handlers", () => {
    const body = '  const res = await fetchApi("/x", { method: "POST" });\n  return res.json();';
    const r = run({
      "src/components/ok.tsx": "export const ok = 1;\n",
      "src/app/api/x/route.ts": component(body),
    });
    expect(r.code).toBe(0);
  });

  // src/lib: every module is client code unless a value import marks it as
  // server code (server-only, next/headers, the Prisma singleton).
  const POST_READ = '  const res = await fetchApi("/x", { method: "POST" });\n  return res.json();';
  const libModule = (header, body) => `${header}${component(body)}`;

  it.each([
    ["a module with no marker", ""],
    ['a "use client" module', '"use client";\n'],
    ["a module that only type-imports the Prisma singleton", 'import type { prisma } from "@/lib/prisma";\n'],
    ["a module whose Prisma import binds only types", 'import { type prisma } from "@/lib/prisma";\n'],
  ])("denies a mutation read in a src/lib client module: %s", (_label, header) => {
    const r = run({ "src/lib/vault/x.tsx": libModule(header, POST_READ) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MUTATION_RESPONSE_JSON_READ: 1 read(s)");
    const line = 5 + header.split("\n").length - 1;
    expect(r.stderr).toContain(`src/lib/vault/x.tsx:${line}`);
  });

  it.each([
    ["server-only", 'import "server-only";\n'],
    ["next/headers", 'import { headers } from "next/headers";\n'],
    ["the Prisma singleton", 'import { prisma } from "@/lib/prisma";\n'],
    ["the Prisma singleton by a relative path", 'import { prisma } from "../prisma";\n'],
  ])("allows a mutation read in a src/lib server module importing %s", (_label, header) => {
    const r = run({
      "src/components/ok.tsx": "export const ok = 1;\n",
      "src/lib/vault/x.ts": libModule(header, POST_READ),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK (1 files");
  });

  it("allows a GET read in a src/lib client module", () => {
    const r = run({ "src/lib/vault/x.ts": component('  const res = await fetchApi("/x");\n  return res.json();') });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK (1 files");
  });

  it("skips test files", () => {
    const r = run({
      "src/components/a.tsx": "export const ok = 1;\n",
      "src/components/a.test.tsx": component('  const res = await fetchApi("/x", { method: "POST" });\n  return res.json();'),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK (1 files");
  });

  it("refuses an unparseable file", () => {
    const r = run({ "src/components/ok.ts": "export const ok = 1;\n", "src/components/broken.ts": "export const = ;\n" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("PARSE_ERROR");
    expect(r.stderr).toContain("src/components/broken.ts");
  });

  it("refuses an empty file set", () => {
    const r = run({ "README.md": "no sources here\n" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ZERO_FILES_SCANNED");
  });

  it("refuses the root override in CI without fixture mode", () => {
    const r = run({ "src/components/a.ts": "export const ok = 1;\n" }, { CI: "true", MUTATION_RESPONSE_READ_FIXTURE_MODE: "" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MUTATION_RESPONSE_READ_ROOT must not be set in CI");
  });
});
