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
});
