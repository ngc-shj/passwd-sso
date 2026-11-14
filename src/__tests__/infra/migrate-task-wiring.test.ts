/**
 * The migrate task's command order, and the two operator-only variables.
 *
 * The preflight must refuse a pending RLS-enforce migration BEFORE
 * `prisma migrate deploy` applies it, and the grant audit runs last. The
 * attestation and the report-mode acknowledgement are forwarded by
 * scripts/deploy.sh when an operator exports them: a task definition that
 * carried either one would apply it to every deploy, so no container may.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TerraformConfig, TERRAFORM_DIR, plain } from "../helpers/hcl-subset";

const OPERATOR_ONLY = ["RLS_ENFORCE_ATTESTED", "RLS_REPORT_MODE_ACK"];
const ALL_ON = { vars: { smtp_host: "smtp.example.com", smtp_auth_enabled: true, enable_google_auth: true, enable_jackson_connections: true, email_from: "a@example.com" } };

type Container = {
  name: string;
  command?: string[];
  environment?: Array<{ name: string }>;
  secrets?: Array<{ name: string }>;
};

function taskContainers(tf: TerraformConfig): Array<{ task: string; container: Container }> {
  return tf.resources("aws_ecs_task_definition").flatMap((t) =>
    (plain(tf.attr(t, "container_definitions", ALL_ON)) as Container[]).map((container) => ({ task: t.labels[1], container })),
  );
}

function commandViolations(tf: TerraformConfig): string[] {
  const migrate = taskContainers(tf).find((c) => c.task === "migrate" && c.container.name === "migrate")?.container;
  const script = migrate?.command?.[2] ?? "";
  const preflight = script.indexOf("node scripts/rls-enforce-preflight.mjs");
  const migration = script.indexOf("npx prisma migrate deploy");
  const audit = script.indexOf("node scripts/audit-db-grants.mjs");
  const out: string[] = [];
  if (!script.startsWith("set -e;")) out.push("command does not start with set -e");
  if (preflight < 0) out.push("command does not run the preflight");
  if (migration < 0 || audit < 0) out.push("command lacks the migration or the audit");
  if (preflight >= 0 && migration >= 0 && preflight > migration) out.push("preflight runs after the migration");
  if (audit >= 0 && migration >= 0 && audit < migration) out.push("audit runs before the migration");
  return out;
}

function carriedVariables(tf: TerraformConfig): string[] {
  return taskContainers(tf).flatMap(({ task, container }) =>
    [...(container.environment ?? []), ...(container.secrets ?? [])]
      .filter((e) => OPERATOR_ONLY.includes(e.name))
      .map((e) => `${task}/${container.name}: ${e.name}`),
  );
}

const ecsText = readFileSync(join(TERRAFORM_DIR, "ecs.tf"), "utf8");

function edited(from: string, to: string): TerraformConfig {
  expect(ecsText.split(from).length - 1, `fixture edit must match once: ${from}`).toBe(1);
  return new TerraformConfig(TERRAFORM_DIR, { "ecs.tf": ecsText.replace(from, to) });
}

describe("migrate task wiring", () => {
  const tf = new TerraformConfig(TERRAFORM_DIR);
  const COMMAND = "set -e; node scripts/rls-enforce-preflight.mjs; npx prisma migrate deploy; node scripts/audit-db-grants.mjs";
  const SECRET_ANCHOR = '{ name = "VERIFIER_PEPPER_KEY", valueFrom = "${aws_secretsmanager_secret.app.arn}:VERIFIER_PEPPER_KEY::" },';

  it("runs the preflight before prisma migrate deploy and the grant audit after it", () => {
    expect(commandViolations(tf)).toEqual([]);
  });

  it("catches the migration running before the preflight", () => {
    const swapped = edited(COMMAND, "set -e; npx prisma migrate deploy; node scripts/rls-enforce-preflight.mjs; node scripts/audit-db-grants.mjs");
    expect(commandViolations(swapped)).toEqual(["preflight runs after the migration"]);
  });

  it("catches the preflight removed", () => {
    const removed = edited(COMMAND, "set -e; npx prisma migrate deploy; node scripts/audit-db-grants.mjs");
    expect(commandViolations(removed)).toEqual(["command does not run the preflight"]);
  });

  it("gives no container an environment or secrets entry for the operator-only variables", () => {
    expect(taskContainers(tf).length).toBeGreaterThan(0);
    expect(carriedVariables(tf)).toEqual([]);
  });

  it("catches a defaulted attestation in the migrate task", () => {
    const defaulted = edited(
      SECRET_ANCHOR,
      `${SECRET_ANCHOR}\n        { name = "RLS_ENFORCE_ATTESTED", valueFrom = "\${aws_secretsmanager_secret.app.arn}:RLS_ENFORCE_ATTESTED::" },`,
    );
    expect(carriedVariables(defaulted)).toEqual(["app/app: RLS_ENFORCE_ATTESTED"]);
  });
});
