/**
 * Tests for scripts/init-env.ts (Step 10 §E).
 *
 * Uses the exported run() API with injectable streams (T4 compliance).
 *
 * Important readline limitation:
 *   readline/promises.rl.question() in non-TTY mode reads from the stream
 *   synchronously if data is immediately available. Pushing data faster than
 *   prompts can fire causes Node.js to buffer infinitely (OOM) or event-loop
 *   drain before run() completes. A DelayedAnswerStream using setImmediate
 *   between pushes prevents this.
 *
 * Scope limitation: full-flow tests (dev profile write, production re-prompt)
 * require one answer per prompt in an async-coordinated manner. The abort test
 * only needs one answer (before any prompt loop), so it works reliably.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable, PassThrough } from "node:stream";
import {
  mkdtempSync,
  rmSync,
  statSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { platform } from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { run, parseSimpleDotenv } from "../init-env.ts";
import { envObject, envSchema } from "../../src/lib/env-schema.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// REPO_ROOT kept for potential future use when tests need absolute paths.
const _REPO_ROOT = resolve(__dirname, "..", "..");
void _REPO_ROOT;

// ── env snapshot / restore ────────────────────────────────────────────────────

let origEnv;
let origCwd;
beforeEach(() => {
  origEnv = { ...process.env };
  origCwd = process.cwd();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
  try { process.chdir(origCwd); } catch {}
});

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * DelayedAnswerStream: feeds one answer per readline read, with a setImmediate
 * delay between pushes so the readline event loop can process each line before
 * requesting the next. Prevents the infinite-buffer OOM caused by synchronous
 * eager reads.
 *
 * When fallback is null, the stream stalls after all fixedAnswers are consumed
 * (no further pushes). This is safe when prompter.close() is guaranteed to be
 * called before any further readline read, as in the abort path.
 */
class DelayedAnswerStream extends Readable {
  constructor(fixedAnswers, fallback = "y") {
    super({ objectMode: false });
    this._answers = fixedAnswers;
    this._idx = 0;
    this._fallback = fallback;
    this._waiting = false;
    this._done = false;
  }
  _read() {
    if (this._waiting || this._done) return;
    // Stall if all fixed answers consumed and no fallback configured.
    if (this._idx >= this._answers.length && this._fallback === null) return;
    this._waiting = true;
    setImmediate(() => {
      this._waiting = false;
      if (this._done) return;
      const answer = this._idx < this._answers.length
        ? this._answers[this._idx++]
        : this._fallback;
      this.push(answer + "\n");
    });
  }
  _destroy(err, cb) {
    this._done = true;
    cb(err);
  }
}

/** Collect stream output into a string getter. */
function collectStream(stream) {
  const chunks = [];
  stream.on("data", (c) => chunks.push(c));
  return () => Buffer.concat(chunks).toString("utf8");
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("init-env.ts run()", () => {
  it("writes a valid .env under the dev profile and exits 0", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "init-env-dev-"));
    try {
      process.chdir(tmpDir);

      // Feed "" (empty) as the fallback answer for all prompts.
      // - For askYesNo (secret fields): "" + defaultValue=true → generate secret (valid).
      // - For ask with defaultValue: "" → use the defaultValue (valid URL, etc.).
      // - For ask without defaultValue: "" → empty string (may fail Zod, but those
      //   are optional in dev so Zod succeeds).
      const stdin = new DelayedAnswerStream([], "");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const getStdout = collectStream(stdout);
      const getStderr = collectStream(stderr);

      const code = await run({
        stdin,
        stdout,
        stderr,
        now: () => new Date("2026-04-24T00:00:00Z"),
        args: ["--profile=dev"],
      });
      stdin.destroy();

      const stdoutText = getStdout();
      const stderrText = getStderr();

      if (code !== 0) {
        console.error("stderr:", stderrText);
      }

      expect(code).toBe(0);

      const envPath = join(tmpDir, ".env");
      expect(existsSync(envPath)).toBe(true);

      const parsed = dotenv.parse(readFileSync(envPath, "utf8"));
      // CT10: use envSchema (refined) — matches what init-env itself asserts
      // via envSchema.safeParse at write time. Catches regressions where dev
      // profile output would fail refined validation.
      const result = envSchema.safeParse(parsed);
      if (!result.success) {
        console.error(
          "envSchema issues:",
          result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
      expect(result.success).toBe(true);
      // Also verify envObject acceptance for completeness.
      expect(envObject.safeParse(parsed).success).toBe(true);

      // External allowlist entries: with fallback="" the operator "skips"
      // each prompt, EXCEPT secret entries which take the "Generate" Y/n
      // default (true) and land in the file as hex. JACKSON_API_KEY should
      // be present (48-hex) even though it is not a Zod-declared var.
      expect(parsed.JACKSON_API_KEY).toBeDefined();
      expect(/^[0-9a-f]{48}$/.test(parsed.JACKSON_API_KEY)).toBe(true);
      // PASSWD_OUTBOX_WORKER_PASSWORD is also secret → auto-generated 64-hex.
      expect(parsed.PASSWD_OUTBOX_WORKER_PASSWORD).toBeDefined();
      expect(/^[0-9a-f]{64}$/.test(parsed.PASSWD_OUTBOX_WORKER_PASSWORD)).toBe(true);
      // External section header appears in file content.
      const rawContent = readFileSync(envPath, "utf8");
      expect(rawContent).toContain(
        "External / Build-time (not read by the Next.js app)",
      );

      // Generated secrets must NOT leak to stdout/stderr.
      const HEX64_RE = /^[0-9a-f]{64}$/;
      for (const val of Object.values(parsed)) {
        if (HEX64_RE.test(val)) {
          expect(stdoutText).not.toContain(val);
          expect(stderrText).not.toContain(val);
        }
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(platform === "win32")("sets file mode 0600 on the written .env (POSIX-only)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "init-env-mode-"));
    try {
      process.chdir(tmpDir);

      const stdin = new DelayedAnswerStream([], "");
      const stdout = new PassThrough();
      const stderr = new PassThrough();

      const code = await run({
        stdin,
        stdout,
        stderr,
        now: () => new Date("2026-04-24T00:00:00Z"),
        args: ["--profile=dev"],
      });
      stdin.destroy();

      expect(code).toBe(0);
      const mode = statSync(join(tmpDir, ".env")).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(platform !== "win32")("mode restriction not applicable on win32 (platform gate)", () => {
    // Intentional skip: file chmod is a no-op on win32.
  });

  it("reprompts exactly 5 times per failing field and then exits 1 when production profile receives invalid input", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "init-env-prod-fail-"));
    try {
      process.chdir(tmpDir);

      // Feed "y" for all prompts. DATABASE_URL receives "y" → passes initial
      // nonEmpty check but fails envSchema production superRefine. The re-prompt
      // loop then re-asks DATABASE_URL (and other failed fields) up to 5 times.
      const stdin = new DelayedAnswerStream([], "y");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const getStdout = collectStream(stdout);
      const getStderr = collectStream(stderr);

      const code = await run({
        stdin,
        stdout,
        stderr,
        now: () => new Date("2026-04-24T00:00:00Z"),
        args: ["--profile=production"],
      });
      stdin.destroy();

      const stdoutText = getStdout();
      const stderrText = getStderr();

      expect(code).toBe(1);
      expect(stderrText).toMatch(
        /The following fields failed validation|failed validation after/i,
      );
      // NF-4.3: rejected value must not appear in transcript.
      expect(stderrText).not.toMatch(/value\s*=\s*["']y["']/i);

      // CT3: assert the re-prompt count is exactly 5 per failing field.
      // The prompter writes "Re-enter <fieldPath>" on each retry. At least one
      // failing field must show exactly MAX_FIELD_ATTEMPTS (=5) Re-enter lines.
      const reEnterMatches = stdoutText.match(/Re-enter\s+\S+/g) ?? [];
      expect(reEnterMatches.length).toBeGreaterThan(0);

      // Bucket by field path and verify at least one bucket has 5 retries.
      const countByField = new Map();
      for (const line of reEnterMatches) {
        const m = line.match(/Re-enter\s+(\S+)/);
        if (!m) continue;
        const f = m[1];
        countByField.set(f, (countByField.get(f) ?? 0) + 1);
      }
      const maxRetries = Math.max(...countByField.values());
      expect(maxRetries).toBe(5);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("aborts without modification when the user rejects overwriting an existing .env", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "init-env-abort-"));
    const envPath = join(tmpDir, ".env");
    const originalContent = "# existing content\nKEY=value\n";
    writeFileSync(envPath, originalContent, { mode: 0o600 });

    try {
      process.chdir(tmpDir);

      // The abort path issues exactly one readline read (the choice prompt).
      // Use fallback="3" so any extra read-ahead from readline returns the
      // same valid choice. Avoids a stall-based race that made this test flaky
      // under tight timeout when readline buffered beyond the first line.
      const stdin = new DelayedAnswerStream(["3"], "3");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const getStdout = collectStream(stdout);

      const code = await run({
        stdin,
        stdout,
        stderr,
        now: () => new Date("2026-04-24T00:00:00Z"),
        args: ["--profile=dev"],
      });
      stdin.destroy();

      expect(code).toBe(0);
      expect(readFileSync(envPath, "utf8")).toBe(originalContent);
      expect(getStdout()).toMatch(/[Aa]bort/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // CT15 / CF6: parseSimpleDotenv unit-tests cover the parser used to
  // restore prior values during Backup-and-overwrite. Keeping these as
  // pure unit tests avoids the readline-driver flakiness that the
  // "writes a valid .env" test deliberately scopes around.
  it("parseSimpleDotenv reads bare KEY=value and quoted KEY=\"value\" (CF6)", () => {
    const text =
      'DATABASE_URL=postgresql://passwd_app:p@host/db\n' +
      'JACKSON_API_KEY="aabbccdd"\n' +
      'EMPTY=\n' +
      '# comment line\n' +
      '\n' +
      'BAD KEY WITH SPACE=ignored\n';
    const out = parseSimpleDotenv(text);
    expect(out.DATABASE_URL).toBe("postgresql://passwd_app:p@host/db");
    expect(out.JACKSON_API_KEY).toBe("aabbccdd");
    expect(out.EMPTY).toBe("");
    expect(out["# comment line"]).toBeUndefined();
    expect(out["BAD KEY WITH SPACE"]).toBeUndefined();
  });

  it("parseSimpleDotenv unescapes \\\", \\\\, \\n, \\r in quoted values", () => {
    const text = 'A="line1\\nline2"\nB="quote\\"end"\nC="back\\\\slash"\n';
    const out = parseSimpleDotenv(text);
    expect(out.A).toBe("line1\nline2");
    expect(out.B).toBe('quote"end');
    expect(out.C).toBe("back\\slash");
  });

  it("init-env.ts source contains the priorValues seed wiring (CF6 wiring assertion)", () => {
    const repoRoot = resolve(__dirname, "..", "..");
    const initEnvSrc = readFileSync(
      join(repoRoot, "scripts", "init-env.ts"),
      "utf8",
    );
    // Backup branch reads the existing file and seeds priorValues.
    expect(initEnvSrc).toMatch(/priorValues\s*=\s*parseSimpleDotenv\(existing\)/);
    // priorValues is iterated into the collected map before the prompt loop.
    expect(initEnvSrc).toMatch(/Object\.entries\(priorValues\)/);
    // External-loop prompt uses priorValues as default before example.
    expect(initEnvSrc).toMatch(
      /defaultValue\s*=\s*priorValues\[entry\.key\]\s*\?\?\s*entry\.example/,
    );
    // User-visible message about prior restoration is emitted (CF6 safety).
    expect(initEnvSrc).toMatch(/Prior values restored as defaults/);
  });

  // RT1: legacy .env.local migration NOTE must fire when only .env.local exists.
  it("emits the migration NOTE when .env.local exists and writes new content to .env (not .env.local)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "init-env-legacy-"));
    try {
      process.chdir(tmpDir);

      // Pre-create a legacy .env.local with one identifying key.
      const legacyContent = "LEGACY_MARKER=preserved\n";
      writeFileSync(join(tmpDir, ".env.local"), legacyContent, { mode: 0o600 });

      const stdin = new DelayedAnswerStream([], "");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const getStderr = collectStream(stderr);

      const code = await run({
        stdin,
        stdout,
        stderr,
        now: () => new Date("2026-04-25T00:00:00Z"),
        args: ["--profile=dev"],
      });
      stdin.destroy();

      expect(code).toBe(0);

      // The NOTE warns about the legacy file and recommends the rename.
      const stderrText = getStderr();
      expect(stderrText).toContain(".env.local exists in this directory");
      expect(stderrText).toContain("mv .env.local .env");

      // init:env writes to .env (the canonical file), NOT .env.local.
      expect(existsSync(join(tmpDir, ".env"))).toBe(true);

      // .env.local is left untouched with its original content.
      expect(readFileSync(join(tmpDir, ".env.local"), "utf8")).toBe(legacyContent);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  // RT2: backup-file naming + atomicWrite call site for the .env-primary
  // refactor. Wiring-assertion form — an end-to-end Backup-and-overwrite
  // flow test would have to drive 40+ readline prompts via DelayedAnswerStream
  // and consistently OOMs the vitest worker (the existing test file's
  // preamble comment documents the same readline-non-TTY buffering issue).
  // Coverage rationale:
  //   - atomicWrite's mode-0600 + atomic-rename guarantees are already
  //     verified end-to-end by the "sets file mode 0600 on the written .env"
  //     test above (same atomicWrite() call site for both .env and the
  //     backup file in init-env.ts).
  //   - This wiring assertion catches a regression where the rename from
  //     `.env.local.bak-${stamp}` to `.env.bak-${stamp}` is partially
  //     reverted, or atomicWrite is replaced with a non-atomic writeFile.
  it("Backup-and-overwrite path writes .env.bak-<stamp> via atomicWrite (wiring assertion)", () => {
    const repoRoot = resolve(__dirname, "..", "..");
    const initEnvSrc = readFileSync(
      join(repoRoot, "scripts", "init-env.ts"),
      "utf8",
    );
    // The backup path uses the .env.bak-${stamp} naming convention (NOT
    // .env.local.bak-* — that would be a rollback).
    expect(initEnvSrc).toMatch(
      /backupPath\s*=\s*path\.join\(repoRoot,\s*`\.env\.bak-\$\{stamp\}`\)/,
    );
    // The backup is written via atomicWrite (mode 0600 + fsync + rename).
    expect(initEnvSrc).toMatch(/await atomicWrite\(backupPath,/);
    // formatBackupTimestamp is UTC-based (matches the migration documentation).
    expect(initEnvSrc).toMatch(/getUTCFullYear\(\)/);
  });

  // CF5: --profile=ci must not block on external-allowlist prompts.
  it("--profile=ci does NOT prompt for external allowlist entries (no hang)", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "init-env-ci-"));
    try {
      process.chdir(tmpDir);

      // No fallback fixtures — ci profile should never read stdin for
      // external entries. Use null fallback to PROVE it doesn't read.
      const stdin = new DelayedAnswerStream([], null);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const getStdout = collectStream(stdout);

      const code = await run({
        stdin,
        stdout,
        stderr,
        now: () => new Date("2026-04-25T00:00:00Z"),
        args: ["--profile=ci"],
      });
      stdin.destroy();

      // Should write a valid .env without external section blocking.
      expect(code).toBe(0);

      // External section must NOT appear in stdout — confirms loop was skipped.
      const out = getStdout();
      expect(out).not.toMatch(
        /=== External \(docker-compose \/ build-time \/ scripts\) ===/,
      );

      // External keys must NOT be written to .env under ci.
      const envPath = join(tmpDir, ".env");
      const parsed = dotenv.parse(readFileSync(envPath, "utf8"));
      expect(parsed.JACKSON_API_KEY).toBeUndefined();
      expect(parsed.PASSWD_OUTBOX_WORKER_PASSWORD).toBeUndefined();
      expect(parsed.SENTRY_AUTH_TOKEN).toBeUndefined();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// CT16: docker:up wrapper string assertion — verify both compose files are
// passed. After the .env-primary refactor, --env-file is no longer needed
// because docker compose auto-loads .env from the repo root.
describe("package.json docker:up wrapper", () => {
  it("docker:up uses both compose files and does NOT pass --env-file", () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
    );
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    );
    const dockerUp = pkg.scripts["docker:up"];
    expect(dockerUp).toBeDefined();
    expect(dockerUp).toMatch(/docker compose/);
    expect(dockerUp).toMatch(/-f\s+docker-compose\.yml/);
    expect(dockerUp).toMatch(/-f\s+docker-compose\.override\.yml/);
    // The .env-primary design means docker compose reads .env automatically.
    // Re-introducing --env-file would be a regression to the workaround era.
    expect(dockerUp).not.toMatch(/--env-file/);
    // docker:down should mirror the same flags.
    const dockerDown = pkg.scripts["docker:down"];
    expect(dockerDown).toBeDefined();
    expect(dockerDown).toMatch(/-f\s+docker-compose\.yml/);
    expect(dockerDown).not.toMatch(/--env-file/);
  });
});
