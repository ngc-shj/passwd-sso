/**
 * Self-test for scripts/checks/check-cli-shell-safety.mjs (C6) — proves each
 * of the gate's three rules can both fire and stay quiet (RT7), following the
 * check-operator-echo-escaped.mjs convention: fixtures written to a temp
 * directory, the gate spawnSync-ed against them.
 *
 * Two independent fixture roots (I6.3 — CLI_SHELL_SAFETY_ROOT for Rules A/B,
 * SRC_ADJUDICATOR_ROOT for Rule C): every invocation sets BOTH, even when a
 * test exercises only one rule, so the other root stays an empty scratch
 * directory instead of silently falling back to the real repo tree (which
 * would leak the real cli/src or src findings into an unrelated assertion).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-cli-shell-safety.mjs");
const PRE_PR = join(REPO_ROOT, "scripts/pre-pr.sh");

let root, cliRoot, srcRoot;

function runGuard() {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, CLI_SHELL_SAFETY_ROOT: cliRoot, SRC_ADJUDICATOR_ROOT: srcRoot },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeCli(rel, contents) {
  const full = join(cliRoot, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function writeSrc(rel, contents) {
  const full = join(srcRoot, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cli-shell-safety-"));
  cliRoot = join(root, "cli-src");
  srcRoot = join(root, "src");
  mkdirSync(cliRoot, { recursive: true });
  mkdirSync(srcRoot, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-cli-shell-safety.mjs", () => {
  describe("Rule A (launch)", () => {
    it("FAILS on spawn(\"cmd\", [...url]) — a shell interpreter with a non-literal argument", () => {
      writeCli(
        "lib/launch.ts",
        `import { spawn } from "node:child_process";
export function openOnWindows(url: string) {
  spawn("cmd", ["/c", "start", "", url]);
}
`,
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Rule A");
      expect(stderr).toContain("url");
    });

    it("passes on execSync with only literal arguments (the clipboard.ts shape)", () => {
      writeCli(
        "lib/clipboard.ts",
        `import { execSync } from "node:child_process";
export function clear() {
  execSync("pbcopy < /dev/null", { stdio: "ignore", timeout: 1000 });
}
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("passes on spawn(process.execPath, ...) — a non-literal command that never names a shell", () => {
      writeCli(
        "commands/agent.ts",
        `import { spawn } from "node:child_process";
export function forkDaemon(childArgs: string[]) {
  spawn(process.execPath, childArgs, { detached: true, stdio: "ignore" });
}
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });
  });

  describe("Rule B (emission)", () => {
    it("FAILS on a trap template literal with a bare interpolation, under console.log", () => {
      writeCli(
        "commands/agent.ts",
        `export function emit(x: string) {
  console.log(\`trap \${x} EXIT;\`);
}
`,
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Rule B");
    });

    it("FAILS on a trap template literal with a bare interpolation, in a return position", () => {
      // I3.4's shape: a pure function that RETURNS the line instead of
      // printing it — a console.log-anchored pattern would miss this.
      writeCli(
        "commands/agent-decrypt.ts",
        `export function trapLine(x: string): string {
  return \`trap \${x} EXIT;\`;
}
`,
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Rule B");
    });

    it("FAILS on the composed-trap shape when only the outer wrap is quoted", () => {
      // The shipped shape: the trap body is built first, then quoted whole.
      // The inner literal's own text carries no NAME=/export/trap keyword, so
      // a keyword-only rule inspects the outer wrap, finds it discharged, and
      // reports green while the values a shell will parse go unquoted.
      writeCli(
        "commands/agent.ts",
        `import { shellQuote } from "../lib/shell-quote.js";
export function emit(pid: number, sock: string) {
  const inner = \`kill \${pid} 2>/dev/null; rm -f \${sock}\`;
  console.log(\`trap \${shellQuote(inner)} EXIT;\`);
}
`,
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("Rule B");
      expect(stderr).toContain("sock");
    });

    it("passes the composed-trap shape when the inner values are quoted too", () => {
      writeCli(
        "commands/agent.ts",
        `import { shellQuote } from "../lib/shell-quote.js";
export function emit(pid: number, sock: string) {
  const inner = \`kill \${shellQuote(String(pid))} 2>/dev/null; rm -f \${shellQuote(sock)}\`;
  console.log(\`trap \${shellQuote(inner)} EXIT;\`);
}
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("does NOT demand inner quoting for a value composed and quoted once", () => {
      // Quoting a composed value once is the correct idiom — the result is one
      // shell word, and nesting shellQuote inside it would embed literal quote
      // characters and break the value. Only a trap body is parsed twice.
      // An earlier revision of this rule flagged both interpolations here and
      // the "fix" it demanded produced unusable output; this pins that the
      // rule stays quiet, since nothing else would catch its return.
      writeCli(
        "commands/agent.ts",
        `import { shellQuote } from "../lib/shell-quote.js";
export function emit(dir: string, name: string) {
  console.log(\`PSSO_PATH=\${shellQuote(\`\${dir}/\${name}\`)}\`);
}
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("passes when the trap interpolation is wrapped in shellQuote", () => {
      writeCli(
        "commands/agent.ts",
        `import { shellQuote } from "../lib/shell-quote.js";
export function emit(x: string) {
  console.log(\`trap \${shellQuote(x)} EXIT;\`);
}
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("does NOT flag an interpolated variable NAME (the env.ts dotenv/export shape)", () => {
      // `k` is the env-var NAME, validated upstream by assertValidEnvName —
      // a different, legitimate discharge. It never appears as static
      // "NAME=" text, so the literal has no shell form for the rule to
      // match in the first place; only `v` needs shellQuote.
      writeCli(
        "commands/env.ts",
        `import { shellQuote } from "../lib/shell-quote.js";
export function printEnv(k: string, v: string) {
  console.log(\`\${k}=\${shellQuote(v)}\`);
  console.log(\`export \${k}=\${shellQuote(v)}\`);
}
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("does NOT flag a lowerCamelCase diagnostic message that merely looks like key=value", () => {
      // audit-verify.ts's `expected=${expected}, got=${got}` — human-readable
      // debug text, not shell syntax. The ALL-CAPS requirement is what tells
      // the two apart.
      writeCli(
        "commands/audit-verify.ts",
        `export function describe(expected: string, got: string): string {
  return \`chain break; expected=\${expected}, got=\${got}\`;
}
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });
  });

  describe("Rule C (single-adjudicator tripwire)", () => {
    it("FAILS when a second file references verifyTailscalePeer", () => {
      writeSrc(
        "lib/services/tailscale-client.ts",
        `export async function verifyTailscalePeer(ip: string, tailnet: string): Promise<boolean> {
  return true;
}
`,
      );
      writeSrc(
        "lib/auth/policy/access-restriction.ts",
        `import { verifyTailscalePeer } from "../../services/tailscale-client";
export async function checkAccessRestriction() {
  return verifyTailscalePeer("1.2.3.4", "acme");
}
`,
      );
      writeSrc(
        "lib/other-adjudicator.ts",
        `import { verifyTailscalePeer } from "./services/tailscale-client";
export async function secondSite() {
  return verifyTailscalePeer("5.6.7.8", "acme");
}
`,
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("verifyTailscalePeer");
    });

    it("passes on the real single-site shape (one external consumer)", () => {
      writeSrc(
        "lib/services/tailscale-client.ts",
        `export async function verifyTailscalePeer(ip: string, tailnet: string): Promise<boolean> {
  return true;
}
`,
      );
      writeSrc(
        "lib/auth/policy/access-restriction.ts",
        `import { verifyTailscalePeer } from "../../services/tailscale-client";
export async function checkAccessRestriction() {
  const verified = await verifyTailscalePeer("1.2.3.4", "acme");
  return verified;
}
`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("FAILS when a second file contains the 64:ff9b literal", () => {
      writeSrc("lib/http/external-http.ts", `export const NAT64_PREFIX = "64:ff9b::/96";\n`);
      writeSrc("lib/auth/policy/ip-access.ts", `// also mentions 64:ff9b here\nexport const X = 1;\n`);
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("64:ff9b");
    });

    it("passes when 64:ff9b appears only in the NAT64 classifier", () => {
      writeSrc("lib/http/external-http.ts", `export const NAT64_PREFIX = "64:ff9b::/96";\n`);
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("FAILS when a second file contains /localapi/v0/whois", () => {
      writeSrc("lib/services/tailscale-client.ts", `const path = "/localapi/v0/whois?addr=1";\n`);
      writeSrc("lib/other-whois-client.ts", `const path = "/localapi/v0/whois?addr=2";\n`);
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("/localapi/v0/whois");
    });

    it("passes when /localapi/v0/whois appears only in the WhoIs client", () => {
      writeSrc("lib/services/tailscale-client.ts", `const path = "/localapi/v0/whois?addr=1";\n`);
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });
  });

  it("is wired into scripts/pre-pr.sh", () => {
    // I6.2 — mechanical wiring proof; there is no repo-wide "is every check
    // queued" meta-gate to lean on instead (check-orphaned-checks.sh does
    // not exist).
    const r = spawnSync("grep", ["-q", "check-cli-shell-safety", PRE_PR]);
    expect(r.status).toBe(0);
    // Also sanity-check the file is readable at all, so a missing PRE_PR
    // constant path fails loudly here rather than as a silent grep miss.
    expect(readFileSync(PRE_PR, "utf8").length).toBeGreaterThan(0);
  });
});
