#!/usr/bin/env node
/**
 * CI guard: the required-status aggregate jobs stay sound.
 *
 * `ci.yml` and `ci-integration.yml` each end in one aggregate job (`CI result`,
 * `Integration result`). Those two names are what main's ruleset is to require, so a
 * weakening of the aggregate, or of the gating in front of it, turns a red job
 * into a green merge. This gate parses both workflows with js-yaml (the
 * structure GitHub reads) and checks:
 *
 *  - the trigger starts on every pull request into main (no paths /
 *    paths-ignore / types; `branches` exactly [main]);
 *  - the aggregate's shape, name, step and `needs` (every other job, no more);
 *  - no `continue-on-error`, and every job-level `if` is one of a closed set of
 *    fail-closed forms (an unknown form is a violation, not a pass);
 *  - the `changes` job's large-PR guard, filter `if` and `with` keys, and
 *    `|| 'true'` outputs;
 *  - the guard, filter (action and `with` keys) and aggregate steps are
 *    identical across the two workflows;
 *  - each required name belongs to exactly one job across every workflow.
 *
 * Threat model: the aggregates, this gate and pre-pr.sh all run from the PR's
 * own head, so a PR that edits any of them can make them green. This gate
 * targets ACCIDENTAL weakening; for a hostile edit the control is the
 * maintainer reading the diff. What the guard and aggregate `run` text actually
 * does is pinned by executing it in the self-test, not by comparing text here.
 *
 * The detection logic is exported as pure functions so it can be unit-tested
 * with synthetic inputs (RT7 — the guard must be provably able to fail).
 * Design: docs/archive/review/required-status-aggregate-plan.md (C3).
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";

const WORKFLOWS_DIR = ".github/workflows";

export const SPECS = {
  "ci.yml": {
    aggregateId: "ci-result",
    aggregateName: "CI result",
    everyJobGated: false,
  },
  "ci-integration.yml": {
    aggregateId: "integration-result",
    aggregateName: "Integration result",
    everyJobGated: true,
  },
};

// The only jobs allowed a dependency-conditioned `if`, with the exact needs it
// may reference. A new pair is added here deliberately.
const AFTER_ALLOWED = { "app-coverage": ["app-test"] };
const FC_AFTER_ALLOWED = {
  e2e: ["app-ci", "app-test", "app-coverage", "app-build"],
};

const STEP_IF_ALLOWED = new Set(["failure()", "always()", "!cancelled()"]);
const AGGREGATE_ENV = { NEEDS: "${{ toJSON(needs) }}" };
// Gated jobs use `!cancelled()`, not `always()`: GitHub keeps a running job
// whose `if` is still true when its run is cancelled, so `always()` would let a
// superseded run's jobs defeat `cancel-in-progress`. Only the aggregate keeps
// `always()` (rule 3), so a cancelled run still reports red.
const GATED_PREFIX = "!cancelled() && ";
const FC_BODY_RE =
  /^needs\.changes\.result != 'success'((?: \|\| needs\.changes\.outputs\.[A-Za-z0-9_-]+ == 'true')+)$/;

/** @param {unknown} s */
function norm(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/** @param {unknown} v */
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A step's `env` with whitespace-normalised values, or null when absent.
 * @param {unknown} env
 */
function normEnv(env) {
  return isPlainObject(env)
    ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, norm(v)]))
    : null;
}

/** @param {unknown} needs */
function needsList(needs) {
  if (needs === undefined || needs === null) return [];
  return Array.isArray(needs) ? needs.map(String) : [String(needs)];
}

/**
 * Parses the body of an FC `if` (the part inside the parentheses).
 * @param {string} body
 * @returns {string[] | null} the filter keys, or null when it is not FC
 */
function parseFcBody(body) {
  const m = FC_BODY_RE.exec(body);
  if (!m) return null;
  return [...m[1].matchAll(/needs\.changes\.outputs\.([A-Za-z0-9_-]+) == 'true'/g)].map(
    (x) => x[1],
  );
}

/**
 * Classifies a job-level `if` against the closed grammar.
 * @param {string} jobId
 * @param {string} expr
 * @returns {{ kind: string, filters: string[], deps: string[] } | null}
 */
function classifyIf(jobId, expr) {
  const s = norm(expr);
  if (!s.startsWith(GATED_PREFIX)) return null;
  const rest = s.slice(GATED_PREFIX.length);
  const fc = /^\((.*)\)$/.exec(rest);
  if (fc) {
    const filters = parseFcBody(fc[1]);
    if (filters) return { kind: "FC", filters, deps: ["changes"] };
  }
  const afterDeps = AFTER_ALLOWED[jobId];
  if (afterDeps) {
    const want = `${afterDeps.map((d) => `needs.${d}.result == 'success'`).join(" && ")}`;
    if (rest === want) return { kind: "AFTER", filters: [], deps: afterDeps };
  }
  const fcAfterDeps = FC_AFTER_ALLOWED[jobId];
  if (fcAfterDeps) {
    const tail = fcAfterDeps.map((d) => ` && needs.${d}.result != 'failure'`).join("");
    const m = /^\((.*)\)(.*)$/.exec(rest);
    if (m && m[2] === tail) {
      const filters = parseFcBody(m[1]);
      if (filters) return { kind: "FC-AFTER", filters, deps: ["changes", ...fcAfterDeps] };
    }
  }
  return null;
}

/**
 * @param {string} content
 * @param {string} name
 * @returns {{ doc: any } | { error: string }}
 */
function parseWorkflow(content, name) {
  try {
    const doc = load(content);
    if (!isPlainObject(doc)) return { error: `${name}: workflow is not a YAML mapping` };
    return { doc };
  } catch (err) {
    return { error: `${name}: YAML parse error: ${String(err?.message ?? err).split("\n")[0]}` };
  }
}

/**
 * @param {any} doc
 * @param {string} jobId
 * @returns {any[]}
 */
function stepsOf(doc, jobId) {
  const steps = doc.jobs?.[jobId]?.steps;
  return Array.isArray(steps) ? steps : [];
}

/**
 * @param {any} doc
 * @param {string} id
 * @returns {any} the `changes` job's step with this id, or undefined
 */
function changesStep(doc, id) {
  return stepsOf(doc, "changes").find((s) => isPlainObject(s) && s.id === id);
}

/** @param {any} step */
function withKeysOf(step) {
  return isPlainObject(step.with) ? Object.keys(step.with) : [];
}

/**
 * Returns violation strings for one workflow against its spec (C3 rules 1-11).
 * @param {string} content
 * @param {string} name
 * @param {{ aggregateId: string, aggregateName: string, everyJobGated: boolean }} spec
 * @returns {string[]}
 */
export function findWorkflowViolations(content, name, spec) {
  const parsed = parseWorkflow(content, name);
  if ("error" in parsed) return [parsed.error];
  const doc = parsed.doc;
  const out = [];
  const jobs = isPlainObject(doc.jobs) ? doc.jobs : {};

  // Rule 1: trigger.
  // `branches: [main]` is required: a required check is matched by name on the
  // head SHA, so a run of the same commit in a PR into another branch must not
  // answer for a PR into main. The string and list forms of `on` cannot carry
  // it, so `on` must be a mapping.
  const on = doc.on;
  if (!isPlainObject(on)) {
    out.push(`${name}: R1 'on' must be a mapping with 'pull_request.branches: [main]'`);
  } else if (!("pull_request" in on)) {
    out.push(`${name}: R1 'on.pull_request' is missing — the workflow must start on every pull request into main`);
  } else {
    const pr = on.pull_request;
    if (!isPlainObject(pr)) {
      out.push(`${name}: R1 'on.pull_request' must be a mapping with 'branches: [main]'`);
    } else {
      if (!isDeepStrictEqual(pr.branches, ["main"])) {
        out.push(`${name}: R1 'on.pull_request.branches' must be exactly [main]`);
      }
      for (const key of ["paths", "paths-ignore", "types", "branches-ignore"]) {
        if (key in pr) {
          out.push(`${name}: R1 'on.pull_request.${key}' is forbidden — a PR outside it would never start the workflow`);
        }
      }
    }
  }
  if (isPlainObject(on) && "pull_request_target" in on) {
    out.push(`${name}: R1 'on.pull_request_target' is forbidden — it runs PR code with a write token`);
  }

  // Rule 3 (workflow level) and rule 8 (top-level permissions).
  if (doc.env !== undefined) out.push(`${name}: R3 top-level 'env' is forbidden`);
  if (doc.defaults?.run?.shell !== undefined) {
    out.push(`${name}: R3 'defaults.run.shell' is forbidden`);
  }
  if (!isDeepStrictEqual(doc.permissions, { contents: "read" })) {
    out.push(`${name}: R8 top-level 'permissions' must be exactly { contents: read }`);
  }

  const aggId = spec.aggregateId;
  const agg = jobs[aggId];
  const changes = jobs.changes;

  // Rule 2 and 3: aggregate existence, name, shape.
  if (!isPlainObject(agg)) {
    out.push(`${name}: R2 aggregate job '${aggId}' is missing`);
  } else {
    if (agg.name !== spec.aggregateName) {
      out.push(`${name}: job '${aggId}': R2 name must be the literal '${spec.aggregateName}'`);
    }
    if (agg.if === undefined || norm(agg.if) !== "always()") {
      out.push(`${name}: job '${aggId}': R3 'if' must be exactly 'always()'`);
    }
    if (!isDeepStrictEqual(agg.permissions, {})) {
      out.push(`${name}: job '${aggId}': R3 'permissions' must be {}`);
    }
    for (const key of ["strategy", "defaults", "env"]) {
      if (key in agg) out.push(`${name}: job '${aggId}': R3 '${key}' is forbidden on the aggregate`);
    }
    // Rule 4: single step, exact env, no expression in run.
    const steps = Array.isArray(agg.steps) ? agg.steps : [];
    if (steps.length !== 1) {
      out.push(`${name}: job '${aggId}': R4 must have exactly one step (found ${steps.length})`);
    }
    const step = steps[0];
    if (isPlainObject(step)) {
      if ("if" in step) out.push(`${name}: job '${aggId}': R3 step-level 'if' is forbidden`);
      if ("shell" in step) out.push(`${name}: job '${aggId}': R3 step-level 'shell' is forbidden`);
      if ("uses" in step) out.push(`${name}: job '${aggId}': R4 the step must be a 'run' step, not 'uses'`);
      if (!isDeepStrictEqual(normEnv(step.env), AGGREGATE_ENV)) {
        out.push(`${name}: job '${aggId}': R4 step 'env' must be exactly { NEEDS: \${{ toJSON(needs) }} }`);
      }
      if (typeof step.run !== "string" || step.run.includes("${{")) {
        out.push(`${name}: job '${aggId}': R4 step 'run' must be a string with no '\${{' expression`);
      }
    } else if (steps.length === 1) {
      out.push(`${name}: job '${aggId}': R4 the step is not a mapping`);
    }
    // Rule 5: needs equals every other job id.
    const expected = Object.keys(jobs).filter((id) => id !== aggId);
    const actual = needsList(agg.needs);
    for (const id of expected) {
      if (!actual.includes(id)) out.push(`${name}: job '${aggId}': R5 'needs' is missing job '${id}'`);
    }
    for (const id of actual) {
      if (!expected.includes(id)) out.push(`${name}: job '${aggId}': R5 'needs' lists '${id}', which is not another job of this workflow`);
    }
  }

  // The changes job is required (rule 10 and the filter-key check in rule 7).
  const changesOutputs = isPlainObject(changes?.outputs) ? changes.outputs : {};
  if (!isPlainObject(changes)) out.push(`${name}: R10 'changes' job is missing`);

  for (const [id, job] of Object.entries(jobs)) {
    if (!isPlainObject(job)) continue;
    // Rule 6.
    if ("continue-on-error" in job) {
      out.push(`${name}: job '${id}': R6 'continue-on-error' is forbidden (masks a red job as success)`);
    }
    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (isPlainObject(step) && "continue-on-error" in step) {
        out.push(`${name}: job '${id}': R6 step-level 'continue-on-error' is forbidden`);
      }
    }
    // Rule 8 (job level).
    if (
      job.permissions !== undefined &&
      !isDeepStrictEqual(job.permissions, {}) &&
      !isDeepStrictEqual(job.permissions, { contents: "read" })
    ) {
      out.push(`${name}: job '${id}': R8 'permissions' must be absent, {} or { contents: read }`);
    }
    // Rule 7: closed grammar for job-level `if`.
    if (id !== aggId && job.if !== undefined) {
      const cls = classifyIf(id, job.if);
      if (!cls) {
        out.push(`${name}: job '${id}': R7 'if' is not a canonical fail-closed form: ${norm(job.if)}`);
      } else {
        const needs = needsList(job.needs);
        for (const dep of cls.deps) {
          if (!needs.includes(dep)) {
            out.push(`${name}: job '${id}': R7 'if' references needs.${dep} but 'needs' does not list it`);
          }
        }
        for (const f of cls.filters) {
          if (!(f in changesOutputs)) {
            out.push(`${name}: job '${id}': R7 'if' names filter '${f}', which is not an output of the 'changes' job`);
          }
        }
      }
    }
    // Rule 9.
    if (spec.everyJobGated && id !== aggId && id !== "changes") {
      if (!needsList(job.needs).includes("changes")) {
        out.push(`${name}: job '${id}': R9 'needs' must include 'changes'`);
      }
      const cls = job.if === undefined ? null : classifyIf(id, job.if);
      if (!cls || cls.kind !== "FC") {
        out.push(`${name}: job '${id}': R9 must carry the fail-closed FC 'if' form`);
      }
    }
    // Rule 11: step-level `if` outside the aggregate and the filter step.
    if (id !== aggId) {
      for (const step of Array.isArray(job.steps) ? job.steps : []) {
        if (!isPlainObject(step) || step.if === undefined) continue;
        if (id === "changes" && step.id === "filter") continue;
        if (!STEP_IF_ALLOWED.has(norm(step.if))) {
          out.push(`${name}: job '${id}': R11 step 'if' must be absent or one of failure()/always()/!cancelled(), found: ${norm(step.if)}`);
        }
      }
    }
  }

  // Rule 10: the changes job.
  if (isPlainObject(changes)) {
    const steps = stepsOf(doc, "changes");
    const size = steps.filter((s) => isPlainObject(s) && s.id === "size");
    if (size.length !== 1) {
      out.push(`${name}: job 'changes': R10 must have exactly one step with id 'size' (found ${size.length})`);
    } else {
      const s = size[0];
      if (!isDeepStrictEqual(normEnv(s.env), { CHANGED_FILES: "${{ github.event.pull_request.changed_files }}" })) {
        out.push(`${name}: job 'changes': R10 'size' step 'env' must be exactly { CHANGED_FILES: \${{ github.event.pull_request.changed_files }} }`);
      }
      if ("if" in s) out.push(`${name}: job 'changes': R10 'size' step must have no 'if'`);
      if (typeof s.run !== "string" || s.run.includes("${{")) {
        out.push(`${name}: job 'changes': R10 'size' step 'run' must be a string with no '\${{' expression`);
      }
    }
    const filter = steps.filter((s) => isPlainObject(s) && s.id === "filter");
    if (filter.length !== 1) {
      out.push(`${name}: job 'changes': R10 must have exactly one step with id 'filter' (found ${filter.length})`);
    } else {
      if (norm(filter[0].if ?? "") !== "steps.size.outputs.small == 'true'") {
        out.push(`${name}: job 'changes': R10 'filter' step 'if' must be exactly 'steps.size.outputs.small == 'true''`);
      }
      // Any other input (base, ref, predicate-quantifier, …) changes what the
      // filter answers without touching the filter list.
      if (!isDeepStrictEqual(withKeysOf(filter[0]), ["filters"])) {
        out.push(`${name}: job 'changes': R10 'filter' step 'with' must have exactly the key 'filters'`);
      }
    }
    const entries = Object.entries(changesOutputs);
    if (entries.length === 0) out.push(`${name}: job 'changes': R10 has no 'outputs'`);
    for (const [k, v] of entries) {
      if (norm(v) !== `\${{ steps.filter.outputs.${k} || 'true' }}`) {
        out.push(`${name}: job 'changes': R10 output '${k}' must be \${{ steps.filter.outputs.${k} || 'true' }}`);
      }
    }
  }

  return out;
}

/**
 * The aggregate step and the `size` guard step must be deep-equal across the
 * mapped workflows, so a divergence in one is caught.
 * @param {Record<string, string>} contentsByName
 * @param {Record<string, { aggregateId: string }>} specs
 * @returns {string[]}
 */
export function findAggregateStepDivergence(contentsByName, specs) {
  const out = [];
  const probes = [
    {
      label: "aggregate step",
      pick: (doc, spec) => stepsOf(doc, spec.aggregateId)[0],
    },
    {
      label: "'size' guard step",
      pick: (doc) => changesStep(doc, "size"),
    },
    {
      // The filter lists differ by design; the action and its inputs do not.
      label: "'filter' step action and 'with' keys",
      pick: (doc) => {
        const step = changesStep(doc, "filter");
        return step === undefined ? undefined : { uses: step.uses, if: step.if, withKeys: withKeysOf(step) };
      },
    },
  ];
  for (const { label, pick } of probes) {
    let first = null;
    for (const [name, spec] of Object.entries(specs)) {
      const content = contentsByName[name];
      if (content === undefined) continue;
      const parsed = parseWorkflow(content, name);
      if ("error" in parsed) continue;
      const step = pick(parsed.doc, spec);
      if (step === undefined) continue;
      if (first === null) {
        first = { name, step };
      } else if (!isDeepStrictEqual(first.step, step)) {
        out.push(`${name}: ${label} differs from ${first.name}'s — the two must stay identical`);
      }
    }
  }
  return out;
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Each required name must be the effective name (`name`, else the job id) of
 * exactly one job across every workflow; a `name` with `${{ }}` collides when
 * its literal parts, with each expression read as `.*`, match a required name.
 * @param {Record<string, string>} contentsByName
 * @param {string[]} requiredNames
 * @returns {string[]}
 */
export function findRequiredNameCollisions(contentsByName, requiredNames) {
  const out = [];
  const holders = new Map(requiredNames.map((n) => [n, []]));
  for (const [file, content] of Object.entries(contentsByName)) {
    const parsed = parseWorkflow(content, file);
    if ("error" in parsed) {
      out.push(parsed.error);
      continue;
    }
    const jobs = isPlainObject(parsed.doc.jobs) ? parsed.doc.jobs : {};
    for (const [id, job] of Object.entries(jobs)) {
      const effective = String(isPlainObject(job) && job.name !== undefined ? job.name : id);
      for (const required of requiredNames) {
        let hit;
        if (effective.includes("${{")) {
          const pattern = effective.split(/\$\{\{[\s\S]*?\}\}/).map(escapeRegExp).join(".*");
          hit = new RegExp(`^${pattern}$`).test(required);
        } else {
          hit = effective === required;
        }
        if (hit) holders.get(required).push(`${file} job '${id}'`);
      }
    }
  }
  for (const [required, where] of holders) {
    if (where.length !== 1) {
      out.push(`required check name '${required}' must belong to exactly one job across all workflows, found ${where.length}${where.length ? `: ${where.join(", ")}` : ""}`);
    }
  }
  return out;
}

/**
 * @param {{
 *   workflowsDir: string,
 *   specs: Record<string, { aggregateId: string, aggregateName: string, everyJobGated: boolean }>,
 *   readFile?: (path: string) => string,
 *   listFiles?: (dir: string) => string[],
 * }} opts
 * @returns {string[]}
 */
export function checkRepository({
  workflowsDir,
  specs,
  readFile = (p) => readFileSync(p, "utf8"),
  listFiles = (d) => readdirSync(d),
}) {
  const out = [];
  const contents = {};
  for (const file of listFiles(workflowsDir)) {
    if (!/\.ya?ml$/.test(file)) continue;
    contents[file] = readFile(join(workflowsDir, file));
  }
  for (const [file, spec] of Object.entries(specs)) {
    if (contents[file] === undefined) {
      out.push(`${file}: mapped workflow is missing from ${workflowsDir}`);
      continue;
    }
    out.push(...findWorkflowViolations(contents[file], file, spec));
  }
  out.push(...findAggregateStepDivergence(contents, specs));
  out.push(
    ...findRequiredNameCollisions(
      contents,
      Object.values(specs).map((s) => s.aggregateName),
    ),
  );
  return out;
}

function main() {
  const violations = checkRepository({ workflowsDir: WORKFLOWS_DIR, specs: SPECS });
  if (violations.length > 0) {
    console.error("Required-aggregate violations:");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log("Required-aggregate check passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
