/**
 * Tests for scripts/deploy.sh — the compensating-rollback path.
 *
 * `aws`, `terraform`, `git`, `docker` and `jq` are stubbed on PATH so the script
 * runs end-to-end with no AWS account. Each stub appends its argv to a log file,
 * which the assertions read back.
 *
 * Coverage:
 *   T1 — a mid-loop `update-service` failure (the 2nd of 4) still triggers the
 *        compensating rollback for EVERY service, including the ones that were
 *        never updated. Regression test: the rollback used to be defined after
 *        the update loop, so `set -e` exited before it could run.
 *   T2 — a circuit-breaker rollback (service settles COMPLETED but on the OLD
 *        task def) is detected as a failure, not reported as success.
 *   T3 — the happy path issues no rollback and exits 0.
 *   T4 — a rollback that itself fails to restore the revision exits non-zero and
 *        says manual intervention is required.
 *   T5 — --rollback-to pointing at a foreign registry is rejected before any
 *        AWS/terraform call.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "deploy.sh");

const ECR_URL = "111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/passwd-sso-prod-app";
const SERVICE_NAMES = {
  ecs_app_service_name: "passwd-sso-prod-app",
  ecs_jackson_service_name: "passwd-sso-prod-jackson",
  ecs_audit_outbox_worker_service_name: "passwd-sso-prod-audit-outbox-worker",
  ecs_retention_gc_worker_service_name: "passwd-sso-prod-retention-gc-worker",
};
const NEW_TD = {
  app_task_definition_arn: "arn:aws:ecs:td/app:2",
  jackson_task_definition_arn: "arn:aws:ecs:td/jackson:2",
  audit_outbox_worker_task_definition_arn: "arn:aws:ecs:td/outbox:2",
  retention_gc_worker_task_definition_arn: "arn:aws:ecs:td/gc:2",
  migrate_task_definition_arn: "arn:aws:ecs:td/migrate:2",
};
/** Pre-deploy revisions the stub reports before any update-service. */
const OLD_TD_FOR_SERVICE = {
  [SERVICE_NAMES.ecs_app_service_name]: "arn:aws:ecs:td/app:1",
  [SERVICE_NAMES.ecs_jackson_service_name]: "arn:aws:ecs:td/jackson:1",
  [SERVICE_NAMES.ecs_audit_outbox_worker_service_name]: "arn:aws:ecs:td/outbox:1",
  [SERVICE_NAMES.ecs_retention_gc_worker_service_name]: "arn:aws:ecs:td/gc:1",
};
const NEW_TD_FOR_SERVICE = {
  [SERVICE_NAMES.ecs_app_service_name]: NEW_TD.app_task_definition_arn,
  [SERVICE_NAMES.ecs_jackson_service_name]: NEW_TD.jackson_task_definition_arn,
  [SERVICE_NAMES.ecs_audit_outbox_worker_service_name]:
    NEW_TD.audit_outbox_worker_task_definition_arn,
  [SERVICE_NAMES.ecs_retention_gc_worker_service_name]:
    NEW_TD.retention_gc_worker_task_definition_arn,
};

let tmpDir;
let binDir;
let logFile;

/**
 * Write an executable stub onto the fake PATH.
 * Stubs are bash so they can inspect argv the way the real CLIs are called.
 */
function stub(name, body) {
  const p = resolve(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  chmodSync(p, 0o755);
}

/** Every stub invocation is appended here as one line: "<cmd> <args...>". */
function readLog() {
  return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
}

/** Lines from the log matching a predicate. */
function logLines(filter) {
  return readLog()
    .split("\n")
    .filter((l) => l.length > 0 && (filter ? l.includes(filter) : true));
}

/**
 * Install the default happy-path stubs.
 * @param {object} opts
 * @param {number} [opts.failUpdateAtCall] 1-based index of the update-service
 *   call that should exit non-zero (counting BOTH forward and rollback calls
 *   is avoided — only forward updates are counted, see the stub body).
 * @param {Record<string,string>} [opts.primaryTdOverride] service -> task def
 *   reported as the PRIMARY deployment's taskDefinition after stabilizing.
 * @param {boolean} [opts.rollbackNeverLands] when true, describe-services keeps
 *   reporting the NEW revision even after a rollback update-service.
 */
function installStubs(opts = {}) {
  const {
    failUpdateAtCall = 0,
    primaryTdOverride = null,
    rollbackNeverLands = false,
  } = opts;

  const tfOutputs = { ...SERVICE_NAMES, ...NEW_TD, ecs_cluster_name: "passwd-sso-prod-cluster" };
  const tfOutputCases = Object.entries(tfOutputs)
    .map(([k, v]) => `    ${k}) echo "${v}";;`)
    .join("\n");

  stub(
    "terraform",
    `echo "terraform $*" >> "${logFile}"
# -chdir=... apply|output ...
for a in "$@"; do
  case "$a" in
    output) MODE=output;;
    apply) MODE=apply;;
  esac
done
if [ "\${MODE:-}" = output ]; then
  # last arg is the output name (for -raw) or -json <name>
  NAME="\${@: -1}"
  case "$NAME" in
    private_subnet_ids) echo '["subnet-a","subnet-b"]';;
    ecs_security_group_id) echo "sg-123";;
${tfOutputCases}
    *) echo "";;
  esac
fi
exit 0`,
  );

  // describe-services returns the pre-deploy revision until that service has
  // been updated; the marker files track which services were updated.
  const primaryCase = primaryTdOverride
    ? Object.entries(primaryTdOverride)
        .map(([svc, td]) => `      ${svc}) PRIMARY_TD="${td}";;`)
        .join("\n")
    : "";

  const oldTdCases = Object.entries(OLD_TD_FOR_SERVICE)
    .map(([svc, td]) => `    ${svc}) echo "${td}";;`)
    .join("\n");
  const newTdCases = Object.entries(NEW_TD_FOR_SERVICE)
    .map(([svc, td]) => `    ${svc}) echo "${td}";;`)
    .join("\n");

  stub(
    "aws",
    `echo "aws $*" >> "${logFile}"
SUB="$2"
case "$1 $2" in
  "ecr describe-images")
    # The forward path only checks the exit status; the rollback path reads the
    # resolved digest via --query imageDetails[0].imageDigest.
    for a in "$@"; do
      case "$a" in
        *imageDigest*) echo "sha256:$(printf '%064d' 1)"; exit 0;;
      esac
    done
    exit 0;;
  "ecs run-task")
    echo '{"tasks":[{"taskArn":"arn:aws:ecs:task/migrate-1"}],"failures":[]}'
    exit 0;;
  "ecs wait")
    exit 0;;
  "ecs describe-tasks")
    echo 0
    exit 0;;
  "ecs update-service")
    # Extract --service <name> and --task-definition <arn>
    SVC=""; TD=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --service) SVC="$2";;
        --task-definition) TD="$2";;
      esac
      shift
    done
    # Is this a forward update (moving to the NEW td) or a rollback (OLD td)?
    IS_FORWARD=no
    case "$TD" in
      *:2) IS_FORWARD=yes;;
    esac
    if [ "$IS_FORWARD" = yes ]; then
      N=$(cat "${tmpDir}/fwd_count" 2>/dev/null || echo 0)
      N=$((N + 1))
      echo "$N" > "${tmpDir}/fwd_count"
      if [ "${failUpdateAtCall}" -ne 0 ] && [ "$N" -eq "${failUpdateAtCall}" ]; then
        echo "AccessDeniedException (stubbed failure on forward update #$N)" >&2
        exit 254
      fi
      touch "${tmpDir}/updated_\${SVC}"
    else
      rm -f "${tmpDir}/updated_\${SVC}"
      ${rollbackNeverLands ? 'touch "' + tmpDir + '/updated_${SVC}"' : "true"}
    fi
    echo "$SVC"
    exit 0;;
  "ecs describe-services")
    SVC=""; QUERY=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --services) SVC="$2";;
        --query) QUERY="$2";;
      esac
      shift
    done
    if [ -f "${tmpDir}/updated_\${SVC}" ]; then
      CURRENT_TD=$(case "$SVC" in
${newTdCases}
      esac)
    else
      CURRENT_TD=$(case "$SVC" in
${oldTdCases}
      esac)
    fi
    case "$QUERY" in
      *deployments*)
        PRIMARY_TD="$CURRENT_TD"
        case "$SVC" in
${primaryCase}
        esac
        printf 'COMPLETED\\t%s\\n' "$PRIMARY_TD"
        ;;
      *)
        echo "$CURRENT_TD";;
    esac
    exit 0;;
esac
exit 0`,
  );

  stub("docker", `echo "docker $*" >> "${logFile}"\nexit 0`);
  stub("jq", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(binDir, "jq.mjs"))} "$@"`);
  // Minimal jq: only the two filters deploy.sh uses.
  writeFileSync(
    resolve(binDir, "jq.mjs"),
    `import { readFileSync } from "node:fs";
const args = process.argv.slice(2).filter((a) => a !== "-r");
const filter = args[0] ?? ".";
const input = readFileSync(0, "utf8").trim();
const data = input ? JSON.parse(input) : null;
if (filter === "join(\\",\\")") { console.log((data ?? []).join(",")); }
else if (filter.includes("failures[0].reason")) { console.log(data?.failures?.[0]?.reason ?? ""); }
else if (filter.includes("tasks[0].taskArn")) { console.log(data?.tasks?.[0]?.taskArn ?? ""); }
else { console.log(""); }
`,
    "utf8",
  );

  // Clean worktree + a stable HEAD sha.
  stub(
    "git",
    `echo "git $*" >> "${logFile}"
case "$1 $2" in
  "status --porcelain") exit 0;;   # clean worktree: no output
  "rev-parse HEAD") echo "abc123def456"; exit 0;;
esac
exit 0`,
  );
}

function runDeploy(args = []) {
  return spawnSync("bash", [SCRIPT, ...args], {
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: tmpDir,
      AWS_REGION: "ap-northeast-1",
      ECR_URL,
      TF_VAR_FILE: "envs/prod/terraform.tfvars",
      TF_DIR: "infra/terraform",
    },
    encoding: "utf8",
    timeout: 30_000,
    cwd: REPO_ROOT,
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), "deploy-test-"));
  binDir = resolve(tmpDir, "bin");
  spawnSync("mkdir", ["-p", binDir]);
  logFile = resolve(tmpDir, "calls.log");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("deploy.sh compensating rollback", () => {
  it("rolls every service back when the 2nd update-service fails mid-loop", () => {
    installStubs({ failUpdateAtCall: 2 });

    const result = runDeploy();

    expect(result.status).not.toBe(0);

    // The compensation must have run despite `set -e` aborting the update loop.
    expect(result.stderr).toContain("Compensating rollback");

    // EVERY service must be restored to its pre-deploy revision — including the
    // ones the forward loop never reached (services 3 and 4).
    const rollbackCalls = logLines("ecs update-service").filter((l) => l.includes(":1"));
    for (const [svc, oldTd] of Object.entries(OLD_TD_FOR_SERVICE)) {
      expect(
        rollbackCalls.some((l) => l.includes(`--service ${svc}`) && l.includes(oldTd)),
        `expected a rollback update-service for ${svc} → ${oldTd}`,
      ).toBe(true);
    }
  });

  it("treats a circuit-breaker rollback (COMPLETED on the OLD task def) as failure", () => {
    // App stabilizes COMPLETED but back on its OLD revision — the exact shape of
    // an ECS deployment-circuit-breaker rollback.
    installStubs({
      primaryTdOverride: {
        [SERVICE_NAMES.ecs_app_service_name]:
          OLD_TD_FOR_SERVICE[SERVICE_NAMES.ecs_app_service_name],
      },
    });

    const result = runDeploy();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("circuit-breaker rolled it back");
    expect(result.stderr).toContain("Compensating rollback");
  });

  it("exits 0 and issues no rollback on the happy path", () => {
    installStubs();

    const result = runDeploy();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All services stable on the new revision");
    expect(result.stderr).not.toContain("Compensating rollback");
    // No update-service call may target an old (:1) revision.
    expect(logLines("ecs update-service").filter((l) => l.includes(":1"))).toHaveLength(0);
  });

  it("reports MANUAL INTERVENTION when the compensating rollback does not land", () => {
    installStubs({ failUpdateAtCall: 2, rollbackNeverLands: true });

    const result = runDeploy();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("COMPENSATING ROLLBACK INCOMPLETE");
    expect(result.stderr).toContain("MANUAL INTERVENTION REQUIRED");
  });
});

describe("deploy.sh --rollback-to validation", () => {
  it("rejects a rollback image from a foreign registry before calling AWS", () => {
    installStubs();

    const result = runDeploy(["--rollback-to", "evil.example/image:git-abc123def456"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be ${ECR_URL}:<tag> or ${ECR_URL}@sha256:<digest>");
    // Nothing may have been deployed or even queried.
    expect(logLines("ecs update-service")).toHaveLength(0);
    expect(logLines("terraform").filter((l) => l.includes("apply"))).toHaveLength(0);
  });

  it("accepts a rollback image in the configured ECR repo and skips the migration", () => {
    installStubs();

    const result = runDeploy(["--rollback-to", `${ECR_URL}:git-oldsha`]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipping migration (rollback path)");
    expect(logLines("ecs run-task")).toHaveLength(0);
  });
});
