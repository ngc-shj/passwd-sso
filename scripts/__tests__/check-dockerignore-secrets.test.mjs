/**
 * Self-test for scripts/checks/check-dockerignore-secrets.sh — the CI guard
 * that asserts .dockerignore excludes every env/secret file from the Docker
 * build context so secrets never enter the image (2026-07 review, High:
 * Next.js standalone tracing copied .env into the image).
 *
 * Single fixture root via DOCKERIGNORE_SECRETS_ROOT (mirrors the prisma-pin
 * guard's multi-input discipline). RT7: the guard is proven able to go red.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-dockerignore-secrets.sh");

let root;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKERIGNORE_SECRETS_ROOT: root,
      DOCKERIGNORE_SECRETS_FIXTURE_MODE: "1",
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeDockerignore(contents) {
  writeFileSync(join(root, ".dockerignore"), contents, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dockerignore-secrets-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A FULL, correct ignore covering the whole git-ignored secret/artifact class
// the guard now enforces (env, keys/certs, CLI vault mapping, Terraform, DBs).
const RECURSIVE_IGNORE = [
  "node_modules",
  ".env", ".env.*", "**/.env", "**/.env.*", "!.env.example", "!**/.env.example",
  "**/*.pem", "**/*.key", "**/*.crt", "**/*.cert", "**/*.p12", "**/*.pfx",
  "**/master.key", "**/encryption.key", "**/saml",
  "**/.passwd-sso-env.json",
  "**/*review-credentials.local.md", "**/.load-test-auth.json", "**/.auth-state.json",
  "**/*.db", "**/*.sqlite", "**/*.db-journal", "**/postgres_data",
  "**/.terraform", "**/*.tfstate", "**/*.tfstate.*",
  "**/*.tfvars", "**/*.tfvars.json", "!**/*.tfvars.example",
  "**/test-results", "**/coverage", "**/.coverage-snapshots", "**/playwright-report",
].join("\n") + "\n";

describe("check-dockerignore-secrets", () => {
  it("passes when .dockerignore excludes the full secret class at any depth, keeps placeholders", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const r = runGuard();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OK (static:");
  });

  it("FAILS when .dockerignore does not exclude .env (the original leak)", () => {
    writeDockerignore("node_modules\n.env.local\n.env*.local\n");
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("does NOT exclude git-ignored secret/artifact");
  });

  it("FAILS when .dockerignore excludes .env but NOT keys/certs (*.pem leak)", () => {
    writeDockerignore("node_modules\n.env\n.env.*\n**/.env\n**/.env.*\n!.env.example\n!**/.env.example\n");
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain(".pem");
  });

  it("FAILS when .dockerignore excludes secrets but NOT Terraform state/.terraform", () => {
    writeDockerignore(
      "node_modules\n**/.env\n**/.env.*\n!**/.env.example\n**/*.pem\n**/*.key\n**/*.crt\n**/*.cert\n**/*.p12\n**/*.pfx\n**/master.key\n**/encryption.key\n**/.passwd-sso-env.json\n**/*review-credentials.local.md\n**/.load-test-auth.json\n**/*.db\n**/*.sqlite\n",
    );
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/\.terraform|tfstate|tfvars/);
  });

  it("FAILS when .dockerignore misses session-token / DB-data artifacts (.auth-state.json, postgres_data, *.db-journal, saml)", () => {
    // Everything covered EXCEPT the Round-4-review class — proves each is enforced.
    const missing = ["**/.auth-state.json", "**/postgres_data", "**/*.db-journal", "**/saml"];
    for (const drop of missing) {
      const partial = RECURSIVE_IGNORE.replace(drop + "\n", "");
      writeDockerignore(partial);
      const r = runGuard();
      expect(r.exitCode, `dropping ${drop} should fail the guard`).toBe(1);
    }
  });

  it("static probes follow DIR_CLASSES: dropping a dir-class pattern is caught by the generated probe", () => {
    // Read DIR_CLASSES from the guard, drop each dir's pattern from an otherwise
    // complete .dockerignore, and require the static check to fail via the
    // auto-generated __dockerignore_probe__ path (proving the static side follows
    // DIR_CLASSES, not just hand-listed MUST_EXCLUDE paths).
    const guardSrc = readFileSync(GUARD, "utf8");
    const block = guardSrc.match(/DIR_CLASSES=\(([\s\S]*?)\)/);
    const dirs = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const d of dirs) {
      const partial = RECURSIVE_IGNORE.replace(`**/${d}\n`, "");
      writeDockerignore(partial);
      const r = runGuard();
      expect(r.exitCode, `dropping **/${d} must fail static`).toBe(1);
      expect(r.stdout + r.stderr).toContain(`${d}/__dockerignore_probe__`);
    }
  });

  it("FAILS when .dockerignore excludes only root .env but not nested (extension/.env miss)", () => {
    // Full secret class EXCEPT the recursive **/.env — the exact pre-fix gap
    // that let extension/.env ship while everything else was covered.
    const rootOnlyEnv = RECURSIVE_IGNORE
      .replace("**/.env\n", "")
      .replace("**/.env.*\n", "");
    writeDockerignore(rootOnlyEnv);
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("extension/.env");
  });

  it("keeps nested committed placeholders (extension/.env.example) included", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const r = runGuard();
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("over-excludes");
  });

  it("FAILS when .dockerignore over-excludes the committed .env.example", () => {
    // Full secret class but WITHOUT the !.env.example re-includes → placeholder dropped.
    const noReinclude = RECURSIVE_IGNORE
      .replace("!.env.example\n", "")
      .replace("!**/.env.example\n", "");
    writeDockerignore(noReinclude);
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("over-excludes committed placeholder");
  });

  it("FAILS when a built tree contains a NESTED secret .env (full-tree bundle scan)", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    // Simulate an extracted image tree with a nested leak (the extension/.env case).
    const nested = join(root, "image", "app", "extension");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".env"), "DATABASE_URL=secret\n", "utf8");
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("extension/.env");
  });

  it("FAILS when a built tree contains a session-token artifact (e2e/.auth-state.json bundle scan)", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const e2e = join(root, "image", "app", "e2e");
    mkdirSync(e2e, { recursive: true });
    writeFileSync(join(e2e, ".auth-state.json"), '{"token":"secret"}\n', "utf8");
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain(".auth-state.json");
  });

  it("FAILS when a built tree contains a postgres_data dir or *.db-journal (bundle scan)", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const pg = join(root, "image", "app", "postgres_data", "base");
    const prisma = join(root, "image", "app", "prisma");
    mkdirSync(pg, { recursive: true });
    mkdirSync(prisma, { recursive: true });
    writeFileSync(join(pg, "1"), "PGDATA\n", "utf8");
    writeFileSync(join(prisma, "dev.db-journal"), "JOURNAL\n", "utf8");
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/postgres_data|db-journal/);
  });

  it("FAILS when a built tree contains a nested key/cert or Terraform state (bundle scan)", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const certs = join(root, "image", "app", "certificates");
    const tf = join(root, "image", "app", "infra", "terraform");
    mkdirSync(certs, { recursive: true });
    mkdirSync(tf, { recursive: true });
    writeFileSync(join(certs, "localhost-key.pem"), "KEY\n", "utf8");
    writeFileSync(join(tf, "terraform.tfstate"), "{}\n", "utf8");
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/localhost-key\.pem|terraform\.tfstate/);
  });

  it("passes the bundle scan when the built tree has no secret/artifact", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const appDir = join(root, "image", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, ".env.example"), "DATABASE_URL=\n", "utf8");
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("has no git-ignored secret/artifact at any depth");
  });

  it("ignores node_modules .env fixtures in the bundle scan", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const nm = join(root, "image", "app", "node_modules", "somepkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, ".env"), "FIXTURE=1\n", "utf8");
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
    });
    expect(r.exitCode).toBe(0);
  });

  it("refuses a root override under CI without fixture-mode ack (env-pollution guard)", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const r = runGuard({ CI: "true", DOCKERIGNORE_SECRETS_FIXTURE_MODE: "" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("ENV_POLLUTION_GUARD");
  });

  // Shim helper: delegate the Nth-and-earlier `node` calls to the real node,
  // and run `failScript` for the (delegateCount+1)-th call onward. Lets a test
  // pass the STATIC node check (call 1) and only break the BUNDLE derivation
  // (call 2), so the bundle fail-closed path is genuinely exercised.
  function makeNodeShim(dirName, delegateCount, failBody) {
    const shimDir = join(root, dirName);
    mkdirSync(shimDir, { recursive: true });
    const counter = join(shimDir, ".n");
    writeFileSync(
      join(shimDir, "node"),
      `#!/usr/bin/env bash\n` +
        `n=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 ))\n` +
        `echo $n > ${counter}\n` +
        `if [ "$n" -le ${delegateCount} ]; then exec ${process.execPath} "$@"; fi\n` +
        failBody +
        `\n`,
      { mode: 0o755 },
    );
    return shimDir;
  }

  it("FAILS CLOSED at the BUNDLE path when its node derivation crashes (reaches bundle code)", () => {
    // Delegate the static call (1), crash the bundle call (2) → the guard must
    // hit the bundle's own fail-closed branch, not abort earlier at static.
    writeDockerignore(RECURSIVE_IGNORE);
    const shimDir = makeNodeShim("shim-crash", 1, "exit 7");
    mkdirSync(join(root, "image", "app"), { recursive: true });
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
      PATH: `${shimDir}:${process.env.PATH}`,
    });
    expect(r.exitCode).toBe(1);
    // This exact message is emitted ONLY by the bundle derivation's fail-closed
    // branch — proving the bundle code ran (not a static abort).
    expect(r.stdout + r.stderr).toContain("signature derivation failed");
  });

  it("FAILS CLOSED when the bundle-scan find errors (3rd fail-open path)", () => {
    // Delegate both node calls (static + bundle derivation succeed), then shim
    // `find` to exit non-zero → the guard must fail closed on find's status,
    // not swallow it. Proves the find-error path independently.
    writeDockerignore(RECURSIVE_IGNORE);
    const shimDir = join(root, "shim-find");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "find"), "#!/usr/bin/env bash\nexit 4\n", { mode: 0o755 });
    mkdirSync(join(root, "image", "app"), { recursive: true });
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
      PATH: `${shimDir}:${process.env.PATH}`,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/find failed|failing CLOSED/);
  });

  it("FAILS CLOSED when the bundle-scan node emits an empty signature set", () => {
    // Delegate the static call (1); on the bundle call (2) print nothing + exit 0
    // → the guard's `-z "$SIGS_RAW"` fail-closed branch must fire.
    writeDockerignore(RECURSIVE_IGNORE);
    const shimDir = makeNodeShim("shim-empty", 1, "printf ''");
    mkdirSync(join(root, "image", "app"), { recursive: true });
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
      PATH: `${shimDir}:${process.env.PATH}`,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/failing CLOSED/);
  });

  // ── Contract: bundle scan catches EVERY static MUST_EXCLUDE class ───────────
  // Proves the single-source claim — the bundle scan's derived signatures cover
  // the same set the static assertion enforces. Parse MUST_EXCLUDE straight from
  // the guard script, plant each representative path in a fake image tree ONE AT
  // A TIME, and require the bundle scan to flag it. If someone adds a class to
  // MUST_EXCLUDE but the derivation doesn't produce a matching signature, this
  // fails — no silent static/bundle drift.
  it("bundle scan flags every MUST_EXCLUDE representative path (no static/bundle drift)", () => {
    const guardSrc = readFileSync(GUARD, "utf8");
    const block = guardSrc.match(/MUST_EXCLUDE=\(([\s\S]*?)\n\)/);
    expect(block, "MUST_EXCLUDE array must be parseable from the guard").toBeTruthy();
    const paths = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(20);

    for (const p of paths) {
      // Fresh tree per path so one leak can't mask another.
      const imageRoot = mkdtempSync(join(tmpdir(), "di-contract-"));
      try {
        writeDockerignore(RECURSIVE_IGNORE);
        const full = join(imageRoot, "app", p);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, "SECRET\n", "utf8");
        const r = runGuard({
          DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
          DOCKERIGNORE_SECRETS_IMAGE_ROOT: imageRoot,
        });
        expect(r.exitCode, `bundle scan must flag planted secret ${p}`).toBe(1);
      } finally {
        rmSync(imageRoot, { recursive: true, force: true });
      }
    }
  });

  // Dir-classes must catch the WHOLE subtree, not just the representative leaf.
  // Plant an ARBITRARY, non-representative filename deep inside each DIR_CLASSES
  // dir and require the bundle scan to flag it — proving a new dir-class added to
  // DIR_CLASSES genuinely covers its subtree (the R7 review gap: the old
  // hardcoded fallback only caught the representative basename).
  it("bundle scan flags arbitrary files anywhere under each DIR_CLASSES subtree", () => {
    const guardSrc = readFileSync(GUARD, "utf8");
    const block = guardSrc.match(/DIR_CLASSES=\(([\s\S]*?)\)/);
    expect(block, "DIR_CLASSES array must be parseable from the guard").toBeTruthy();
    const dirs = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(dirs.length).toBeGreaterThanOrEqual(3);

    for (const d of dirs) {
      const imageRoot = mkdtempSync(join(tmpdir(), "di-dirclass-"));
      try {
        writeDockerignore(RECURSIVE_IGNORE);
        // Arbitrary name that matches NO file glob — only the dir-class covers it.
        const full = join(imageRoot, "app", "some", d, "deep", "arbitrary-blob.xyz");
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, "SECRET\n", "utf8");
        const r = runGuard({
          DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
          DOCKERIGNORE_SECRETS_IMAGE_ROOT: imageRoot,
        });
        expect(r.exitCode, `bundle scan must flag arbitrary file under ${d}/`).toBe(1);
        expect(r.stdout + r.stderr).toContain(d);
      } finally {
        rmSync(imageRoot, { recursive: true, force: true });
      }
    }
  });
});
