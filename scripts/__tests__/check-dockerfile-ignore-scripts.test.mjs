/**
 * Self-test for scripts/checks/check-dockerfile-ignore-scripts.sh — the NFR5
 * guard requiring every `RUN npm ci` in the Dockerfile to carry
 * `--ignore-scripts`.
 *
 * This guard exists because its predecessor did not work. The pattern the plan
 * originally specified embedded the filename in the regex body
 * (`npm ci(?!.*--ignore-scripts).*\n.*Dockerfile`), so it matched nothing —
 * not even a Dockerfile with the flag stripped, which two reviewers proved
 * independently by mutation. Hence the cases below assert the guard REDS on
 * that exact input, not merely that it passes on a healthy one.
 *
 * The guard takes its subject as argv[1], so the fixture is a file path; there
 * is no env override to get wrong and no way for a fixture run to read the
 * real Dockerfile by accident.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-dockerfile-ignore-scripts.sh");

let root;

function runGuard(fixtureName) {
  const r = spawnSync("bash", [GUARD, join(root, fixtureName)], {
    encoding: "utf8",
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function write(name, body) {
  writeFileSync(join(root, name), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ignore-scripts-guard-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-dockerfile-ignore-scripts", () => {
  it("passes when every npm install carries --ignore-scripts", () => {
    write(
      "Dockerfile",
      ["FROM node:24-alpine AS deps", "RUN npm ci --ignore-scripts", ""].join("\n"),
    );

    const { exitCode, stdout } = runGuard("Dockerfile");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("all carry --ignore-scripts");
  });

  // The case the dead predecessor could not see.
  it("fails when --ignore-scripts is stripped", () => {
    write("Dockerfile", ["FROM node:24-alpine AS deps", "RUN npm ci", ""].join("\n"));

    const { exitCode, stderr } = runGuard("Dockerfile");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("NFR5 violation");
    expect(stderr).toContain("RUN npm ci");
  });

  // Phase 3 found the first version matched only `RUN npm ci`, while the real
  // Dockerfile already contained two `npm install`s on continuation lines
  // inside compound RUNs — present, unguarded, and invisible to the gate.
  it.each([
    ["npm install", "RUN npm install evil-pkg"],
    ["npm i", "RUN npm i evil-pkg"],
    ["npm add", "RUN npm add evil-pkg"],
  ])("fails on the %s spelling", (_label, line) => {
    write("Dockerfile", ["FROM node:24-alpine", "RUN npm ci --ignore-scripts", line, ""].join("\n"));

    expect(runGuard("Dockerfile").exitCode).toBe(1);
  });

  it("sees an install on a backslash-continued line inside a compound RUN", () => {
    write(
      "Dockerfile",
      [
        "FROM node:24-alpine",
        "RUN set -e && \\",
        "    npm install evil-pkg && \\",
        "    echo done",
        "",
      ].join("\n"),
    );

    expect(runGuard("Dockerfile").exitCode).toBe(1);
  });

  // Per `&&` segment, not per instruction: one guarded install must not vouch
  // for an unguarded one beside it.
  it("fails when one segment of a compound RUN drops the flag", () => {
    write(
      "Dockerfile",
      ["FROM node:24-alpine", "RUN npm ci --ignore-scripts && npm install other", ""].join("\n"),
    );

    expect(runGuard("Dockerfile").exitCode).toBe(1);
  });

  // `npm init` creates a manifest and runs nothing from the registry; the
  // prisma-cli stage uses it, so treating it as an install would red the real
  // Dockerfile.
  it("does not treat npm init as an install", () => {
    write(
      "Dockerfile",
      [
        "FROM node:24-alpine",
        "RUN npm init -y && \\",
        "    npm install prisma --ignore-scripts",
        "",
      ].join("\n"),
    );

    expect(runGuard("Dockerfile").exitCode).toBe(0);
  });

  it("fails when only one of several install lines drops the flag", () => {
    write(
      "Dockerfile",
      [
        "FROM node:24-alpine AS deps",
        "RUN npm ci --ignore-scripts",
        "FROM node:24-alpine AS other",
        "RUN npm ci",
        "",
      ].join("\n"),
    );

    expect(runGuard("Dockerfile").exitCode).toBe(1);
  });

  // The guard is RUN-anchored: the real Dockerfile's own comment mentions
  // `npm ci`, and matching it would make the guard unlandable.
  it("ignores npm ci mentioned in a comment", () => {
    write(
      "Dockerfile",
      [
        "FROM node:24-alpine AS deps",
        "# without this file, `npm ci` inside the build fails with ERESOLVE",
        "RUN npm ci --ignore-scripts",
        "",
      ].join("\n"),
    );

    expect(runGuard("Dockerfile").exitCode).toBe(0);
  });

  // "Examined nothing" must not be spelled the same as "found nothing":
  // both refusals exit 2, distinct from the exit-1 verdict.
  it("refuses, rather than passing, when the Dockerfile is absent", () => {
    const { exitCode, stderr } = runGuard("Dockerfile.absent");

    expect(exitCode).toBe(2);
    expect(stderr).toContain("DOCKERFILE_SUBJECT_MISSING");
  });

  it("refuses when the Dockerfile contains no npm install at all", () => {
    write(
      "Dockerfile",
      ["FROM scratch", "# RUN npm ci appears only in this comment", ""].join("\n"),
    );

    const { exitCode, stderr } = runGuard("Dockerfile");

    expect(exitCode).toBe(2);
    expect(stderr).toContain("DOCKERFILE_NO_NPM_INSTALL");
  });

  // The guard must hold on the artifact that actually ships, not only on
  // fixtures — otherwise it could be written to pass on synthetic input and
  // never be run against the real subject.
  it("passes against the repository's own Dockerfile", () => {
    const r = spawnSync("bash", [GUARD, join(REPO_ROOT, "Dockerfile")], {
      encoding: "utf8",
    });

    expect(r.status, r.stderr).toBe(0);
  });
});
