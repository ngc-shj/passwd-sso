/**
 * Three-set reconciliation parity test for
 * scripts/checks/crypto-auth-deps-manifest.json.
 *
 * Import scanning is NOT the sole source of truth (it misses dynamic import(),
 * defensive/transitive deps, and package-json-present-but-unimported deps).
 * The guard reconciles THREE sets per workspace and fails on their disagreement:
 *   1. CODE     — crypto/auth-sensitive external specifiers derived from source
 *                 via ts-morph AST (static import + string-literal import() +
 *                 const-resolved import()), over the crypto/auth defining roots.
 *   2. DEPS     — the workspace package.json `dependencies`.
 *   3. MANIFEST — the declared `packages` in the manifest.
 *
 * Failures:
 *   (A) a CODE specifier absent from MANIFEST ∪ excluded          → new sensitive import unregistered
 *   (B) a MANIFEST package absent from its workspace DEPS         → manifest entry vanished from package.json
 *   (C) a crypto/auth-sensitive DEPS package with no CODE hit AND
 *       not marked detectedBy including "manual" / confirmed dynamic → sensitive-in-deps-not-in-code
 *   (D) a MANIFEST entry with a <10-char reason or a non-enum owner → metadata completeness
 *
 * Filesystem + ts-morph only (no @prisma/client) — safe without a generated
 * Prisma client. Mirrors src/__tests__/workers/worker-policy-manifest.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseRouteSource } from "../proxy/ast-guards";
import { Node, SyntaxKind } from "ts-morph";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "scripts/checks/crypto-auth-deps-manifest.json");

// Crypto/auth defining roots per workspace (GT-6). A file/dir here is scanned
// for external imports; a crypto/auth dep imported OUTSIDE these roots relies on
// the DEPS-side (C) name-pattern heuristic instead.
const CODE_ROOTS: Record<string, string[]> = {
  root: [
    "src/lib/crypto",
    "src/lib/auth",
    "src/lib/prisma.ts",
    "src/lib/email",
    "src/auth.ts",
    "src/auth.config.ts",
    "src/components/passwords/shared",
    "src/app/api/auth/passkey",
    "src/app/api/webauthn",
  ],
  cli: ["cli/src"],
  extension: ["extension/src"],
};

const WORKSPACE_PACKAGE_JSON: Record<string, string> = {
  root: "package.json",
  cli: "cli/package.json",
  extension: "extension/package.json",
};

const OWNERS_ENUM = ["security"];

// Names that make an unmatched DEPS package crypto/auth-sensitive (widens the
// (C) DEPS side; NEVER auto-approves). Enumerated + self-tested (T3).
const CRYPTO_NAME_RE =
  /crypt|cipher|kdf|pbkdf|bcrypt|scrypt|argon|hash|hmac|sign|jwt|jose|jwk|webauthn|passkey|fido|otp|totp|hotp|nacl|sodium|noble|tweetnacl|oidc|oauth|saml|nodemailer/i;

interface ManifestEntry {
  package?: string;
  workspace: string;
  reason: string;
  detectedBy: string[];
  owners: string[];
  category: string;
}
interface Manifest {
  packages: Record<string, ManifestEntry>;
  excluded: Record<string, { package?: string; workspace: string; reason: string }>;
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

// The real package name for a manifest key (composite keys like "otpauth@cli"
// carry the actual name in `package`).
function entryPackage(key: string, entry: { package?: string }): string {
  return entry.package ?? key;
}

// ── pure detection functions (each independently self-tested, RT7) ──────────

/**
 * Strip a subpath import specifier to its package root:
 * "@scope/name/sub" → "@scope/name"; "name/sub" → "name".
 */
export function toPackageRoot(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

export function isExternalSpecifier(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  if (specifier.startsWith("node:")) return false;
  if (specifier.startsWith("@/")) return false;
  const root = toPackageRoot(specifier);
  if (root === "next" || root === "react" || root === "react-dom") return false;
  if (root.startsWith("next/") || root.startsWith("react/")) return false;
  return true;
}

/**
 * Extract external package-root specifiers from one source file: static imports,
 * string-literal dynamic import(), AND const-resolved dynamic import() where the
 * argument is an identifier bound to a same-file string literal
 * (`const m = "pkg"; await import(m)`). Returns a de-duplicated set.
 */
export function extractExternalSpecifiers(source: string, virtualPath: string): Set<string> {
  const sf = parseRouteSource(source, virtualPath);
  const out = new Set<string>();

  for (const imp of sf.getImportDeclarations()) {
    const spec = imp.getModuleSpecifierValue();
    if (isExternalSpecifier(spec)) out.add(toPackageRoot(spec));
  }

  // Resolve same-file `const x = "literal"` bindings for indirected import(x).
  // Use descendants (not just top-level) — the binding is commonly a
  // function-scoped const (e.g. crypto-client.ts's `const moduleName = "hash-wasm"`).
  const stringConsts = new Map<string, string>();
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (init && Node.isStringLiteral(init)) {
      stringConsts.set(decl.getName(), init.getLiteralText());
    }
  }

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const arg = call.getArguments()[0];
    if (!arg) continue;
    let spec: string | undefined;
    if (Node.isStringLiteral(arg)) {
      spec = arg.getLiteralText();
    } else if (Node.isIdentifier(arg)) {
      spec = stringConsts.get(arg.getText());
    }
    if (spec && isExternalSpecifier(spec)) out.add(toPackageRoot(spec));
  }

  return out;
}

/** (A) CODE specifiers not in MANIFEST and not excluded → findings. */
export function computeUnregisteredImports(
  codeSpecifiers: Set<string>,
  manifestPackages: Set<string>,
  excluded: Set<string>,
): string[] {
  const findings: string[] = [];
  for (const spec of codeSpecifiers) {
    if (!manifestPackages.has(spec) && !excluded.has(spec)) {
      findings.push(spec);
    }
  }
  return findings.sort();
}

/** (C) crypto-named DEPS packages with no CODE hit that aren't legitimately code-absent. */
export function computeUnbackedSensitiveDeps(
  deps: string[],
  codeSpecifiers: Set<string>,
  manifestByPackage: Map<string, ManifestEntry>,
  excluded: Set<string>,
): string[] {
  const findings: string[] = [];
  for (const dep of deps) {
    if (excluded.has(dep)) continue;
    if (!CRYPTO_NAME_RE.test(dep)) continue; // heuristic only widens; never approves
    if (codeSpecifiers.has(dep)) continue; // has a real CODE occurrence
    const entry = manifestByPackage.get(dep);
    // Code-absent is allowed only if declared manual, or dynamic-import that the
    // scanner could NOT resolve here (outside these roots) — represented as manual.
    if (entry && entry.detectedBy.includes("manual")) continue;
    findings.push(dep);
  }
  return findings.sort();
}

/** (D) metadata completeness: reason ≥10 chars and every owner in the enum. */
export function computeMetadataViolations(
  key: string,
  entry: ManifestEntry,
  ownersEnum: string[],
): string[] {
  const violations: string[] = [];
  if (!entry.reason || entry.reason.length < 10) {
    violations.push(`${key}: reason must be ≥10 chars`);
  }
  if (!entry.owners || entry.owners.length === 0) {
    violations.push(`${key}: owners must be non-empty`);
  } else {
    for (const owner of entry.owners) {
      if (!ownersEnum.includes(owner)) {
        violations.push(`${key}: owner "${owner}" not in OWNERS enum`);
      }
    }
  }
  return violations;
}

// ── helpers for walking the real tree ───────────────────────────────────────

function walkSourceFiles(root: string): string[] {
  const abs = path.join(REPO_ROOT, root);
  if (!existsSync(abs)) return [];
  // If root points at a single file, handle it directly.
  if (root.endsWith(".ts") || root.endsWith(".tsx")) {
    return [abs];
  }
  const files: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const full = path.join(abs, entry.name);
    const rel = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(rel));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function codeSpecifiersForWorkspace(workspace: string): Set<string> {
  const out = new Set<string>();
  for (const root of CODE_ROOTS[workspace] ?? []) {
    for (const file of walkSourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      const rel = path.relative(REPO_ROOT, file);
      for (const spec of extractExternalSpecifiers(source, rel)) out.add(spec);
    }
  }
  return out;
}

function depsForWorkspace(workspace: string): string[] {
  const pkgPath = path.join(REPO_ROOT, WORKSPACE_PACKAGE_JSON[workspace]);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {});
}

// ── reconciliation over the real tree ───────────────────────────────────────

describe("crypto-auth-deps-manifest — three-set reconciliation", () => {
  const manifest = loadManifest();

  // MANIFEST packages / excluded, grouped by workspace, keyed by real package name.
  function manifestPackagesFor(workspace: string): Map<string, ManifestEntry> {
    const m = new Map<string, ManifestEntry>();
    for (const [key, entry] of Object.entries(manifest.packages)) {
      if (entry.workspace === workspace) m.set(entryPackage(key, entry), entry);
    }
    return m;
  }
  function excludedFor(workspace: string): Set<string> {
    const s = new Set<string>();
    for (const [key, entry] of Object.entries(manifest.excluded)) {
      if (entry.workspace === workspace) s.add(entryPackage(key, entry));
    }
    return s;
  }

  it("manifest JSON parses and every packages entry has complete metadata (D)", () => {
    const violations: string[] = [];
    for (const [key, entry] of Object.entries(manifest.packages)) {
      violations.push(...computeMetadataViolations(key, entry, OWNERS_ENUM));
      expect(entry.workspace, `${key}.workspace`).toBeTruthy();
      expect(entry.detectedBy?.length, `${key}.detectedBy`).toBeGreaterThan(0);
      expect(entry.category, `${key}.category`).toBeTruthy();
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  for (const workspace of ["root", "cli", "extension"]) {
    describe(`workspace: ${workspace}`, () => {
      const code = codeSpecifiersForWorkspace(workspace);
      const deps = depsForWorkspace(workspace);
      const manifestByPackage = manifestPackagesFor(workspace);
      const manifestPackages = new Set(manifestByPackage.keys());
      const excluded = excludedFor(workspace);

      it("(A) every CODE crypto/auth import is registered in the manifest or excluded", () => {
        const findings = computeUnregisteredImports(code, manifestPackages, excluded);
        expect(
          findings,
          `unregistered imports in ${workspace}: ${findings.join(", ")}`,
        ).toEqual([]);
      });

      it("(B) every manifest package is present in the workspace package.json dependencies", () => {
        const depSet = new Set(deps);
        const missing = [...manifestPackages].filter((p) => !depSet.has(p));
        expect(missing, `manifest packages missing from ${workspace} deps: ${missing.join(", ")}`).toEqual(
          [],
        );
      });

      it("(C) every crypto-named dependency has a CODE occurrence or a reasoned manual entry", () => {
        const findings = computeUnbackedSensitiveDeps(deps, code, manifestByPackage, excluded);
        expect(
          findings,
          `crypto-named deps in ${workspace} lacking CODE evidence and manual marker: ${findings.join(", ")}`,
        ).toEqual([]);
      });
    });
  }
});

// ── RT7 negative self-tests: each pure function must be provably able to fail ──

describe("RT7 self-test — extractExternalSpecifiers", () => {
  it("extracts static, string-literal-dynamic, and const-resolved-dynamic imports", () => {
    const src = [
      `import { a } from "next-auth";`,
      `import x from "./local";`,
      `import y from "node:crypto";`,
      `const moduleName = "hash-wasm";`,
      `async function f() { await import(moduleName); }`,
      `async function g() { await import("bcrypt-pbkdf"); }`,
    ].join("\n");
    const specs = extractExternalSpecifiers(src, "virtual/x.ts");
    expect(specs.has("next-auth")).toBe(true);
    expect(specs.has("hash-wasm")).toBe(true);
    expect(specs.has("bcrypt-pbkdf")).toBe(true);
    expect(specs.has("./local")).toBe(false);
    expect(specs.has("node:crypto")).toBe(false);
  });

  it("strips subpaths to the package root", () => {
    const src = `import N from "next-auth/providers/nodemailer";\nimport t from "@simplewebauthn/server/helpers";`;
    const specs = extractExternalSpecifiers(src, "virtual/y.ts");
    expect(specs.has("next-auth")).toBe(true);
    expect(specs.has("@simplewebauthn/server")).toBe(true);
  });
});

describe("RT7 self-test — isExternalSpecifier", () => {
  it("drops relative, node:, @/, and framework specifiers", () => {
    expect(isExternalSpecifier("./x")).toBe(false);
    expect(isExternalSpecifier("node:fs")).toBe(false);
    expect(isExternalSpecifier("@/lib/x")).toBe(false);
    expect(isExternalSpecifier("next/server")).toBe(false);
    expect(isExternalSpecifier("react")).toBe(false);
    expect(isExternalSpecifier("hash-wasm")).toBe(true);
    expect(isExternalSpecifier("@simplewebauthn/server")).toBe(true);
  });
});

describe("RT7 self-test — computeUnregisteredImports (A)", () => {
  it("flags a CODE import absent from manifest and excluded", () => {
    const code = new Set(["new-crypto-lib", "next-auth"]);
    const findings = computeUnregisteredImports(code, new Set(["next-auth"]), new Set());
    expect(findings).toEqual(["new-crypto-lib"]);
  });
  it("does not flag an excluded or manifest-listed import", () => {
    const code = new Set(["zod", "next-auth"]);
    expect(
      computeUnregisteredImports(code, new Set(["next-auth"]), new Set(["zod"])),
    ).toEqual([]);
  });
});

describe("RT7 self-test — computeUnbackedSensitiveDeps (C)", () => {
  const staticEntry = (): ManifestEntry => ({
    workspace: "root",
    reason: "x".repeat(10),
    detectedBy: ["static-import"],
    owners: ["security"],
    category: "kdf",
  });
  const manualEntry = (): ManifestEntry => ({ ...staticEntry(), detectedBy: ["manual"] });

  it("flags a crypto-named dep with no CODE hit and no manual marker", () => {
    const findings = computeUnbackedSensitiveDeps(
      ["hash-wasm"],
      new Set(),
      new Map([["hash-wasm", staticEntry()]]),
      new Set(),
    );
    expect(findings).toEqual(["hash-wasm"]);
  });
  it("does NOT flag a code-absent dep marked detectedBy manual", () => {
    const findings = computeUnbackedSensitiveDeps(
      ["hash-wasm"],
      new Set(),
      new Map([["hash-wasm", manualEntry()]]),
      new Set(),
    );
    expect(findings).toEqual([]);
  });
  it("does NOT flag a crypto-named dep that has a CODE occurrence", () => {
    const findings = computeUnbackedSensitiveDeps(
      ["hash-wasm"],
      new Set(["hash-wasm"]),
      new Map([["hash-wasm", staticEntry()]]),
      new Set(),
    );
    expect(findings).toEqual([]);
  });
  it("ignores a non-crypto-named dep entirely (heuristic does not widen)", () => {
    const findings = computeUnbackedSensitiveDeps(["chalk"], new Set(), new Map(), new Set());
    expect(findings).toEqual([]);
  });
  it("ignores an excluded crypto-named dep", () => {
    const findings = computeUnbackedSensitiveDeps(
      ["jsrsasign"],
      new Set(),
      new Map(),
      new Set(["jsrsasign"]),
    );
    expect(findings).toEqual([]);
  });
});

describe("RT7 self-test — computeMetadataViolations (D)", () => {
  const base = (): ManifestEntry => ({
    workspace: "root",
    reason: "a sufficiently long reason",
    detectedBy: ["static-import"],
    owners: ["security"],
    category: "kdf",
  });
  it("flags a <10-char reason", () => {
    const e = { ...base(), reason: "short" };
    expect(computeMetadataViolations("k", e, OWNERS_ENUM)).toContain("k: reason must be ≥10 chars");
  });
  it("flags an owner outside the enum", () => {
    const e = { ...base(), owners: ["nobody"] };
    expect(computeMetadataViolations("k", e, OWNERS_ENUM)).toContain(
      'k: owner "nobody" not in OWNERS enum',
    );
  });
  it("flags empty owners", () => {
    const e = { ...base(), owners: [] };
    expect(computeMetadataViolations("k", e, OWNERS_ENUM)).toContain("k: owners must be non-empty");
  });
  it("passes a complete entry", () => {
    expect(computeMetadataViolations("k", base(), OWNERS_ENUM)).toEqual([]);
  });
});

describe("RT7 self-test — DEPS name-pattern heuristic (T3)", () => {
  it("surfaces a crypto-named synthetic dep", () => {
    expect(CRYPTO_NAME_RE.test("some-argon2-lib")).toBe(true);
    expect(CRYPTO_NAME_RE.test("jsrsasign")).toBe(true);
    expect(CRYPTO_NAME_RE.test("nodemailer")).toBe(true);
  });
  it("does not surface a clearly non-crypto name", () => {
    expect(CRYPTO_NAME_RE.test("chalk")).toBe(false);
    expect(CRYPTO_NAME_RE.test("commander")).toBe(false);
  });
});
