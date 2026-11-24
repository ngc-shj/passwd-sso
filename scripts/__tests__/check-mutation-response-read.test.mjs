/**
 * Self-test for check-mutation-response-read.mjs (plan:
 * close-coverage-and-clipboard-gaps, C11). Each row runs the real CLI against an
 * isolated fixture tree (mkdtemp + MUTATION_RESPONSE_READ_ROOT), never the
 * tracked repo files.
 *
 * Deny: a literal POST, an unresolvable method, the `.then(r => r.json())`
 * form, every body reader (`text`, `blob`, `arrayBuffer`, `formData`, `bytes`)
 * and `res.clone().json()`, and the other tracked shapes (`.catch`/`.finally`, `.then` chains,
 * `["json"]`, destructured `json`, aliases, `Promise.all`/`allSettled`
 * elements, and the unresolvable combinator shapes that fail closed), in
 * src/components, src/hooks, src/app pages and src/lib client modules, and in a
 * component or page that imports a server marker; a helper reached through an
 * import, resolved through its specifier (S4-4); a helper default-exported by
 * name, anonymously, or as an unresolvable expression (S5-2); the receiver of
 * each allowlisted fetchApi injection site.
 * Refused (FETCH_API_VALUE_USE, R6): fetchApi in any position other than a
 * direct call or an import by its own name — every alias, re-export, member,
 * namespace/default import, `export *` and loader spelling of rounds 4-6 —
 * and an injection outside FETCH_API_INJECTIONS or a stale entry.
 * Allow: a GET,
 * `parseJsonBodyOnce`, a src/lib server module (each marker form, including a
 * mixed type/value import and a namespace import), a route handler, each
 * allowlisted injection site, and the permitted fetchApi spellings.
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

// Every fixture tree is resolved as the repository is: a tsconfig.json mapping
// `@/` to src/, and the packages its rows load installed under node_modules
// from the registry, as the lockfile records them.
const PACKAGES = ["some-package", "hash-wasm", "@scope/pkg", "next"];
const TREE = {
  "package-lock.json": JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "fixture" },
      ...Object.fromEntries(
        PACKAGES.map((pkg) => [
          `node_modules/${pkg}`,
          { version: "1.0.0", resolved: `https://registry.npmjs.org/${pkg}/-/${pkg.split("/").pop()}-1.0.0.tgz`, integrity: "sha512-fixture" },
        ]),
      ),
    },
  }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", allowJs: true, jsx: "react-jsx", paths: { "@/*": ["./src/*"] } } }),
  ...Object.fromEntries(
    PACKAGES.filter((pkg) => pkg !== "next").flatMap((pkg) => [
      [`node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, types: "index.d.ts" })],
      [`node_modules/${pkg}/index.d.ts`, "export declare function send(path: string): Promise<Response>;\n"],
    ]),
  ),
  "node_modules/next/package.json": JSON.stringify({ name: "next" }),
  "node_modules/next/headers.d.ts": "export declare function headers(): Headers;\n",
};

function run(files, env = {}) {
  const root = mkdtempSync(join(tmpdir(), "mutation-response-read-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries({ ...TREE, ...files })) {
    if (content === null) continue;
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

  // S3-4: each shape below exited 0 before the response was followed through
  // promise combinators, `.then` returns, aliases, element access and
  // destructuring.
  const POST = 'fetchApi("/x", { method: "POST" })';
  const READ = "body read on";
  it.each([
    ["a .catch(() => null) promise, then res?.json()", `  const res = await ${POST}.catch(() => null);\n  return res?.json();`, 5, READ],
    ["a .finally(...) promise", `  const res = await ${POST}.finally(() => undefined);\n  return res.json();`, 5, READ],
    ["a .then((r) => r).then((r) => r.json()) chain", `  return ${POST}.then((r) => r).then((r) => r.json());`, 4, READ],
    ['an element access res["json"]()', `  const res = await ${POST};\n  return res["json"]();`, 5, READ],
    ["a computed member res[key]()", `  const res = await ${POST};\n  return res[m as "json"]();`, 5, READ],
    ["json destructured from the awaited response", `  const { json } = await ${POST};\n  return json();`, 4, READ],
    ["json destructured in a .then callback parameter", `  return ${POST}.then(({ json }) => json());`, 4, READ],
    ["an alias const r2 = res", `  const res = await ${POST};\n  const r2 = res;\n  return r2.json();`, 6, READ],
    [
      "an array-destructured Promise.all element",
      `  const [a, b] = await Promise.all([fetchApi("/a"), ${POST}]);\n  await a.json();\n  return b.json();`,
      6,
      READ,
    ],
    [
      "an index-accessed Promise.all element",
      `  const all = await Promise.all([fetchApi("/a"), ${POST}]);\n  await all[0].json();\n  return all[1].json();`,
      6,
      READ,
    ],
    [
      "a Promise.allSettled record's .value",
      `  const [, s] = await Promise.allSettled([fetchApi("/a"), ${POST}]);\n  return s.status === "fulfilled" ? s.value.json() : null;`,
      5,
      READ,
    ],
    ["a Promise.all .then(([r]) => r.json())", `  return Promise.all([${POST}]).then(([r]) => r.json());`, 4, READ],
    ["a Promise.race result", `  const r = await Promise.race([${POST}]);\n  return r.json();`, 5, READ],
    ["a Promise.all request after a spread (position unresolvable)", `  const [a] = await Promise.all([...[], ${POST}]);\n  return a;`, 4, "unresolvable position in Promise.all of"],
    ["a Promise.all result used other than element-wise", `  const all = await Promise.all([${POST}]);\n  return all.map((r) => r.json());`, 5, "unresolvable use of"],
  ])("denies %s", (_label, body, line, what) => {
    const r = run({ "src/components/a.tsx": component(body) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MUTATION_RESPONSE_JSON_READ: 1 read(s)");
    expect(r.stderr).toContain(`src/components/a.tsx:${line}  ${what} the response of`);
  });

  // Every body reader consumes the body and rejects the same way `.json()`
  // does; `clone()` is the same response.
  it.each([
    ["a .text() read", `  const res = await ${POST};\n  return res.text();`, 5],
    ["a .blob() read", `  const res = await ${POST};\n  return res.blob();`, 5],
    ["an .arrayBuffer() read", `  const res = await ${POST};\n  return res.arrayBuffer();`, 5],
    ["a .formData() read", `  const res = await ${POST};\n  return res.formData();`, 5],
    ["a .bytes() read", `  const res = await ${POST};\n  return res.bytes();`, 5],
    ['an element access res["text"]()', `  const res = await ${POST};\n  return res["text"]();`, 5],
    ["text destructured from the awaited response", `  const { text } = await ${POST};\n  return text();`, 4],
    ["a res.clone().json() read", `  const res = await ${POST};\n  return res.clone().json();`, 5],
  ])("denies %s", (_label, body, line) => {
    const r = run({ "src/components/a.tsx": component(body) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MUTATION_RESPONSE_JSON_READ: 1 read(s)");
    expect(r.stderr).toContain(`src/components/a.tsx:${line}  body read on the response of`);
  });

  it.each([
    [
      "the GET element of a Promise.all that also POSTs",
      `  const [a, b] = await Promise.all([fetchApi("/a"), ${POST}]);\n  if (!b.ok) return null;\n  return a.json();`,
    ],
    [
      "parseJsonBodyOnce on a Promise.all POST element",
      `  const [, b] = await Promise.all([fetchApi("/a"), ${POST}]);\n  return parseJsonBodyOnce(b);`,
    ],
    ["parseJsonBodyOnce after .catch(() => null)", `  const res = await ${POST}.catch(() => null);\n  return res ? parseJsonBodyOnce(res) : null;`],
    ["destructuring other members of a POST response", `  const { ok, status } = await ${POST};\n  return ok ? status : 0;`],
    ['an element access res["status"]', `  const res = await ${POST};\n  return res["status"];`],
    ["a GET .text() read", '  const res = await fetchApi("/x");\n  return res.text();'],
    [
      "readApiErrorBody(res.clone()) on a POST",
      `  const res = await ${POST};\n  if (!res.ok) return readApiErrorBody(res.clone());\n  return parseJsonBodyOnce(res);`,
    ],
  ])("allows %s", (_label, body) => {
    const r = run({ "src/components/a.tsx": component(body) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-mutation-response-read: OK (1 files");
  });

  // T4-2 / T4-4: each row pins one tracker or method clause that a mutant
  // could drop while every row above stayed green.
  it.each([
    ["a ?? fallback", `  const res = (await ${POST}) ?? null;\n  return res.json();`, 5, READ],
    ["a || fallback", `  const res = (await ${POST}) || null;\n  return res.json();`, 5, READ],
    ["the right side of &&", `  const res = m && (await ${POST});\n  return res ? res.json() : null;`, 5, READ],
    ["an as-wrapped await", `  const res = (await ${POST}) as Response;\n  return res.json();`, 5, READ],
    ["a non-null-asserted await", `  const res = (await ${POST})!;\n  return res.json();`, 5, READ],
    ["a satisfies-wrapped await", `  const res = (await ${POST}) satisfies Response;\n  return res.json();`, 5, READ],
    ["a .then() passthrough", `  const res = await ${POST}.then();\n  return res.json();`, 5, READ],
    ["a .then(undefined) passthrough", `  const res = await ${POST}.then(undefined);\n  return res.json();`, 5, READ],
    ["a .then(null) passthrough", `  const res = await ${POST}.then(null);\n  return res.json();`, 5, READ],
    [
      "a request returned from a .catch callback",
      `  const r = await Promise.resolve(null).catch(async () => await ${POST});\n  return r.json();`,
      5,
      READ,
    ],
    [
      "a .then(function (r) { return r; }) chain",
      `  return ${POST}.then(function (r) { return r; }).then((r) => r.json());`,
      4,
      READ,
    ],
    [
      "a computed index into a Promise.all result",
      `  const all = await Promise.all([${POST}]);\n  const i = 0;\n  return all[i].json();`,
      6,
      "unresolvable element of",
    ],
    [
      "a destructuring assignment ({ json } = res)",
      `  let json: () => Promise<unknown>;\n  ({ json } = await ${POST});\n  return json();`,
      5,
      "unresolvable destructuring of",
    ],
    [
      "a computed key destructured from the response",
      `  const { [m]: read } = await ${POST};\n  return read();`,
      4,
      "unresolvable destructuring of",
    ],
    [
      "{ value } destructured from a settled record",
      `  const [{ value }] = await Promise.allSettled([${POST}]);\n  return value.json();`,
      5,
      READ,
    ],
    ["a rest element over a Promise.all result", `  const [...rs] = await Promise.all([${POST}]);\n  return rs[0].json();`, 5, READ],
    [
      "a rest element after a leading element",
      `  const [a, ...rs] = await Promise.all([fetchApi("/a"), ${POST}]);\n  await a.json();\n  return rs[0].json();`,
      6,
      READ,
    ],
    [
      "an object rest over a settled record",
      `  const [s] = await Promise.allSettled([${POST}]);\n  const { ...rest } = s;\n  return rest.value.json();`,
      6,
      READ,
    ],
    [
      "a computed method key in the init",
      `  const k = "method";\n  const res = await fetchApi("/x", { [k]: "POST" });\n  return res.json();`,
      6,
      READ,
    ],
    [
      "a method accessor in the init",
      `  const res = await fetchApi("/x", { get method() { return "POST"; } });\n  return res.json();`,
      5,
      READ,
    ],
    [
      "a method held in a let reassigned before the call",
      `  let method = "GET";\n  method = "POST";\n  const res = await fetchApi("/x", { method });\n  return res.json();`,
      7,
      READ,
    ],
    ["a method computed by a call", `  const res = await fetchApi("/x", { method: String(m) });\n  return res.json();`, 5, READ],
  ])("denies %s", (_label, body, line, what) => {
    const r = run({ "src/components/a.tsx": component(body) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MUTATION_RESPONSE_JSON_READ: 1 read(s)");
    expect(r.stderr).toContain(`src/components/a.tsx:${line}  ${what} the response of`);
  });

  it.each([
    ["the length of a Promise.all result", `  const all = await Promise.all([${POST}]);\n  return all.length;`],
    [
      "the left side of && (the right side is what the expression holds)",
      `  const res = await ${POST};\n  const g = res && (await fetchApi("/y"));\n  return g.json();`,
    ],
    [
      "a property spelled like a Promise.all binding",
      `  const all = await Promise.all([${POST}]);\n  const o = { all: 1 };\n  return [o.all, all.length];`,
    ],
    ["a lower-case literal get", '  const res = await fetchApi("/x", { method: "get" });\n  return res.json();'],
  ])("allows %s", (_label, body) => {
    const r = run({ "src/components/a.tsx": component(body) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-mutation-response-read: OK (1 files");
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
    expect(r.stderr).toContain("src/components/a.tsx:4  body read on the response of save(…)");
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
    expect(r.stderr).toContain("body read on the response of create(…)");
  });

  it.each([
    [
      "forwards a different parameter on each return",
      "export function send(c: boolean, a?: RequestInit, b?: RequestInit) {\n  if (c) return fetchApi(\"/x\", a);\n  return fetchApi(\"/y\", b);\n}\n",
      'send(true, {}, { method: "POST" })',
    ],
    [
      "returns a const it awaited the request into",
      'export async function send() {\n  const r = await fetchApi("/x", { method: "POST" });\n  return r;\n}\n',
      "send()",
    ],
    [
      "returns a helper declared after it (found on a later fixpoint pass)",
      'export function send() {\n  return inner();\n}\nfunction inner() {\n  return fetchApi("/x", { method: "POST" });\n}\n',
      "send()",
    ],
  ])("denies the response of a helper that %s", (_label, helper, call) => {
    const r = run({
      "src/lib/send.ts": PRELUDE + helper,
      "src/components/a.tsx":
        'import { send } from "@/lib/send";\n' + `export async function f() {\n  const res = await ${call};\n  return res.json();\n}\n`,
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("src/components/a.tsx:4  body read on the response of send(…)");
  });

  // S4-4: two modules export a helper named `send` — one mutates on its own,
  // the other forwards its init. An import resolves through its specifier, so
  // neither directory order nor the other module decides the verdict.
  const MUTATING_SEND = PRELUDE + 'export function send(url: string) {\n  return fetchApi(url, { method: "POST" });\n}\n';
  const FORWARDING_SEND = PRELUDE + "export function send(url: string, init?: RequestInit) {\n  return fetchApi(url, init);\n}\n";
  const callSend = (importLine, callee = "send") =>
    `${importLine}\nexport async function f() {\n  const res = await ${callee}("/x");\n  return res.json();\n}\n`;

  it.each([
    ["the mutating module sorts first", "src/lib/b/h.ts", "src/lib/z/h.ts", '"@/lib/b/h"'],
    ["the mutating module sorts last", "src/lib/z/h.ts", "src/lib/b/h.ts", '"@/lib/z/h"'],
    ["a relative specifier", "src/lib/z/h.ts", "src/lib/b/h.ts", '"../lib/z/h"'],
  ])("denies a mutating helper masked by a same-named forwarding one: %s", (_label, mutating, forwarding, spec) => {
    const r = run({
      [mutating]: MUTATING_SEND,
      [forwarding]: FORWARDING_SEND,
      "src/components/a.tsx": callSend(`import { send } from ${spec};`),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("src/components/a.tsx:4  body read on the response of send(…)");
  });

  it.each([
    ["an aliased import", 'import { send as post } from "@/lib/b/h";', "post"],
    ["a namespace import", 'import * as api from "@/lib/b/h";', "api.send"],
    ["an aliased re-export through an index module", 'import { post } from "@/lib/b";', "post", { "src/lib/b/index.ts": 'export { send as post } from "./h";\n' }],
    ["a default import", 'import post from "@/lib/d";', "post", { "src/lib/d.ts": PRELUDE + 'export default function send() {\n  return fetchApi("/x", { method: "POST" });\n}\n' }],
    // Unresolvable: every exported `send` could be the one called; the
    // forwarding one sorts first so a first-match reading would allow it.
    ["an import that does not resolve to a scanned module", 'import { send } from "some-package";', "send"],
    ["a namespace import that does not resolve to a scanned module", 'import * as api from "some-package";', "api.send"],
    ["a name bound nowhere in the file", "", "send"],
    ["a re-export cycle", 'import { send } from "@/lib/c";', "send", { "src/lib/c.ts": 'export { send } from "./c";\n' }],
  ])("denies a mutating helper reached through %s", (_label, importLine, callee, extra = {}) => {
    const r = run({
      "src/lib/a/h.ts": FORWARDING_SEND,
      "src/lib/b/h.ts": MUTATING_SEND,
      ...extra,
      "src/components/a.tsx": callSend(importLine, callee),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`body read on the response of ${callee}(…)`);
  });

  // S5-2: a helper reached through `export default <identifier>`.
  const URL_HELPERS = "export function fetchApi(path: string, init?: RequestInit): Promise<Response> {\n  return fetch(path, init);\n}\n";
  const callImported = (importLine, callee, init) =>
    `${importLine}\nexport async function handler() {\n  const res = await ${callee}("/x"${init ? `, ${init}` : ""});\n  return res.json();\n}\n`;
  const SEND_CONST = (method) =>
    `${PRELUDE}const send = (path: string) => fetchApi(path, { method: "${method}" });\n`;

  it.each([
    [
      "a default-imported helper exported as `export default send`",
      {
        "src/lib/send.ts": SEND_CONST("POST") + "export default send;\n",
        "src/components/a.tsx": callImported('import send from "@/lib/send";', "send"),
      },
      "send",
    ],
    [
      "a default-imported helper whose default export is not a declared helper",
      {
        "src/lib/send.ts":
          SEND_CONST("POST") + "export function post(path: string) {\n  return send(path);\n}\n" +
          "declare function wrap<T>(fn: T): T;\nexport default wrap(post);\n",
        "src/components/a.tsx": callImported('import send from "@/lib/send";', "send"),
      },
      "send",
    ],
    [
      "a default-imported anonymous arrow helper",
      {
        "src/lib/send.ts": PRELUDE + 'export default (path: string) => fetchApi(path, { method: "POST" });\n',
        "src/components/a.tsx": callImported('import send from "@/lib/send";', "send"),
      },
      "send",
    ],
    [
      "a helper re-exported through an `export *` barrel",
      {
        "src/lib/req.ts": 'import { fetchApi } from "@/lib/url-helpers";\nexport function post(url: string) {\n  return fetchApi(url, { method: "POST" });\n}\n',
        "src/lib/index.ts": 'export * from "./req";\n',
        "src/components/a.tsx": callImported('import { post } from "@/lib";', "post"),
      },
      "post",
    ],
  ])("denies %s", (_label, files, callee) => {
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS, ...files });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`src/components/a.tsx:4  body read on the response of ${callee}(…)`);
  });

  it.each([
    [
      "a default-exported GET helper",
      {
        "src/lib/send.ts": SEND_CONST("GET") + "export default send;\n",
        "src/components/a.tsx": callImported('import send from "@/lib/send";', "send"),
      },
    ],
    [
      "a default-exported GET helper beside a mutating helper in its module",
      {
        "src/lib/send.ts":
          SEND_CONST("GET") + 'export function post(path: string) {\n  return fetchApi(path, { method: "POST" });\n}\nexport default send;\n',
        "src/components/a.tsx": callImported('import send from "@/lib/send";', "send"),
      },
    ],
  ])("allows %s", (_label, files) => {
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS, ...files });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-mutation-response-read: OK");
  });

  // R6 (S6-5/T6-6): fetchApi is not followed through aliases; every spelling
  // other than a direct call or an import by its own name is refused.
  const IMPORT_FETCH_API = 'import { fetchApi } from "@/lib/url-helpers";\n';
  const inHandler = (body) => `${IMPORT_FETCH_API}export async function handler(c: boolean, other: typeof fetchApi) {\n${body}\n}\n`;
  const refusal = (rel, line, why) => `${rel}:${line}  fetchApi used as a value (${why})`;
  const A = "src/components/a.tsx";
  const HELD = "held, passed or stored";

  it.each([
    ["a const alias", { [A]: inHandler("  const f2 = fetchApi;\n  return f2;") }, A, 3, HELD],
    ["a let alias", { [A]: inHandler("  let f2 = fetchApi;\n  return f2;") }, A, 3, HELD],
    ["a var alias", { [A]: inHandler("  var f2 = fetchApi;\n  return f2;") }, A, 3, HELD],
    ["a name assigned fetchApi later", { [A]: inHandler("  let f2: typeof fetchApi = other;\n  f2 = fetchApi;\n  return f2;") }, A, 4, HELD],
    ["an alias through a ternary", { [A]: inHandler("  const f2 = c ? fetchApi : other;\n  return f2;") }, A, 3, HELD],
    ["an alias through ??", { [A]: inHandler("  const f2 = other ?? fetchApi;\n  return f2;") }, A, 3, HELD],
    ["an alias through ||=", { [A]: inHandler("  let f2: typeof fetchApi | null = null;\n  f2 ||= fetchApi;\n  return f2;") }, A, 4, HELD],
    ["a parameter default outside the allowlist", { [A]: `${IMPORT_FETCH_API}export function f(fetcher = fetchApi) {\n  return fetcher;\n}\n` }, A, 2, HELD],
    ["a binding-element default", { [A]: `${IMPORT_FETCH_API}export const { f2 = fetchApi } = {} as { f2?: typeof fetchApi };\n` }, A, 2, HELD],
    ["an argument", { [A]: inHandler("  return Promise.resolve(fetchApi);") }, A, 3, HELD],
    ["an object property", { [A]: inHandler("  return { fetcher: fetchApi };") }, A, 3, HELD],
    ["a shorthand object property", { [A]: inHandler("  return { fetchApi };") }, A, 3, HELD],
    ["an array element", { [A]: inHandler("  return [fetchApi];") }, A, 3, HELD],
    ["a JSX attribute value", { [A]: `${IMPORT_FETCH_API}declare function X(p: { f: unknown }): null;\nexport const el = <X f={fetchApi} />;\n` }, A, 3, HELD],
    ["fetchApi.bind(null)", { [A]: inHandler("  return fetchApi.bind(null);") }, A, 3, "member .bind of fetchApi"],
    ["fetchApi.call(...)", { [A]: inHandler('  return fetchApi.call(null, "/x", { method: "POST" });') }, A, 3, "member .call of fetchApi"],
    ["fetchApi.apply(...)", { [A]: inHandler('  return fetchApi.apply(null, ["/x"]);') }, A, 3, "member .apply of fetchApi"],
    ["a default export", { [A]: `${IMPORT_FETCH_API}export default fetchApi;\n` }, A, 2, HELD],
    ["an injected x.fetchApi outside a receiver", { [A]: `export async function f(deps: { fetchApi(p: string): Promise<Response> }) {\n  return deps.fetchApi("/x");\n}\n` }, A, 2, "property access .fetchApi"],
    ["a member read by a string key", { [A]: `export function f(deps: Record<string, unknown>) {\n  return deps["fetchApi"];\n}\n` }, A, 2, "member read by a string key"],
    ["a computed destructuring key", { [A]: `export function f(deps: Record<string, unknown>) {\n  const { ["fetchApi"]: g } = deps;\n  return g;\n}\n` }, A, 2, "member read by a string key"],
    ["destructuring it off an object", { [A]: `export function f(deps: { fetchApi: unknown }) {\n  const { fetchApi } = deps;\n  return fetchApi;\n}\n` }, A, 2, "read off an object by destructuring"],
    ["destructuring it off an object under another name", { [A]: `export function f(deps: { fetchApi: unknown }) {\n  const { fetchApi: g } = deps;\n  return g;\n}\n` }, A, 2, "read off an object by destructuring"],
    ["a renamed import", { [A]: 'import { fetchApi as f } from "@/lib/url-helpers";\nexport const g = () => f("/x", { method: "POST" });\n' }, A, 1, "renamed import"],
    ["a renamed import of a package outside the scan", { [A]: 'import { fetchApi as f } from "some-package";\nexport const g = () => f("/x");\n' }, A, 1, "renamed import"],
    ["an import of another name as fetchApi", { [A]: 'import { request as fetchApi } from "@/lib/req";\nexport const g = () => fetchApi("/x");\n' }, A, 1, "renamed import"],
    ["a renamed import default-exported through an alias (R5)", { "src/lib/req.ts": 'import { fetchApi as f } from "@/lib/url-helpers";\nconst g = f;\nexport default g;\n' }, "src/lib/req.ts", 1, "renamed import"],
    ["a renamed re-export (R5)", { "src/lib/http/index.ts": 'export { fetchApi as request } from "../url-helpers";\n' }, "src/lib/http/index.ts", 1, "re-export"],
    ["a re-export by its own name", { "src/lib/http/index.ts": 'export { fetchApi } from "@/lib/url-helpers";\n' }, "src/lib/http/index.ts", 1, "re-export"],
    ["an export clause over the import", { "src/lib/http/r.ts": `${IMPORT_FETCH_API}export { fetchApi };\n` }, "src/lib/http/r.ts", 2, "re-export"],
    ["an exported const (R5)", { "src/lib/http/r.ts": `${IMPORT_FETCH_API}export const request = fetchApi;\n` }, "src/lib/http/r.ts", 2, HELD],
    ["an exported destructuring rename (S6-5)", { "src/lib/http/r.ts": 'import * as U from "@/lib/url-helpers";\nexport const { fetchApi: request } = U;\n' }, "src/lib/http/r.ts", 2, "read off an object by destructuring"],
    ["an exported let assigned later (R5)", { "src/lib/http/r.ts": `${IMPORT_FETCH_API}export let request: typeof fetchApi | null = null;\nrequest = fetchApi;\n` }, "src/lib/http/r.ts", 3, HELD],
    ["a namespace import of its module (S6-5)", { [A]: 'import * as u from "@/lib/url-helpers";\nexport const g = () => u.fetchApi("/x", { method: "POST" });\n' }, A, 1, "namespace import of its module"],
    ["a namespace member alias const r = u.fetchApi (S6-5)", { [A]: 'import * as u from "@/lib/url-helpers";\nexport const r = u.fetchApi;\n' }, A, 2, "property access .fetchApi"],
    ["a namespace import by a relative specifier", { "src/lib/vault/x.ts": 'import * as u from "../url-helpers";\nexport const r = u;\n' }, "src/lib/vault/x.ts", 1, "namespace import of its module"],
    ["a default import of its module", { [A]: 'import u from "@/lib/url-helpers";\nexport const r = u;\n' }, A, 1, "default import of its module"],
    ["an export * barrel of its module (S6-5)", { "src/lib/index.ts": 'export * from "./url-helpers";\n' }, "src/lib/index.ts", 1, "export * of its module"],
    ["an export * as namespace of its module", { "src/lib/index.ts": 'export * as u from "@/lib/url-helpers";\n' }, "src/lib/index.ts", 1, "export * of its module"],
    ["a dynamic import of its module", { [A]: 'export async function g() {\n  return import("@/lib/url-helpers");\n}\n' }, A, 2, "import() that may load its module"],
    ["a dynamic import with a non-literal specifier", { [A]: 'export async function g(m: string) {\n  return import(m);\n}\n' }, A, 2, "import() that may load its module"],
    ["a dynamic import whose template head may reach it", { [A]: 'export async function g(m: string) {\n  return import(`@/lib/${m}`);\n}\n' }, A, 2, "import() that may load its module"],
    ["a require of its module", { [A]: 'declare const require: (m: string) => unknown;\nexport const u = require("../lib/url-helpers");\n' }, A, 2, "require() that may load its module"],
  ])("refuses fetchApi as a value: %s", (_label, files, rel, line, why) => {
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS, ...files });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(refusal(rel, line, why));
  });

  it.each([
    ["a direct call with a plain import", { [A]: `${IMPORT_FETCH_API}export async function g() {\n  const res = await fetchApi("/x", { method: "POST" });\n  return parseJsonBodyOnce(res);\n}\ndeclare function parseJsonBodyOnce(r: Response): Promise<unknown>;\n` }],
    ["an optional direct call", { [A]: `${IMPORT_FETCH_API}export const g = () => fetchApi?.("/x");\n` }],
    ["a type position", { [A]: `${IMPORT_FETCH_API}export type F = typeof fetchApi;\nexport const g = (f: typeof fetchApi) => f;\n` }],
    ["an object key and a type key spelled fetchApi", { [A]: "export interface D { fetchApi: () => void }\nexport const d: D = { fetchApi: () => undefined };\n" }],
    ["a type-only renamed import", { [A]: 'import type { fetchApi as F } from "@/lib/url-helpers";\nexport type G = typeof F;\n' }],
    ["a named import of another binding from its module", { [A]: 'import { withBasePath } from "@/lib/url-helpers";\nexport const p = withBasePath("/x");\n' }],
    ["a dynamic import of a const package name", { [A]: 'export async function g() {\n  const name = "hash-wasm";\n  return import(name);\n}\n' }],
    // R8: specifiers that resolve to another scanned module or a package.
    ["a namespace import of a sibling module whose name extends its module's", { [A]: 'import * as X from "@/lib/url-helpers-x";\nexport const g = (k: string) => (X as Record<string, unknown>)[k];\n', "src/lib/url-helpers-x.ts": "export const y = 1;\n" }],
    ["a namespace import of a module under a directory of its module's name", { [A]: 'import * as X from "@/lib/urls/x";\nexport const r = X;\n', "src/lib/urls/x.ts": "export const y = 1;\n" }],
    ["a namespace import of a directory index by a trailing slash", { [A]: 'import * as X from "@/lib/urls/";\nexport const r = X;\n', "src/lib/urls/index.ts": "export const y = 1;\n" }],
    ["a namespace import of another module by a relative path", { [A]: 'import * as X from "../lib/other";\nexport const r = X;\n', "src/lib/other.ts": "export const y = 1;\n" }],
    ["a namespace import of a scoped package", { [A]: 'import * as X from "@scope/pkg";\nexport const r = X;\n' }],
    ["an export * of a scoped package", { "src/lib/index.ts": 'export * from "@scope/pkg";\n' }],
    ["an import = require() of a package", { [A]: 'import X = require("some-package");\nexport const r = X;\n' }],
  ])("allows %s", (_label, files) => {
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS + "export const withBasePath = (p: string) => p;\n", ...files });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  // The allowlisted injection sites: each shape is accepted at its own file,
  // and its receiver's calls are sources whose body reads stay checked.
  const PARSE = "declare function parseJsonBodyOnce(r: Response): Promise<unknown>;\n";
  const importSite = (rel, fn) => (read) => ({
    [rel]:
      `${IMPORT_FETCH_API}${PARSE}type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;\n` +
      `export async function ${fn}(entries: unknown[], path: string, fetcher: FetchLike = fetchApi) {\n` +
      `  const res = await fetcher(path, { method: "POST" });\n  return ${read};\n}\n`,
  });
  const FOLDERS = "src/components/passwords/import/password-import-folders.ts";
  const TAGS = "src/components/passwords/import/password-import-tags.ts";
  const UPLOAD = "src/lib/team/team-attachment-upload.ts";
  const RUNNER = "src/lib/team/rekey-runner.ts";
  const attachmentSite = (read) => ({
    "src/components/team/forms/team-attachment-section.tsx":
      `${IMPORT_FETCH_API}import { uploadTeamAttachment } from "@/lib/team/team-attachment-upload";\n` +
      "export async function onUpload(file: unknown) {\n  return uploadTeamAttachment({ teamId: \"t\", fetchApi }, file);\n}\n",
    [UPLOAD]:
      `${PARSE}export async function uploadTeamAttachment(deps: { teamId: string; fetchApi: (p: string, i?: RequestInit) => Promise<Response> }, file: unknown) {\n` +
      `  const res = await deps.fetchApi("/x", { method: "POST", body: String(file) });\n  return ${read};\n}\n`,
  });
  const rekeySite = (read) => ({
    "src/components/team/security/team-rekey-finish-control.tsx":
      `${IMPORT_FETCH_API}import { runRekeyPass } from "@/lib/team/rekey-runner";\n` +
      'export async function run() {\n  return runRekeyPass({ teamId: "t", fetch: fetchApi });\n}\n',
    [RUNNER]:
      `${PARSE}export async function runRekeyPass(deps: { teamId: string; fetch: (p: string, i?: RequestInit) => Promise<Response> }) {\n` +
      "  const fetchOrStop = async (path: string, init?: RequestInit): Promise<Response> => {\n" +
      "    try {\n      return await deps.fetch(path, init);\n    } catch {\n      throw new Error(\"stop\");\n    }\n  };\n" +
      `  const res = await fetchOrStop("/x", { method: "PUT" });\n  return ${read};\n}\n`,
  });
  const SITES = [
    ["the import-folders parameter default", importSite(FOLDERS, "resolveFolderPathsForImport"), `${FOLDERS}:6`, "fetcher(…)"],
    ["the import-tags parameter default", importSite(TAGS, "resolveTagNameToIdForImport"), `${TAGS}:6`, "fetcher(…)"],
    ["the attachment upload deps property", attachmentSite, `${UPLOAD}:4`, "deps.fetchApi(…)"],
    ["the re-key runner deps property", rekeySite, `${RUNNER}:11`, "fetchOrStop(…)"],
  ];

  it.each(SITES)("allows the injection site %s", (_label, site) => {
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS, ...site("parseJsonBodyOnce(res)") });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  it.each(SITES)("checks the receiver of the injection site %s", (_label, site, at, origin) => {
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS, ...site("res.json()") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${at}  body read on the response of ${origin}`);
    expect(r.stderr).not.toContain("FETCH_API_VALUE_USE");
  });

  it.each([
    [
      "the re-key shape in a file that is not allowlisted",
      () => {
        const files = rekeySite("parseJsonBodyOnce(res)");
        const rel = "src/components/team/security/team-rekey-finish-control.tsx";
        return { ...files, "src/components/team/other.tsx": files[rel], [rel]: undefined };
      },
      "src/components/team/other.tsx",
      4,
    ],
    [
      "the attachment shape calling a same-named function from another module",
      () => {
        const files = attachmentSite("parseJsonBodyOnce(res)");
        const rel = "src/components/team/forms/team-attachment-section.tsx";
        return { ...files, [rel]: files[rel].replace('"@/lib/team/team-attachment-upload"', '"@/lib/team/other-upload"') };
      },
      "src/components/team/forms/team-attachment-section.tsx",
      4,
    ],
    [
      "an allowlisted parameter default in a function of another name",
      () => ({ [FOLDERS]: importSite(FOLDERS, "resolveOther")("parseJsonBodyOnce(res)")[FOLDERS] }),
      FOLDERS,
      4,
    ],
  ])("refuses a non-allowlisted injection: %s", (_label, make, rel, line) => {
    const files = Object.fromEntries(Object.entries(make()).filter(([, v]) => v !== undefined));
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS, ...files });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(refusal(rel, line, HELD));
  });

  it("refuses an allowlist entry whose receiver is gone", () => {
    const files = rekeySite("parseJsonBodyOnce(res)");
    delete files[RUNNER];
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS, ...files });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("FETCH_API_INJECTION_STALE");
    expect(r.stderr).toContain(`${RUNNER}: receiver of the fetchApi injected in src/components/team/security/team-rekey-finish-control.tsx is not a scanned file`);
  });

  it("refuses an allowlist entry whose receiver no longer calls the injected member", () => {
    const files = rekeySite("parseJsonBodyOnce(res)");
    files[RUNNER] = files[RUNNER].replace("deps.fetch(path, init)", "Promise.reject(path)");
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS, ...files });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${RUNNER}: no .fetch(…) call receives the injected fetchApi`);
  });

  it("terminates on an export-clause import cycle", () => {
    const r = run({
      "src/lib/c.ts": 'import { request } from "./d";\nexport { request };\n',
      "src/lib/d.ts": 'import { request } from "./c";\nexport { request };\n',
      "src/components/a.tsx": callImported('import { request } from "@/lib/c";', "request", '{ method: "POST" }'),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-mutation-response-read: OK");
  });

  it("denies an unresolvable import when same-named helpers forward different arguments", () => {
    const r = run({
      "src/lib/a/h.ts": FORWARDING_SEND,
      "src/lib/b/h.ts": PRELUDE + "export function send(init?: RequestInit, url = \"/x\") {\n  return fetchApi(url, init);\n}\n",
      "src/components/a.tsx": callSend('import { send } from "some-package";'),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("body read on the response of send(…)");
  });

  it.each([
    ["the only such helper", {}, '"@/lib/z/h"'],
    ["beside a same-named mutating helper", { "src/lib/b/h.ts": MUTATING_SEND }, '"@/lib/z/h"'],
    ["by a relative specifier beside a mutating one", { "src/lib/b/h.ts": MUTATING_SEND }, '"../lib/z/h"'],
    [
      "through an index re-export beside a mutating one",
      { "src/lib/b/h.ts": MUTATING_SEND, "src/lib/z/index.ts": 'export { send } from "./h";\n' },
      '"@/lib/z"',
    ],
    [
      "by an export clause beside a mutating one",
      {
        "src/lib/b/h.ts": MUTATING_SEND,
        "src/lib/z/h.ts": PRELUDE + "function send(url: string, init?: RequestInit) {\n  return fetchApi(url, init);\n}\nexport { send };\n",
      },
      '"@/lib/z/h"',
    ],
    [
      "a renamed export clause beside a mutating helper of the exported name",
      {
        "src/lib/b/h.ts": PRELUDE + 'export function post(url: string) {\n  return fetchApi(url, { method: "POST" });\n}\n',
        "src/lib/z/h.ts": PRELUDE + "function send(url: string, init?: RequestInit) {\n  return fetchApi(url, init);\n}\nexport { send as post };\n",
      },
      '"@/lib/z/h"',
      "import { post as send } from",
    ],
    [
      "a default import beside a mutating default export",
      {
        "src/lib/b/h.ts": PRELUDE + 'export default function send(url: string) {\n  return fetchApi(url, { method: "POST" });\n}\n',
        "src/lib/z/h.ts": PRELUDE + "export default function send(url: string, init?: RequestInit) {\n  return fetchApi(url, init);\n}\n",
      },
      '"@/lib/z/h"',
      "import send from",
    ],
  ])("allows a GET through a forwarding helper imported as %s", (_label, extra, spec, importClause = "import { send } from") => {
    const r = run({
      "src/lib/z/h.ts": FORWARDING_SEND,
      ...extra,
      "src/components/a.tsx": callSend(`${importClause} ${spec};`),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-mutation-response-read: OK");
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
    ["the Prisma singleton as a default import", 'import prisma from "@/lib/prisma";\n'],
    ["the Prisma singleton beside a type-only binding", 'import { type PrismaClient, prisma } from "@/lib/prisma";\n'],
    ["next/headers as a namespace", 'import * as h from "next/headers";\n'],
  ])("allows a mutation read in a src/lib server module importing %s", (_label, header) => {
    const r = run({
      "src/components/ok.tsx": "export const ok = 1;\n",
      // A marker by specifier is the module it resolves to, so the singleton is there.
      "src/lib/prisma.ts": 'import "server-only";\nexport const prisma = {};\nexport default prisma;\n',
      "src/lib/vault/x.ts": libModule(header, POST_READ),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OK (1 files");
  });

  // The server-module exemption is a src/lib rule only: a component or page
  // that imports a server marker is still client code to this gate.
  it("denies a mutation read outside src/lib even when the module imports a server marker", () => {
    const r = run({
      "src/components/ok.tsx": "export const ok = 1;\n",
      "src/components/a.tsx": libModule('import "server-only";\n', POST_READ),
      "src/app/[locale]/p/page.tsx": libModule('import { headers } from "next/headers";\n', POST_READ),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MUTATION_RESPONSE_JSON_READ: 2 read(s)");
    expect(r.stderr).toContain("src/components/a.tsx:6");
    expect(r.stderr).toContain("src/app/[locale]/p/page.tsx:6");
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

// R8: a specifier is decided by where it resolves, not by its text. Each of
// these spellings resolves to src/lib/url-helpers.ts (TypeScript and the
// bundler normalise it), and each passed the string rule on HEAD.
describe("check-mutation-response-read: fetchApi's module by any spelling (R8)", () => {
  const URL_HELPERS_R8 = "export function fetchApi(path: string, init?: RequestInit): Promise<Response> {\n  return fetch(path, init);\n}\n";
  const A = "src/components/a.tsx";
  const SPELLINGS = [
    "@/lib/../lib/url-helpers",
    "@/lib//url-helpers",
    "@/./lib/url-helpers",
    "@/lib/./url-helpers",
    "@/components/../lib/url-helpers",
    "../lib/../lib/url-helpers",
    "../lib//url-helpers",
  ];
  const FORMS = [
    ["a namespace import with a computed key", (s) => `import * as U from "${s}";\nexport const g = (k: string) => (U as Record<string, (p: string, i: RequestInit) => unknown>)[k]("/x", { method: "POST" });\n`, 1, "namespace import of its module"],
    ["a default import", (s) => `import U from "${s}";\nexport const r = U;\n`, 1, "default import of its module"],
    ["an export *", (s) => `export * from "${s}";\n`, 1, "export * of its module"],
    ["an export * as", (s) => `export * as U from "${s}";\n`, 1, "export * of its module"],
    ["an import()", (s) => `export async function g() {\n  return import("${s}");\n}\n`, 2, "import() that may load its module"],
    ["a require()", (s) => `declare const require: (m: string) => unknown;\nexport const u = require("${s}");\n`, 2, "require() that may load its module"],
    ["an import = require()", (s) => `import U = require("${s}");\nexport const r = U;\n`, 1, "import = require() that may load its module"],
    ["a const string import()", (s) => `const m = "${s}";\nexport const g = () => import(m);\n`, 2, "import() that may load its module"],
  ];
  const ROWS = FORMS.flatMap(([form, code, line, why]) => SPELLINGS.map((spec) => [`${form} of ${spec}`, code(spec), line, why]));

  it.each(ROWS)("refuses %s", (_label, content, line, why) => {
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS_R8, [A]: content });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${A}:${line}  fetchApi used as a value (${why})`);
  });

  it.each([
    ["an alias template head", "`@/lib/./${m}`"],
    ["a template head with .. in it", "`@/lib/../lib/url-${m}`"],
    ["a relative template head with a literal tail", "`../../messages/${m}.json`"],
    ["a bare package template head", "`some-package/${m}`"],
  ])("refuses an import() of %s", (_label, template) => {
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS_R8, [A]: `export async function g(m: string) {\n  return import(${template});\n}\n` });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${A}:2  fetchApi used as a value (import() that may load its module)`);
  });

  it.each([
    ["an unresolvable specifier", 'import * as U from "@/lib/nope";\nexport const r = U;\n', {}, "namespace import of its module"],
    ["a module this gate does not scan", 'import * as U from "@/app/api/r/route";\nexport const r = U;\n', { "src/app/api/r/route.ts": 'export * from "@/lib/url-helpers";\n' }, "namespace import of its module"],
    ["a module a .js sibling shadows", 'import * as U from "@/lib/shadow";\nexport const r = U;\n', { "src/lib/shadow.ts": "export const y = 1;\n", "src/lib/shadow.js": 'export * from "./url-helpers";\n' }, "namespace import of its module"],
    ["require.context", 'declare const require: { context(d: string, r: boolean): unknown };\nexport const c = require.context("../lib", true);\n', {}, "require.context() that may load its module"],
  ])("refuses %s", (_label, content, extra, why) => {
    const r = run({ "src/lib/url-helpers.ts": URL_HELPERS_R8, ...extra, [A]: content });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${A}:${content.startsWith("declare") ? 2 : 1}  fetchApi used as a value (${why})`);
  });

  it("does not take an unresolvable Prisma specifier as a server marker", () => {
    const r = run({
      "src/lib/vault/x.ts": 'import { prisma } from "@/lib/prisma";\ndeclare function fetchApi(path: string, init?: RequestInit): Promise<Response>;\nexport async function h() {\n  const res = await fetchApi("/x", { method: "POST" });\n  return res.json();\n}\n',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("src/lib/vault/x.ts:5");
  });

  it("takes a Prisma specifier spelled through .. as a server marker", () => {
    const r = run({
      "src/components/ok.tsx": "export const ok = 1;\n",
      "src/lib/prisma.ts": 'import "server-only";\nexport const prisma = {};\n',
      "src/lib/vault/x.ts": 'import { prisma } from "@/lib/vault/../prisma";\ndeclare function fetchApi(path: string, init?: RequestInit): Promise<Response>;\nexport async function h() {\n  const res = await fetchApi("/x", { method: "POST" });\n  return res.json();\n}\n',
    });
    expect(r.code).toBe(0);
  });

  it("refuses a tree with no tsconfig.json", () => {
    const r = run({ "tsconfig.json": null, [A]: "export const a = 1;\n" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no tsconfig.json");
  });
});
