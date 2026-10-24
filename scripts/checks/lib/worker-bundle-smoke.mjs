/**
 * The worker-bundle smoke behind scripts/checks/check-worker-bundle-smoke.sh.
 *
 * Production runs each worker as an esbuild CJS bundle (`node dist/<x>.js`),
 * not via tsx. The source-level --validate-env-only tests run under tsx (ESM),
 * so a bundle that crashes at module load — `createRequire(import.meta.url)`
 * with import.meta.url undefined in CJS shipped a non-booting retention-gc
 * worker once (R32) — passes them. This check boots what ships.
 *
 * 1. Member set. The workers ECS runs (the tasks in worker-bundle-smoke.json,
 *    pinned to infra/terraform/ecs.tf by
 *    src/__tests__/infra/worker-bundle-smoke-map.test.ts) plus every
 *    worker-policy-manifest.json entrypoint (scripts/<x>.ts → dist/<x>.js).
 *    It must equal the set of Dockerfile esbuild invocations writing dist/
 *    and the set of dist/ files the runner stage COPYs; each difference is
 *    reported. A Dockerfile shape this parser does not model (an esbuild
 *    without --outfile=dist/<x>.js, a COPY of the dist/ directory) fails.
 * 2. Boot. Each member boots with --validate-env-only and ONLY the env its
 *    task definition gives it, and must exit 0 and print every marker its
 *    map entry names (JSON lines; matched on `msg`) — exit 0 alone is not
 *    proof, a bundle can exit 0 having validated nothing.
 *    - host runner (default): bundled with the exact Dockerfile esbuild
 *      arguments into a temp dir, then run with an explicit env (env -i
 *      semantics: the runner stage's ENV lines, the task env, and NODE_PATH
 *      standing in for the node_modules the image COPYs beside the bundle)
 *      from an empty temp cwd, so no .env and no parent variable can reach
 *      it. The esbuild metafile must not list any of the entry's
 *      forbiddenInputs (the publisher must not reach src/lib/prisma.ts).
 *    - docker runner (WORKER_BUNDLE_SMOKE_RUNNER=docker:<image>): the bundle
 *      already in the image, run as the ECS command under the image's own
 *      WORKDIR and ENV, with `-e` for each task variable and no network.
 *      The host's environment never reaches the container: `docker run`
 *      passes only what `-e` names.
 *
 * Env:
 *   WORKER_BUNDLE_SMOKE_DOCKERFILE   Dockerfile path (fixtures)
 *   WORKER_BUNDLE_SMOKE_MAP          worker-bundle-smoke.json path (fixtures)
 *   WORKER_BUNDLE_SMOKE_MANIFEST     worker-policy-manifest.json path (fixtures)
 *   WORKER_BUNDLE_SMOKE_RUNNER       "host" (default) or "docker:<image>"
 *   WORKER_BUNDLE_SMOKE_DOCKER_BIN   docker CLI (the self-test passes a stub)
 *   WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE  <module>=<path>, one extra esbuild
 *                                    --alias (host runner; red proofs only)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

// Measured on this repo (linux aarch64 dev host, node 26): a --validate-env-only
// boot takes 70–130 ms on the host and 180–330 ms through `docker run` against
// the built image; esbuild bundles each worker in under 0.2 s. The bounds
// leave two orders of magnitude for a loaded CI runner while still stopping a
// boot that hangs (one that opens a connection, say) long before the job's own
// timeout.
const HOST_BOOT_TIMEOUT_MS = 20_000;
const DOCKER_BOOT_TIMEOUT_MS = 60_000;
const ESBUILD_TIMEOUT_MS = 120_000;

export class UnmodelledDockerfileError extends Error {
  name = "UnmodelledDockerfileError";
}

/** Dockerfile instructions with backslash continuations joined; comments dropped. */
export function logicalLines(text) {
  const out = [];
  let current = "";
  for (const raw of text.split("\n")) {
    if (current === "" && /^\s*#/.test(raw)) continue;
    const continued = /\\\s*$/.test(raw);
    current += " " + raw.replace(/\\\s*$/, "");
    if (!continued) {
      const line = current.trim().replace(/\s+/g, " ");
      if (line !== "") out.push(line);
      current = "";
    }
  }
  if (current.trim() !== "") out.push(current.trim().replace(/\s+/g, " "));
  return out;
}

/** The instructions of the last stage — what the image ships. */
function finalStage(lines) {
  let start = 0;
  lines.forEach((l, i) => {
    if (/^FROM\s/i.test(l)) start = i;
  });
  return lines.slice(start);
}

const DIST_JS = /^dist\/[A-Za-z0-9_.-]+\.js$/;

/** Every `RUN npx esbuild …` invocation: its entry point, its dist/ outfile, its arguments. */
export function esbuildInvocations(lines) {
  const out = [];
  for (const line of lines) {
    if (!/\besbuild\b/.test(line)) continue;
    const tokens = line.split(" ");
    if (tokens[0] !== "RUN" || tokens[1] !== "npx" || tokens[2] !== "esbuild") {
      throw new UnmodelledDockerfileError(`esbuild invocation not of the form 'RUN npx esbuild …': ${line}`);
    }
    const args = tokens.slice(3);
    const outfiles = args.filter((a) => a.startsWith("--outfile="));
    const entries = args.filter((a) => !a.startsWith("-"));
    if (outfiles.length !== 1 || entries.length !== 1) {
      throw new UnmodelledDockerfileError(`esbuild invocation needs one entry point and one --outfile: ${line}`);
    }
    const outfile = outfiles[0].slice("--outfile=".length);
    if (!DIST_JS.test(outfile)) {
      throw new UnmodelledDockerfileError(`esbuild invocation does not write a dist/<name>.js file: ${line}`);
    }
    out.push({ entry: entries[0], outfile, args });
  }
  return out;
}

/** The dist/ files the final stage COPYs in, one file per COPY. */
export function distCopies(lines) {
  const out = [];
  for (const line of finalStage(lines)) {
    if (!/^(COPY|ADD)\s/i.test(line) || !/dist/.test(line)) continue;
    const operands = line.split(" ").slice(1).filter((t) => !t.startsWith("--"));
    const dest = operands.length === 2 ? operands[1].replace(/^(\.\/|\/app\/)/, "") : "";
    const src = operands.length === 2 ? operands[0].replace(/^\/app\//, "") : "";
    if (!/^COPY\s/.test(line) || !DIST_JS.test(dest) || src !== dest) {
      throw new UnmodelledDockerfileError(`dist/ COPY not of the form 'COPY … /app/dist/<x>.js ./dist/<x>.js': ${line}`);
    }
    out.push(dest);
  }
  return out;
}

/** The final stage's `ENV` values, which every container of the image starts with. */
export function imageEnv(lines) {
  const env = {};
  for (const line of finalStage(lines)) {
    if (!/^ENV\s/.test(line)) continue;
    const body = line.slice(4);
    const pairs = body.match(/[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|\S*)/g);
    if (!pairs || pairs.join(" ") !== body) throw new UnmodelledDockerfileError(`ENV not of the form K=V: ${line}`);
    for (const p of pairs) {
      const eq = p.indexOf("=");
      env[p.slice(0, eq)] = p.slice(eq + 1).replace(/^"(.*)"$/, "$1");
    }
  }
  return env;
}

export function bundleOfEntrypoint(entrypoint) {
  return `dist/${basename(entrypoint).replace(/\.ts$/, "")}.js`;
}

/** Every way the member, esbuild and COPY sets disagree; empty when they are equal. */
export function setProblems({ tasks, manifestEntrypoints, invocations, copies }) {
  const problems = [];
  const taskBundles = new Map(Object.entries(tasks).map(([name, t]) => [t.bundle, name]));
  const manifestBundles = new Map(manifestEntrypoints.map((e) => [bundleOfEntrypoint(e), e]));
  const members = new Set([...taskBundles.keys(), ...manifestBundles.keys()]);
  const built = new Map(invocations.map((i) => [i.outfile, i]));
  const copied = new Set(copies);

  for (const m of [...members].sort()) {
    if (!built.has(m)) problems.push(`MEMBER_WITHOUT_ESBUILD: ${m}`);
    if (!copied.has(m)) problems.push(`MEMBER_WITHOUT_COPY: ${m}`);
    if (!taskBundles.has(m)) problems.push(`MEMBER_WITHOUT_TASK_ENV: ${m} (no worker-bundle-smoke.json task runs it)`);
    const entry = manifestBundles.get(m);
    if (entry !== undefined && built.has(m) && built.get(m).entry !== entry) {
      problems.push(`ENTRY_MISMATCH: ${m} is built from ${built.get(m).entry}, the manifest names ${entry}`);
    }
  }
  for (const b of [...built.keys()].sort()) if (!members.has(b)) problems.push(`ESBUILD_NOT_A_MEMBER: ${b}`);
  for (const c of [...copied].sort()) if (!members.has(c)) problems.push(`COPY_NOT_A_MEMBER: ${c}`);
  for (const b of invocations.map((i) => i.outfile)) {
    if (invocations.filter((i) => i.outfile === b).length > 1) problems.push(`ESBUILD_DUPLICATE: ${b}`);
  }
  for (const c of copies) if (copies.filter((x) => x === c).length > 1) problems.push(`COPY_DUPLICATE: ${c}`);
  return [...new Set(problems)];
}

/** `docker run` arguments for one task: the ECS command, the task env, nothing from the host. */
export function dockerRunArgs(image, task) {
  const envArgs = Object.entries(task.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["run", "--rm", "--network", "none", ...envArgs, image, "node", task.bundle, "--validate-env-only"];
}

/** The markers `output` lacks, matched on the `msg` of its JSON lines. */
export function missingMarkers(output, markers) {
  const seen = new Set();
  for (const line of output.split("\n")) {
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed && typeof parsed.msg === "string") seen.add(parsed.msg);
    } catch {
      // not a JSON line (dotenv banner, printf log)
    }
  }
  return markers.filter((m) => !seen.has(m));
}

function parseRunner(value) {
  if (value === undefined || value === "" || value === "host") return { kind: "host" };
  if (value.startsWith("docker:") && value.length > "docker:".length) return { kind: "docker", image: value.slice(7) };
  throw new Error(`WORKER_BUNDLE_SMOKE_RUNNER must be "host" or "docker:<image>", got ${JSON.stringify(value)}`);
}

function indent(text) {
  return text.trimEnd().split("\n").map((l) => `    ${l}`).join("\n");
}

function checkBoot(name, result, markers, elapsedMs) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) return [`BOOT_FAILED: ${name}: ${result.error.message}\n${indent(output)}`];
  if (result.status !== 0) {
    return [`BOOT_FAILED: ${name} exited ${result.status ?? `on ${result.signal}`}\n${indent(output)}`];
  }
  const missing = missingMarkers(result.stdout ?? "", markers);
  if (missing.length > 0) {
    return [`MARKER_MISSING: ${name} exited 0 without ${missing.map((m) => JSON.stringify(m)).join(", ")}\n${indent(output)}`];
  }
  console.log(`  ${name}: ok (${elapsedMs} ms)`);
  return [];
}

function forbiddenInputProblems(repoRoot, name, metafile, forbidden) {
  const inputs = Object.keys(JSON.parse(readFileSync(metafile, "utf8")).inputs).map((i) => resolve(repoRoot, i));
  return forbidden
    .filter((f) => inputs.includes(resolve(repoRoot, f)))
    .map((f) => `FORBIDDEN_INPUT: ${name} bundles ${f}`);
}

function bootOnHost({ repoRoot, lines, invocations, tasks, tmp }) {
  const problems = [];
  const baseEnv = imageEnv(lines);
  const emptyCwd = join(tmp, "cwd");
  mkdirSync(emptyCwd);
  const extraAlias = process.env.WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE
    ? [`--alias:${process.env.WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE}`]
    : [];
  for (const [name, task] of Object.entries(tasks)) {
    const inv = invocations.find((i) => i.outfile === task.bundle);
    const bundle = join(tmp, basename(task.bundle));
    const metafile = `${bundle}.meta.json`;
    const args = inv.args.map((a) => (a.startsWith("--outfile=") ? `--outfile=${bundle}` : a));
    const built = spawnSync(
      join(repoRoot, "node_modules/.bin/esbuild"),
      [...args, ...extraAlias, `--metafile=${metafile}`, "--log-level=warning"],
      { cwd: repoRoot, encoding: "utf8", timeout: ESBUILD_TIMEOUT_MS },
    );
    if (built.status !== 0) {
      problems.push(`BUNDLE_FAILED: ${name}\n${indent(`${built.stdout ?? ""}${built.stderr ?? ""}${built.error?.message ?? ""}`)}`);
      continue;
    }
    problems.push(...forbiddenInputProblems(repoRoot, name, metafile, task.forbiddenInputs ?? []));

    const started = Date.now();
    const result = spawnSync(process.execPath, [bundle, "--validate-env-only"], {
      cwd: emptyCwd,
      env: { ...baseEnv, ...task.env, NODE_PATH: join(repoRoot, "node_modules") },
      encoding: "utf8",
      timeout: HOST_BOOT_TIMEOUT_MS,
    });
    problems.push(...checkBoot(name, result, task.markers, Date.now() - started));
  }
  return problems;
}

function bootInDocker({ image, tasks }) {
  const problems = [];
  const docker = process.env.WORKER_BUNDLE_SMOKE_DOCKER_BIN || "docker";
  for (const [name, task] of Object.entries(tasks)) {
    const started = Date.now();
    const result = spawnSync(docker, dockerRunArgs(image, task), { encoding: "utf8", timeout: DOCKER_BOOT_TIMEOUT_MS });
    problems.push(...checkBoot(name, result, task.markers, Date.now() - started));
  }
  return problems;
}

export function main(repoRoot) {
  const dockerfile = resolve(repoRoot, process.env.WORKER_BUNDLE_SMOKE_DOCKERFILE || "Dockerfile");
  const mapPath = resolve(repoRoot, process.env.WORKER_BUNDLE_SMOKE_MAP || "scripts/checks/worker-bundle-smoke.json");
  const manifestPath = resolve(repoRoot, process.env.WORKER_BUNDLE_SMOKE_MANIFEST || "scripts/checks/worker-policy-manifest.json");
  const runner = parseRunner(process.env.WORKER_BUNDLE_SMOKE_RUNNER);
  console.log(`check-worker-bundle-smoke: ${dockerfile} (runner: ${runner.kind === "host" ? "host" : `docker ${runner.image}`})`);

  const lines = logicalLines(readFileSync(dockerfile, "utf8"));
  const { tasks } = JSON.parse(readFileSync(mapPath, "utf8"));
  const manifestEntrypoints = Object.values(JSON.parse(readFileSync(manifestPath, "utf8")).workers).map((w) => w.entrypoint);
  const invocations = esbuildInvocations(lines);
  const copies = distCopies(lines);

  const problems = setProblems({ tasks, manifestEntrypoints, invocations, copies });
  if (problems.length > 0) {
    for (const p of problems) console.log(`ERROR ${p}`);
    console.log("FAIL: the worker member set, the Dockerfile esbuild set and the COPY set differ.");
    return 1;
  }
  console.log(`  ${Object.keys(tasks).length} workers; member, esbuild and COPY sets equal`);

  let bootProblems;
  if (runner.kind === "host") {
    const tmp = mkdtempSync(join(tmpdir(), "worker-bundle-smoke-"));
    try {
      bootProblems = bootOnHost({ repoRoot, lines, invocations, tasks, tmp });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    bootProblems = bootInDocker({ image: runner.image, tasks });
  }
  if (bootProblems.length > 0) {
    for (const p of bootProblems) console.log(`ERROR ${p}`);
    console.log("FAIL: one or more worker bundles do not boot as shipped (R32).");
    return 1;
  }
  console.log("OK (every worker bundle boots with --validate-env-only and its task env, and prints its markers)");
  return 0;
}
