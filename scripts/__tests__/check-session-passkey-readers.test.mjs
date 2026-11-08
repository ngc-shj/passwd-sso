/**
 * Self-test for scripts/checks/check-session-passkey-readers.mjs — the handler
 * scan of the session passkey gate (plan:
 * docs/archive/review/session-api-passkey-gate-plan.md, Testing → handler scan).
 *
 * Every refusal rule has a fixture the gate must FAIL on, built from the
 * passing base fixture by one change, so each cell is able to fail for the
 * reason it names. Variants built by `.replace` go through `swap`, which
 * asserts the replace took effect. The gate is driven through
 * SESSION_PASSKEY_READERS_ROOT; tracked files are never mutated.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-session-passkey-readers.mjs");
const MANIFEST = "scripts/checks/route-policy-manifest.json";
const PROXY_LIST = "src/lib/proxy/session-passkey-gate.ts";

/** `base` with `from` replaced by `to`, asserting the replace changed something. */
function swap(base, from, to) {
  const variant = base.replace(from, to);
  expect(variant).not.toBe(base);
  return variant;
}

const AUTH_IMPORT = `import { auth } from "@/auth";`;
const ENFORCEMENT_IMPORT = `import { derivePasskeyState, passkeyEnforcementBlocks } from "@/lib/auth/policy/passkey-enforcement";`;

const REAUTH = `${AUTH_IMPORT}
export async function POST(req: Request) {
  const session = await auth();
  return Response.json({ ok: !!session });
}
`;

const OWN_GATE = `${AUTH_IMPORT}
${ENFORCEMENT_IMPORT}
export async function GET(req: Request) {
  const session = await auth();
  const state = await derivePasskeyState({ userId: session.user.id });
  if (passkeyEnforcementBlocks(state)) return Response.redirect("x");
  return Response.json({});
}
`;

const OPENAPI = `import { authOrToken } from "@/lib/auth/session/auth-or-token";
${ENFORCEMENT_IMPORT}
export async function GET(req: Request) {
  const result = await authOrToken(req);
  if (result && passkeyEnforcementBlocks(await derivePasskeyState({ userId: result.userId }))) {
    return new Response(null, { status: 403 });
  }
  return Response.json({});
}
`;

// A local `checkAuth` shadows the reader's name; it is not the reader.
const V1_SHADOW = `import { validateV1Auth } from "@/lib/auth/tokens/v1";
async function checkAuth(req: Request) {
  return validateV1Auth(req);
}
export async function GET(req: Request) {
  return Response.json(await checkAuth(req));
}
`;

const NEXTAUTH = `import { handlers } from "@/auth";
import { readSessionCookie } from "@/lib/auth/session/session-cookie";
export async function GET(req: Request) {
  readSessionCookie(req.headers.get("cookie"));
  return handlers.GET(req);
}
export async function POST(req: Request) {
  return handlers.POST(req);
}
`;

// Pre-auth passkey sign-in: reads the session cookie only to name the
// sessions its sign-in replaces. Tier A, exempt by READER_EXEMPTIONS.
const PASSKEY_VERIFY = `import { presentedSessionTokens } from "@/lib/auth/session/session-cookie";
export async function POST(req: Request) {
  return Response.json({ replaced: presentedSessionTokens(req.headers.get("cookie"), ["n"]) });
}
`;

const SESSION_ROUTE = `import { checkAuth } from "@/lib/auth/session/check-auth";
export async function GET(req: Request) {
  return Response.json(await checkAuth(req));
}
`;

const NO_READER = `export async function GET() {
  return Response.json({ ok: true });
}
`;

const BEARER_ROUTE = `import { validateExtensionToken } from "@/lib/auth/tokens/extension-token";
export async function POST(req: Request) {
  const result = await validateExtensionToken(req);
  return Response.json({ ok: result.ok });
}
`;

const LAYOUT = `${AUTH_IMPORT}
export default async function Layout({ children }: { children: unknown }) {
  const session = await auth();
  if (!session) return null;
  return children;
}
`;
const BEARER_ONLY = [
  "src/app/api/extension/key/reset/route.ts",
  "src/app/api/extension/token/refresh/route.ts",
  "src/app/api/extension/token/route.ts",
];
const DASHBOARD_LAYOUT = "src/app/[locale]/dashboard/layout.tsx";
const ADMIN_LAYOUT = "src/app/[locale]/admin/layout.tsx";
const PAGE_ROUTE = "src/lib/proxy/page-route.ts";
const pageRoute = (cond) => `import { getSessionInfo } from "./auth-gate";
export async function handlePage(request: Request, pathWithoutLocale: string) {
  if (${cond}) {
    const session = await getSessionInfo(request);
    if (!session.valid) return redirect();
  }
}
`;
const BASE_PAGE_ROUTE = pageRoute(`pathWithoutLocale.startsWith("/dashboard") || pathWithoutLocale.startsWith("/admin")`);
const REDIRECT_PAGE = `import { redirect } from "next/navigation";
export default async function Page() {
  redirect("/x");
}
`;
const WRAPPER_PAGE = `import { Thing } from "@/components/thing";
export default function Page() {
  return <Thing />;
}
`;
const DATA_PAGE = `import { prisma } from "@/lib/prisma";
export default async function Page() {
  const rows = await prisma.passwordEntry.findMany();
  return rows.length;
}
`;
const COOKIE_ONLY_ROUTE = `import { readSessionCookie } from "@/lib/auth/session/session-cookie";
export async function GET(req: Request) {
  return Response.json(readSessionCookie(req.headers.get("cookie")));
}
`;

const proxyList = (entries) => `export interface SessionGateEntry { method: string; path: string; reason: string }
export const API_DEFAULT_SESSION_READERS: readonly SessionGateEntry[] = [
${entries.map(([m, p]) => `  { method: "${m}", path: "${p}", reason: "step-up reauth reads the session" },`).join("\n")}
];
`;
const BASE_LIST = [["POST", "/api/auth/passkey/reauth/options"]];

const BASE_FILES = {
  "src/app/api/auth/passkey/reauth/options/route.ts": REAUTH,
  "src/app/api/mcp/authorize/route.ts": OWN_GATE,
  "src/app/api/v1/openapi.json/route.ts": OPENAPI,
  "src/app/api/v1/passwords/[id]/route.ts": V1_SHADOW,
  "src/app/api/auth/[...nextauth]/route.ts": NEXTAUTH,
  "src/app/api/auth/passkey/verify/route.ts": PASSKEY_VERIFY,
  "src/app/api/passwords/route.ts": SESSION_ROUTE,
  "src/app/api/health/route.ts": NO_READER,
  ...Object.fromEntries(BEARER_ONLY.map((rel) => [rel, BEARER_ROUTE])),
  [DASHBOARD_LAYOUT]: LAYOUT,
  [ADMIN_LAYOUT]: LAYOUT,
  [PAGE_ROUTE]: BASE_PAGE_ROUTE,
  "src/app/[locale]/dashboard/settings/page.tsx": REDIRECT_PAGE,
  "src/app/[locale]/admin/export/page.tsx": WRAPPER_PAGE,
  "src/app/[locale]/admin/teams/page.tsx": LAYOUT,
  [PROXY_LIST]: proxyList(BASE_LIST),
};

const REASON = "a reason long enough for the manifest";
const gate = (value) => (value === "gated" ? { value } : { value, reason: REASON });
const route = (kind, methods) => ({ kind, methods: Object.keys(methods), sessionPasskeyGate: Object.fromEntries(Object.entries(methods).map(([m, v]) => [m, gate(v)])) });

const BASE_MANIFEST = {
  "src/app/api/auth/passkey/reauth/options/route.ts": route("api-default", { POST: "gated" }),
  "src/app/api/mcp/authorize/route.ts": route("api-session-required", { GET: "own-gate" }),
  "src/app/api/v1/openapi.json/route.ts": route("api-v1", { GET: "early-return" }),
  "src/app/api/v1/passwords/[id]/route.ts": route("api-v1", { GET: "early-return" }),
  "src/app/api/auth/[...nextauth]/route.ts": route("api-default", { GET: "tier-a", POST: "tier-a" }),
  "src/app/api/auth/passkey/verify/route.ts": route("api-default", { POST: "tier-a" }),
  "src/app/api/passwords/route.ts": route("api-session-required", { GET: "gated" }),
  "src/app/api/health/route.ts": route("api-default", { GET: "gated" }),
  ...Object.fromEntries(BEARER_ONLY.map((rel) => [rel, route("api-session-required", { POST: "gated" })])),
};

/** Write the base fixture into `root`, `files` / `manifest` merged over it (null deletes). */
function fixture(root, { files = {}, manifest = {}, rawManifest } = {}) {
  for (const [rel, contents] of Object.entries({ ...BASE_FILES, ...files })) {
    if (contents === null) continue;
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  const routes = Object.fromEntries(Object.entries({ ...BASE_MANIFEST, ...manifest }).filter(([, v]) => v !== null));
  const full = join(root, MANIFEST);
  mkdirSync(dirname(full), { recursive: true });
  if (rawManifest !== null) writeFileSync(full, rawManifest ?? JSON.stringify({ routes }, null, 2), "utf8");
}

function spawnGuard(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [GUARD], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (exitCode) => resolvePromise({ exitCode, out }));
  });
}

async function run(options) {
  const root = mkdtempSync(join(tmpdir(), "session-passkey-readers-"));
  try {
    fixture(root, options);
    return await spawnGuard({ SESSION_PASSKEY_READERS_ROOT: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function expectFail(options, pattern) {
  const { exitCode, out } = await run(options);
  expect(exitCode, out).toBe(1);
  expect(out).toMatch(pattern);
}

async function expectPass(options) {
  const { exitCode, out } = await run(options);
  expect(exitCode, out).toBe(0);
  expect(out).toContain("OK (every session reader");
  return out;
}

const MISSING_FROM_LIST = /gated api-default session reader missing from API_DEFAULT_SESSION_READERS/;
const NO_ADJUDICATOR = /own-gate but makes no import-bound call to passkeyEnforcementBlocks/;
const UNCHECKED_BYPASS = /so the proxy never checks its passkey/;

describe.concurrent("check-session-passkey-readers.mjs", { timeout: 60_000 }, () => {
  it("passes on the base fixture and counts what it examined", async () => {
    const out = await expectPass();
    // reauth, own-gate, openapi, nextauth, passkey verify, passwords; NOT the v1 shadow or health.
    // openapi.json is the early-return reader that adjudicates itself; its
    // FAIL counterpart (the call removed) is under Rule 1.
    expect(out).toMatch(
      /routes=11 readers=6 api-default-readers=1 own-gate=1 exemptions=2 session-required=5 bearer-only=3 gated-page-prefixes=2 page-segments=5/,
    );
  });

  // ─── Rule 4: the session cache never authenticates on its own ───
  it("FAILS for an api-session-required route that reads no session and is not bearer-only", async () => {
    await expectFail(
      { manifest: { "src/app/api/health/route.ts": route("api-session-required", { GET: "gated" }) } },
      /health\/route\.ts {2}is api-session-required but reads no session row itself/,
    );
  });

  it("FAILS for a bearer-only route that reads the session after all", async () => {
    await expectFail(
      { files: { [BEARER_ONLY[0]]: REAUTH } },
      /reads the session but is named in BEARER_ONLY_ROUTES/,
    );
  });

  it("FAILS for a stale bearer-only entry", async () => {
    await expectFail({ files: { [BEARER_ONLY[1]]: null }, manifest: { [BEARER_ONLY[1]]: null } }, /BEARER_ONLY_ROUTES .*token\/refresh.*: stale/);
  });

  it("FAILS for an api-session-required route that reads only the session cookie, not the row", async () => {
    await expectFail(
      {
        files: { "src/app/api/health/route.ts": COOKIE_ONLY_ROUTE },
        manifest: { "src/app/api/health/route.ts": route("api-session-required", { GET: "gated" }) },
      },
      /health\/route\.ts {2}is api-session-required but reads no session row itself/,
    );
  });

  it("FAILS when a session-gated layout reads no session", async () => {
    await expectFail(
      { files: { [ADMIN_LAYOUT]: "export default function Layout({ children }: { children: unknown }) { return children; }\n" } },
      /admin\/layout\.tsx {2}reads no session/,
    );
  });

  it("FAILS when a session-gated prefix has no layout", async () => {
    await expectFail({ files: { [DASHBOARD_LAYOUT]: null } }, /dashboard\/layout\.tsx {2}not found/);
  });

  it("FAILS when page-route.ts gates a new prefix that has no layout (the prefixes are read, not listed)", async () => {
    await expectFail(
      { files: { [PAGE_ROUTE]: pageRoute(`pathWithoutLocale.startsWith("/dashboard") || pathWithoutLocale.startsWith("/admin") || pathWithoutLocale.startsWith("/vault")`) } },
      /vault\/layout\.tsx {2}not found/,
    );
  });

  it("FAILS closed when page-route.ts's getSessionInfo guard cannot be read", async () => {
    await expectFail({ files: { [PAGE_ROUTE]: "export const nothing = 1;\n" } }, /expected one getSessionInfo call, found 0/);
  });

  it("FAILS closed when the getSessionInfo guard has an operand other than a literal startsWith", async () => {
    await expectFail(
      { files: { [PAGE_ROUTE]: pageRoute(`pathWithoutLocale.startsWith("/dashboard") || isGated(pathWithoutLocale)`) } },
      /operand other than a literal startsWith/,
    );
  });

  it("FAILS closed when page-route.ts calls getSessionInfo twice", async () => {
    await expectFail(
      { files: { [PAGE_ROUTE]: `${BASE_PAGE_ROUTE}export async function other(r: Request) { return getSessionInfo(r); }\n` } },
      /expected one getSessionInfo call, found 2/,
    );
  });

  it("FAILS for a gated layout that reads only the session cookie, not the row", async () => {
    await expectFail(
      { files: { [ADMIN_LAYOUT]: COOKIE_ONLY_ROUTE.replace("export async function GET(req: Request)", "export default async function Layout(req: Request)") } },
      /admin\/layout\.tsx {2}reads no session/,
    );
  });

  it("FAILS for a gated page that re-exports a data module", async () => {
    await expectFail(
      { files: { "src/app/[locale]/admin/export/page.tsx": `export { default } from "@/lib/pages/export";\n` } },
      /admin\/export\/page\.tsx {2}is a server component .* imports @\/lib\/pages\/export/,
    );
  });

  it("FAILS for a gated page whose dynamic import cannot be read", async () => {
    await expectFail(
      { files: { "src/app/[locale]/admin/export/page.tsx": `export default async function Page() {\n  const m = await import(name);\n  return m;\n}\n` } },
      /admin\/export\/page\.tsx {2}is a server component .* imports <unreadable dynamic import at line 2>/,
    );
  });

  it("FAILS for a non-page segment file (loading) that reads data without the session", async () => {
    await expectFail(
      { files: { "src/app/[locale]/admin/loading.tsx": DATA_PAGE } },
      /admin\/loading\.tsx {2}is a server component/,
    );
  });

  it("passes a gated page whose only outside import is type-only", async () => {
    await expectPass({ files: { "src/app/[locale]/admin/export/page.tsx": `import type { Row } from "@/lib/types";\n${WRAPPER_PAGE}` } });
  });

  it("FAILS for a server page under a gated prefix that reads data without reading the session", async () => {
    await expectFail(
      { files: { "src/app/[locale]/admin/export/page.tsx": DATA_PAGE } },
      /admin\/export\/page\.tsx {2}is a server component under the session-gated \/admin that reads no session row but imports @\/lib\/prisma/,
    );
  });

  it("passes the same data page once it is a client component", async () => {
    await expectPass({ files: { "src/app/[locale]/admin/export/page.tsx": `"use client";\n${DATA_PAGE}` } });
  });

  it("passes the same data page once it reads the session", async () => {
    await expectPass({ files: { "src/app/[locale]/admin/export/page.tsx": `${AUTH_IMPORT}\n${DATA_PAGE.replace("const rows", "await auth();\n  const rows")}` } });
  });

  // ─── Inputs ───
  it("FAILS when no route file is scanned", async () => {
    const files = Object.fromEntries(Object.keys(BASE_FILES).filter((k) => k.startsWith("src/app/")).map((k) => [k, null]));
    await expectFail({ files }, /scanned zero route files/);
  });

  it("FAILS when the manifest is missing", async () => {
    await expectFail({ rawManifest: null }, /manifest not found/);
  });

  it("FAILS when the proxy list is not a literal", async () => {
    await expectFail(
      { files: { [PROXY_LIST]: "export const API_DEFAULT_SESSION_READERS = build();\n" } },
      /is not an array literal/,
    );
  });

  it("FAILS when a route file has no manifest entry", async () => {
    await expectFail({ manifest: { "src/app/api/health/route.ts": null } }, /health\/route\.ts {2}has no route-policy-manifest\.json entry/);
  });

  it("FAILS when a method has no sessionPasskeyGate declaration", async () => {
    const entry = { kind: "api-default", methods: ["GET"] };
    await expectFail({ manifest: { "src/app/api/health/route.ts": entry } }, /has no valid sessionPasskeyGate declaration/);
  });

  // ─── Rule 3: API_DEFAULT_SESSION_READERS equality ───
  it("FAILS when a gated api-default reader is missing from the list", async () => {
    await expectFail({ files: { [PROXY_LIST]: proxyList([]) } }, MISSING_FROM_LIST);
  });

  it("FAILS when the list holds a route that reads no session", async () => {
    const list = proxyList([...BASE_LIST, ["GET", "/api/health"]]);
    await expectFail({ files: { [PROXY_LIST]: list } }, /lists GET \/api\/health, which is not a gated api-default route/);
  });

  it("FAILS for a reader imported under an alias", async () => {
    const aliased = `import { auth as getSession } from "@/auth";\nexport async function GET() {\n  return Response.json(await getSession());\n}\n`;
    await expectFail({ files: { "src/app/api/health/route.ts": aliased } }, MISSING_FROM_LIST);
  });

  it("FAILS for a reader read through a namespace import", async () => {
    const ns = `import * as authModule from "@/auth";\nexport async function GET() {\n  return Response.json(await authModule.auth());\n}\n`;
    await expectFail({ files: { "src/app/api/health/route.ts": ns } }, MISSING_FROM_LIST);
  });

  it("FAILS for a reader loaded by a dynamic import", async () => {
    const dyn = `export async function GET() {\n  const { auth } = await import("@/auth");\n  return Response.json(await auth());\n}\n`;
    await expectFail({ files: { "src/app/api/health/route.ts": dyn } }, MISSING_FROM_LIST);
  });

  it("FAILS for a getSessionToken* helper imported by a relative path", async () => {
    const rel = `import { getSessionTokenDigest } from "../sessions/helpers";\nexport async function GET(req: Request) {\n  return Response.json({ d: getSessionTokenDigest(req) });\n}\n`;
    await expectFail({ files: { "src/app/api/health/route.ts": rel } }, MISSING_FROM_LIST);
  });

  it.each([
    ["requireRecentCurrentAuthMethod", "@/lib/auth/session/recent-current-auth-method"],
    ["evaluateStepUpFreshness", "@/lib/auth/session/recent-current-auth-method"],
    ["canRecoverSessionWithPasskey", "@/lib/auth/session/recent-current-auth-method"],
    ["requireRecentSession", "@/lib/auth/session/step-up"],
    ["parseCookiePairs", "@/lib/auth/session/session-cookie"],
  ])("FAILS for the step-up / cookie reader %s", async (name, from) => {
    const src = `import { ${name} } from "${from}";\nexport async function GET(req: Request) {\n  return Response.json(await ${name}(req));\n}\n`;
    await expectFail({ files: { "src/app/api/health/route.ts": src } }, MISSING_FROM_LIST);
  });

  it("passes a same-named function from another module (bound by module, not spelling)", async () => {
    const other = `import { auth } from "@/lib/other-auth";\nexport async function GET() {\n  return Response.json(await auth());\n}\n`;
    await expectPass({ files: { "src/app/api/health/route.ts": other } });
  });

  it("passes a type-only import of a reader module", async () => {
    const typeOnly = `import type { auth } from "@/auth";\nexport async function GET() {\n  return Response.json({});\n}\n`;
    await expectPass({ files: { "src/app/api/health/route.ts": typeOnly } });
  });

  describe("the tier-a catch-all's gated concretePaths spellings (R5-4)", () => {
    // The real [...nextauth] entry: tier-a per method, and spellings the proxy
    // gates. Those spellings reach the proxy's gate before the handler, so they
    // must not make the catch-all an API_DEFAULT_SESSION_READERS member.
    const NEXTAUTH_KEY = "src/app/api/auth/[...nextauth]/route.ts";
    const GATED_SPELLINGS = [
      { path: "/api/auth/session/extra", method: "GET", outcome: "gated" },
      { path: "/api/auth/csrf", method: "POST", outcome: "gated" },
      { path: "/api/auth/unknown-action", method: "GET", outcome: "gated" },
    ];
    const withSpellings = (methods) => ({
      ...route("api-default", methods),
      concretePaths: [{ path: "/api/auth/session", method: "GET", outcome: "tier-a" }, ...GATED_SPELLINGS],
    });

    it("passes and counts no extra api-default reader", async () => {
      const out = await expectPass({ manifest: { [NEXTAUTH_KEY]: withSpellings({ GET: "tier-a", POST: "tier-a" }) } });
      expect(out).toMatch(/api-default-readers=1 /);
    });

    it("control: the same file declared gated per method FAILS as an unlisted reader", async () => {
      await expectFail({ manifest: { [NEXTAUTH_KEY]: withSpellings({ GET: "gated", POST: "tier-a" }) } }, MISSING_FROM_LIST);
    });
  });

  // ─── Local shadow ───
  it("FAILS when the v1 route's local checkAuth is replaced by the imported reader (shadow control)", async () => {
    const imported = swap(
      V1_SHADOW,
      `import { validateV1Auth } from "@/lib/auth/tokens/v1";\nasync function checkAuth(req: Request) {\n  return validateV1Auth(req);\n}\n`,
      `import { checkAuth } from "@/lib/auth/session/check-auth";\n`,
    );
    await expectFail({ files: { "src/app/api/v1/passwords/[id]/route.ts": imported } }, UNCHECKED_BYPASS);
  });

  it("passes an imported reader shadowed by a parameter of the same name", async () => {
    const shadowed = `import { auth } from "@/auth";\nexport async function GET(auth: () => unknown) {\n  return Response.json(await auth());\n}\n`;
    await expectPass({ files: { "src/app/api/health/route.ts": shadowed } });
  });

  // ─── Rule 1: tier-a / early-return readers ───
  it("FAILS for a tier-a reader with no exemption and no adjudicator call", async () => {
    await expectFail(
      { files: { "src/app/api/health/route.ts": REAUTH.replace("POST", "GET") }, manifest: { "src/app/api/health/route.ts": route("api-default", { GET: "tier-a" }) } },
      UNCHECKED_BYPASS,
    );
  });

  it("FAILS when the early-return reader's passkeyEnforcementBlocks call is removed", async () => {
    const removed = swap(OPENAPI, "result && passkeyEnforcementBlocks(await derivePasskeyState({ userId: result.userId }))", "result && (await derivePasskeyState({ userId: result.userId }))");
    await expectFail({ files: { "src/app/api/v1/openapi.json/route.ts": removed } }, UNCHECKED_BYPASS);
  });

  it("FAILS on a stale exemption (the exempt route no longer reads the session)", async () => {
    const noReader = `${NO_READER}export async function POST() {\n  return Response.json({ ok: true });\n}\n`;
    await expectFail({ files: { "src/app/api/auth/[...nextauth]/route.ts": noReader } }, /READER_EXEMPTIONS src\/app\/api\/auth\/\[\.\.\.nextauth\]\/route\.ts: stale/);
  });

  it("FAILS on a stale passkey-verify exemption (the route no longer reads the session cookie)", async () => {
    await expectFail(
      { files: { "src/app/api/auth/passkey/verify/route.ts": NO_READER.replace("GET", "POST") } },
      /READER_EXEMPTIONS src\/app\/api\/auth\/passkey\/verify\/route\.ts: stale/,
    );
  });

  // The exemption covers the bypassing (tier-a) declaration only: declared
  // gated, the reader must be on the proxy's list like any other.
  it("FAILS when passkey verify is declared a gated api-default reader without a proxy listing", async () => {
    await expectFail(
      { manifest: { "src/app/api/auth/passkey/verify/route.ts": route("api-default", { POST: "gated" }) } },
      MISSING_FROM_LIST,
    );
  });

  // ─── Rule 2: own-gate adjudicator ───
  it("FAILS for an own-gate route that calls only derivePasskeyState", async () => {
    const deriveOnly = swap(OWN_GATE, "if (passkeyEnforcementBlocks(state))", "if (state.requirePasskey)");
    await expectFail({ files: { "src/app/api/mcp/authorize/route.ts": deriveOnly } }, NO_ADJUDICATOR);
  });

  it("FAILS for an own-gate route with the passkeyEnforcementBlocks call removed (import kept)", async () => {
    const removed = swap(OWN_GATE, '  if (passkeyEnforcementBlocks(state)) return Response.redirect("x");\n', "");
    await expectFail({ files: { "src/app/api/mcp/authorize/route.ts": removed } }, NO_ADJUDICATOR);
  });

  it("FAILS when another export is aliased to the name passkeyEnforcementBlocks", async () => {
    const aliased = swap(
      OWN_GATE,
      ENFORCEMENT_IMPORT,
      `import { derivePasskeyState, derivePasskeyState as passkeyEnforcementBlocks } from "@/lib/auth/policy/passkey-enforcement";`,
    );
    await expectFail({ files: { "src/app/api/mcp/authorize/route.ts": aliased } }, NO_ADJUDICATOR);
  });

  it("FAILS when a local function shadows passkeyEnforcementBlocks", async () => {
    const shadowed = swap(OWN_GATE, "export async function GET", "function passkeyEnforcementBlocks(s: unknown) {\n  return false;\n}\nexport async function GET");
    await expectFail({ files: { "src/app/api/mcp/authorize/route.ts": shadowed } }, NO_ADJUDICATOR);
  });

  it("passes the adjudicator imported under an alias (import-bound, not spelled)", async () => {
    const aliased = swap(
      swap(OWN_GATE, ENFORCEMENT_IMPORT, `import { derivePasskeyState, passkeyEnforcementBlocks as blocks } from "@/lib/auth/policy/passkey-enforcement";`),
      "if (passkeyEnforcementBlocks(state))",
      "if (blocks(state))",
    );
    await expectPass({ files: { "src/app/api/mcp/authorize/route.ts": aliased } });
  });

  it("FAILS for an own-gate route that reads no session and calls nothing", async () => {
    await expectFail({ manifest: { "src/app/api/health/route.ts": route("api-default", { GET: "own-gate" }) } }, NO_ADJUDICATOR);
  });
});
