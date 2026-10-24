/**
 * Every Secrets Manager key an ECS task definition reads must be documented in
 * both infra/terraform READMEs' "Required Secrets" tables — an operator
 * populates the secret from those tables, and ECS refuses to launch a task
 * whose key is missing. And the publisher's signing key and tag secret reach
 * the publisher's task and no other.
 *
 * Task definitions are evaluated with every conditional secret switched on
 * (SMTP with credentials, Google, extra Jackson connections), so a key behind a
 * toggle is listed too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TerraformConfig, TERRAFORM_DIR, plain } from "../helpers/hcl-subset";

const ALL_ON = { vars: { smtp_host: "smtp.example.com", smtp_auth_enabled: true, enable_google_auth: true, enable_jackson_connections: true, email_from: "a@example.com" } };
const SECRET_REF = /^<ref:aws_secretsmanager_secret\.(\w+)\.arn>:([A-Z0-9_]+)::$/;
const PUBLISHER_ONLY = ["AUDIT_ANCHOR_SIGNING_KEY", "AUDIT_ANCHOR_TAG_SECRET"];

type Container = {
  environment?: Array<{ name: string; value: unknown }>;
  secrets?: Array<{ name: string; valueFrom: string }>;
};

/** task name → container definitions. */
function taskContainers(tf: TerraformConfig): Record<string, Container[]> {
  return Object.fromEntries(
    tf.resources("aws_ecs_task_definition").map((t) => [t.labels[1], plain(tf.attr(t, "container_definitions", ALL_ON)) as Container[]]),
  );
}

/** secret resource name → keys read from it, across every task. */
function secretKeys(tf: TerraformConfig): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const defs of Object.values(taskContainers(tf))) {
    for (const c of defs) {
      for (const s of c.secrets ?? []) {
        const m = SECRET_REF.exec(s.valueFrom);
        if (!m) throw new Error(`unrecognised valueFrom ${s.valueFrom}`);
        (out[m[1]] ??= new Set()).add(m[2]);
      }
    }
  }
  return out;
}

/** The keys in a README's "### Required Secrets (<which>)" table. */
function readmeTableKeys(readme: string, which: string): Set<string> {
  const start = readme.indexOf(`### Required Secrets (${which})`);
  if (start < 0) throw new Error(`no Required Secrets (${which}) section`);
  const lines = readme.slice(start).split("\n").slice(1);
  const keys = new Set<string>();
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("|")) {
      inTable = true;
      const m = /^\| `([A-Z0-9_]+)` \|/.exec(line);
      if (m) keys.add(m[1]);
    } else if (inTable) break;
  }
  return keys;
}

const READMES = ["README.md", "README.ja.md"].map((f) => [f, readFileSync(join(TERRAFORM_DIR, f), "utf8")] as const);

function missingFromReadmes(tf: TerraformConfig, readmes: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [secret, keys] of Object.entries(secretKeys(tf))) {
    for (const [file, text] of readmes) {
      const documented = readmeTableKeys(text, secret);
      for (const k of keys) if (!documented.has(k)) out.push(`${file} (${secret}): ${k}`);
    }
  }
  return out;
}

function publisherOnlyLeaks(tf: TerraformConfig): string[] {
  const out: string[] = [];
  for (const [task, defs] of Object.entries(taskContainers(tf))) {
    if (task === "audit_anchor_publisher") continue;
    const text = JSON.stringify(defs);
    for (const name of PUBLISHER_ONLY) if (text.includes(name)) out.push(`${task}: ${name}`);
  }
  return out;
}

describe("ECS task secrets vs the README secret tables", () => {
  const tf = new TerraformConfig(TERRAFORM_DIR);

  it("reads keys from the app and jackson secrets only", () => {
    expect(Object.keys(secretKeys(tf)).sort()).toEqual(["app", "jackson"]);
  });

  it("documents every valueFrom key in both READMEs", () => {
    expect(missingFromReadmes(tf, READMES)).toEqual([]);
  });

  it("catches a key missing from one README", () => {
    const stripped = READMES.map(([f, t]) => [f, f === "README.ja.md" ? t.replace(/^\| `DEPLOYMENT_ID` \|.*\n/m, "") : t] as const);
    expect(stripped[1][1]).not.toBe(READMES[1][1]);
    expect(missingFromReadmes(tf, stripped)).toEqual(["README.ja.md (app): DEPLOYMENT_ID"]);
  });

  it("gives the signing key and tag secret to the publisher task", () => {
    const names = (taskContainers(tf).audit_anchor_publisher[0].secrets ?? []).map((s) => s.name);
    for (const name of PUBLISHER_ONLY) expect(names).toContain(name);
  });

  it("gives them to no other task", () => {
    expect(publisherOnlyLeaks(tf)).toEqual([]);
  });

  it("catches the signing key back on the app task", () => {
    const text = readFileSync(join(TERRAFORM_DIR, "ecs.tf"), "utf8");
    const anchor = '{ name = "VERIFIER_PEPPER_KEY", valueFrom = "${aws_secretsmanager_secret.app.arn}:VERIFIER_PEPPER_KEY::" },';
    expect(text.split(anchor).length - 1).toBe(1);
    const leaked = new TerraformConfig(TERRAFORM_DIR, {
      "ecs.tf": text.replace(
        anchor,
        `${anchor}\n          { name = "AUDIT_ANCHOR_SIGNING_KEY", valueFrom = "\${aws_secretsmanager_secret.app.arn}:AUDIT_ANCHOR_SIGNING_KEY::" },`,
      ),
    });
    expect(publisherOnlyLeaks(leaked)).toEqual(["app: AUDIT_ANCHOR_SIGNING_KEY"]);
  });
});
