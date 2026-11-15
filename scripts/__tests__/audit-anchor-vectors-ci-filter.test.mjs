/**
 * The audit-anchor vector file lives under cli/ and is read by two suites: the
 * CLI's and the server's (src/lib/audit/anchor-manifest.unit.test.ts). ci.yml
 * decides which jobs a PR runs from path filters, and `app` — the filter the
 * server tests run under — lists no cli/ path but this one. Without it a PR
 * that changes only the vectors runs the CLI suite and skips the server's, and
 * the two implementations stop being held to the same file.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const ROOT = process.cwd();
const VECTORS = "cli/src/__tests__/fixtures/audit-anchor-vectors.json";
const SERVER_SUITE = "src/lib/audit/anchor-manifest.unit.test.ts";
const CLI_SUITE = "cli/src/__tests__/unit/audit-verify-vectors.test.ts";

function pathFilters(workflowFile = "ci.yml") {
  const workflow = load(readFileSync(join(ROOT, ".github/workflows", workflowFile), "utf8"));
  const step = workflow.jobs.changes.steps.find((s) => s.id === "filter");
  return load(step.with.filters);
}

describe("ci.yml path filters and the audit-anchor vector file", () => {
  it("the file exists and both suites read it", () => {
    expect(existsSync(join(ROOT, VECTORS))).toBe(true);
    expect(readFileSync(join(ROOT, SERVER_SUITE), "utf8")).toContain(VECTORS);
    expect(readFileSync(join(ROOT, CLI_SUITE), "utf8")).toContain("audit-anchor-vectors.json");
  });

  it("the app filter lists the vector file by its exact path", () => {
    expect(pathFilters().app).toContain(VECTORS);
  });

  it("the cli filter covers it through cli/**", () => {
    expect(pathFilters().cli).toContain("cli/**");
  });

  it("no other app entry already covers a cli/ path (the entry is what runs the server suite)", () => {
    const others = pathFilters().app.filter((p) => p !== VECTORS);
    expect(others.filter((p) => p.startsWith("cli/") || p === "**")).toEqual([]);
  });
});

// The anchor integration tests read files outside src/__tests__/db-integration:
// a PR that changes only one of those must still run the integration job.
describe("ci-integration.yml path filter and what the anchor integration tests read", () => {
  const INTEGRATION_DIR = "src/__tests__/db-integration";
  const PUBLISHER_SUITE = `${INTEGRATION_DIR}/audit-anchor-publisher.integration.test.ts`;
  const GITHUB_SUITE = `${INTEGRATION_DIR}/audit-anchor-github-release-destination.integration.test.ts`;

  it("the suites still read the shared helpers and the alerts doc", () => {
    expect(readFileSync(join(ROOT, PUBLISHER_SUITE), "utf8")).toContain("@/__tests__/helpers/");
    expect(readFileSync(join(ROOT, PUBLISHER_SUITE), "utf8")).toContain('"alerts.md"');
    expect(readFileSync(join(ROOT, GITHUB_SUITE), "utf8")).toContain("../helpers/fake-github-release-server");
  });

  it("the integration filter lists the helpers directory and the alerts doc", () => {
    const { integration } = pathFilters("ci-integration.yml");
    expect(integration).toContain("src/__tests__/helpers/**");
    expect(integration).toContain("docs/operations/alerts.md");
    // Neither is covered by the tests' own directory entry.
    expect(integration).toContain(`${INTEGRATION_DIR}/**`);
  });
});
