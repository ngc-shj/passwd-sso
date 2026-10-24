/**
 * Self-test for scripts/checks/check-worker-bundle-smoke.sh — the R32 boot smoke
 * gate that requires the worker member set, the Dockerfile esbuild set and the
 * COPY set to be equal, then boots each bundle with --validate-env-only and only
 * its ECS task's env, requiring its markers.
 *
 * RT7: a guard is only trustworthy once it is proven able to go RED. Each red
 * case below is a fixture with one defect: a missing COPY, a missing esbuild, a
 * member in neither, a bundle exiting 0 without its marker, a bundle needing a
 * variable its task lacks, a forbidden module bundled, a bundled module that
 * crashes on load. The docker runner is exercised through a stub CLI that
 * records the arguments it was given.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-worker-bundle-smoke.sh");
const DOCKERFILE = readFileSync(join(REPO_ROOT, "Dockerfile"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/checks/worker-policy-manifest.json"), "utf8"));
const SMOKE_MAP = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/checks/worker-bundle-smoke.json"), "utf8"));

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    timeout: 120_000,
    env: { ...process.env, ...extraEnv },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let dir;
let seq = 0;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-smoke-selftest-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes `text` to a fresh file in the fixture dir and returns its path. */
function fixtureFile(name, text) {
  const path = join(dir, `${seq++}-${name}`);
  writeFileSync(path, text, "utf8");
  return path;
}

function without(text, fragment) {
  expect(text.split(fragment).length - 1).toBe(1);
  return text.replace(fragment, "");
}

const PUBLISHER_COPY =
  "COPY --from=builder --chown=nextjs:nodejs /app/dist/audit-anchor-publisher.js ./dist/audit-anchor-publisher.js\n";
const VERIFY_ESBUILD = `RUN npx esbuild scripts/audit-chain-verify-worker.ts \\
      --bundle --platform=node --target=node24 \\
      --outfile=dist/audit-chain-verify-worker.js \\
      --external:pg --external:@prisma/client --external:@prisma/adapter-pg \\
      --tsconfig=tsconfig.json \\
      --alias:@=./src
`;

/** A one-worker repo: its own Dockerfile, map and manifest around `source`. */
function oneWorker(source, { env = {}, markers = ["env validation passed"], forbiddenInputs = [] } = {}) {
  const src = fixtureFile("fixture-worker.ts", source);
  const name = src.split("/").pop().replace(/\.ts$/, "");
  const bundle = `dist/${name}.js`;
  return {
    WORKER_BUNDLE_SMOKE_DOCKERFILE: fixtureFile(
      "Dockerfile",
      [
        "FROM node:24-alpine AS builder",
        `RUN npx esbuild ${src} --bundle --platform=node --target=node24 --outfile=${bundle}`,
        "FROM node:24-alpine AS runner",
        "ENV NODE_ENV=production",
        `COPY --from=builder /app/${bundle} ./${bundle}`,
        "",
      ].join("\n"),
    ),
    WORKER_BUNDLE_SMOKE_MAP: fixtureFile(
      "map.json",
      JSON.stringify({ tasks: { fixture: { bundle, env, markers, forbiddenInputs } } }),
    ),
    WORKER_BUNDLE_SMOKE_MANIFEST: fixtureFile("manifest.json", JSON.stringify({ workers: { fixture: { entrypoint: src } } })),
  };
}

const PRINTS_MARKER = 'console.log(JSON.stringify({ level: "info", msg: "env validation passed" }));\n';
const NEEDS_DATABASE_URL = `if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }\n${PRINTS_MARKER}`;

describe("check-worker-bundle-smoke.sh: host runner", () => {
  it("passes against the real repo (four worker bundles boot with their task env)", () => {
    const { exitCode, stdout, stderr } = runGuard();
    expect(exitCode, stdout + stderr).toBe(0);
    expect(stdout).toContain("4 workers; member, esbuild and COPY sets equal");
    for (const name of Object.keys(SMOKE_MAP.tasks)) expect(stdout).toContain(`  ${name}: ok`);
  });

  it("FAILS when the runner stage does not COPY a member's bundle", () => {
    const { exitCode, stdout } = runGuard({
      WORKER_BUNDLE_SMOKE_DOCKERFILE: fixtureFile("Dockerfile", without(DOCKERFILE, PUBLISHER_COPY)),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("ERROR MEMBER_WITHOUT_COPY: dist/audit-anchor-publisher.js");
  });

  it("FAILS when the Dockerfile does not bundle a member", () => {
    const { exitCode, stdout } = runGuard({
      WORKER_BUNDLE_SMOKE_DOCKERFILE: fixtureFile("Dockerfile", without(DOCKERFILE, VERIFY_ESBUILD)),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("ERROR MEMBER_WITHOUT_ESBUILD: dist/audit-chain-verify-worker.js");
    expect(stdout).not.toContain("MEMBER_WITHOUT_COPY");
  });

  it("FAILS on a member that is neither bundled nor copied", () => {
    const manifest = structuredClone(MANIFEST);
    manifest.workers["ghost-worker"] = { entrypoint: "scripts/ghost-worker.ts" };
    const { exitCode, stdout } = runGuard({ WORKER_BUNDLE_SMOKE_MANIFEST: fixtureFile("manifest.json", JSON.stringify(manifest)) });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("ERROR MEMBER_WITHOUT_ESBUILD: dist/ghost-worker.js");
    expect(stdout).toContain("ERROR MEMBER_WITHOUT_COPY: dist/ghost-worker.js");
    expect(stdout).toContain("ERROR MEMBER_WITHOUT_TASK_ENV: dist/ghost-worker.js");
  });

  it("FAILS on a bundle that is built and copied but is no member", () => {
    const extra = `${VERIFY_ESBUILD.replaceAll("audit-chain-verify-worker", "extra-worker")}`;
    const text = DOCKERFILE.replace(VERIFY_ESBUILD, `${VERIFY_ESBUILD}${extra}`).replace(
      PUBLISHER_COPY,
      `${PUBLISHER_COPY}${PUBLISHER_COPY.replaceAll("audit-anchor-publisher", "extra-worker")}`,
    );
    const { exitCode, stdout } = runGuard({ WORKER_BUNDLE_SMOKE_DOCKERFILE: fixtureFile("Dockerfile", text) });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("ERROR ESBUILD_NOT_A_MEMBER: dist/extra-worker.js");
    expect(stdout).toContain("ERROR COPY_NOT_A_MEMBER: dist/extra-worker.js");
  });

  it("FAILS on a dist/ COPY shape it does not model", () => {
    const text = DOCKERFILE.replace(PUBLISHER_COPY, "COPY --from=builder /app/dist ./dist\n");
    const { exitCode, stderr } = runGuard({ WORKER_BUNDLE_SMOKE_DOCKERFILE: fixtureFile("Dockerfile", text) });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("UnmodelledDockerfileError");
  });

  it("passes a fixture worker that prints its marker (control for the cases below)", () => {
    const { exitCode, stdout, stderr } = runGuard(oneWorker(NEEDS_DATABASE_URL, { env: { DATABASE_URL: "postgresql://a:b@127.0.0.1:5432/x" } }));
    expect(exitCode, stdout + stderr).toBe(0);
    expect(stdout).toContain("  fixture: ok");
  });

  it("FAILS on a bundle that exits 0 without its marker", () => {
    const { exitCode, stdout } = runGuard(oneWorker("process.exit(0);\n"));
    expect(exitCode).toBe(1);
    expect(stdout).toContain('ERROR MARKER_MISSING: fixture exited 0 without "env validation passed"');
  });

  it("FAILS on a bundle needing DATABASE_URL its task lacks, even with DATABASE_URL in the gate's own env", () => {
    const { exitCode, stdout } = runGuard({
      ...oneWorker(NEEDS_DATABASE_URL),
      DATABASE_URL: "postgresql://a:b@127.0.0.1:5432/x",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("ERROR BOOT_FAILED: fixture exited 1");
    expect(stdout).toContain("DATABASE_URL required");
  });

  it("FAILS when the bundle's metafile lists a forbidden input", () => {
    const forbidden = fixtureFile("forbidden.ts", "export const loaded = true;\n");
    const source = `import { loaded } from ${JSON.stringify(forbidden)};\nif (loaded) ${PRINTS_MARKER}`;
    const { exitCode, stdout } = runGuard(oneWorker(source, { forbiddenInputs: [forbidden] }));
    expect(exitCode).toBe(1);
    expect(stdout).toContain(`ERROR FORBIDDEN_INPUT: fixture bundles ${forbidden}`);
  });

  describe("RT7 red-proof: gate goes RED when a bundled module crashes on load", () => {
    it("FAILS with a non-zero exit when the retention worker's runtime-module crashes on load", () => {
      // Reproduces the pre-fix bug: createRequire(import.meta.url) throws
      // ERR_INVALID_ARG_VALUE at load time inside an esbuild CJS bundle, where
      // import.meta.url is undefined.
      const crashModule = fixtureFile(
        "crash-runtime-module.ts",
        [
          'import { createRequire } from "node:module";',
          "const requireModule = createRequire(import.meta.url);",
          "export function requireOptionalModule(moduleName) {",
          "  return requireModule(moduleName);",
          "}",
          "",
        ].join("\n"),
      );
      const { exitCode, stdout } = runGuard({
        WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE: `@/lib/blob-store/runtime-module=${crashModule}`,
      });
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("ERROR BOOT_FAILED: retention_gc_worker");
      expect(stdout).toContain("do not boot as shipped");
    });
  });
});

describe("check-worker-bundle-smoke.sh: docker runner", () => {
  /** A docker CLI stand-in: records its argv as one JSON line, prints `output`. */
  function stubDocker(output) {
    const log = fixtureFile("docker.log", "");
    const bin = fixtureFile(
      "docker",
      `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    );
    chmodSync(bin, 0o755);
    return { bin, calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  }
  const BOTH_MARKERS = '{"level":"info","msg":"destinations ready"}\n{"level":"info","msg":"env validation passed"}\n';

  it("runs each ECS command in the image with -e for exactly its task env and nothing from the host", () => {
    const docker = stubDocker(BOTH_MARKERS);
    const { exitCode, stdout, stderr } = runGuard({
      WORKER_BUNDLE_SMOKE_RUNNER: "docker:passwd-sso:scan",
      WORKER_BUNDLE_SMOKE_DOCKER_BIN: docker.bin,
      SMOKE_HOST_CANARY: "must-not-reach-the-container",
    });
    expect(exitCode, stdout + stderr).toBe(0);
    const calls = docker.calls();
    expect(calls).toHaveLength(4);
    expect(calls).toContainEqual([
      "run", "--rm", "--network", "none",
      "-e", "AUDIT_CHAIN_VERIFY_DATABASE_URL=postgresql://passwd_app:smoke@127.0.0.1:5432/passwd_sso",
      "passwd-sso:scan", "node", "dist/audit-chain-verify-worker.js", "--validate-env-only",
    ]);
    for (const task of Object.values(SMOKE_MAP.tasks)) {
      const call = calls.find((c) => c.includes(task.bundle));
      expect(call.slice(0, 4)).toEqual(["run", "--rm", "--network", "none"]);
      expect(call.slice(-4)).toEqual(["passwd-sso:scan", "node", task.bundle, "--validate-env-only"]);
      const envArgs = call.slice(4, -4);
      expect(envArgs.filter((_, i) => i % 2 === 0).every((a) => a === "-e")).toBe(true);
      const names = envArgs.filter((_, i) => i % 2 === 1).map((a) => a.slice(0, a.indexOf("=")));
      expect(names.sort()).toEqual(Object.keys(task.env).sort());
    }
    expect(JSON.stringify(calls)).not.toContain("must-not-reach-the-container");
  });

  it("FAILS in docker mode when a container exits 0 without the publisher's second marker", () => {
    const docker = stubDocker('{"level":"info","msg":"env validation passed"}\n');
    const { exitCode, stdout } = runGuard({
      WORKER_BUNDLE_SMOKE_RUNNER: "docker:passwd-sso:scan",
      WORKER_BUNDLE_SMOKE_DOCKER_BIN: docker.bin,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain('ERROR MARKER_MISSING: audit_anchor_publisher exited 0 without "destinations ready"');
    expect(stdout).toContain("  audit_chain_verify_worker: ok");
  });

  it("refuses a runner value it does not know", () => {
    const { exitCode, stderr } = runGuard({ WORKER_BUNDLE_SMOKE_RUNNER: "docker:" });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('WORKER_BUNDLE_SMOKE_RUNNER must be "host" or "docker:<image>"');
  });
});
