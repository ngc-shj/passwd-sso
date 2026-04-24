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
import { run } from "../init-env.ts";
import { envObject } from "../../src/lib/env-schema.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

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
  it("writes a valid .env.local under the dev profile and exits 0", async () => {
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

      const envLocalPath = join(tmpDir, ".env.local");
      expect(existsSync(envLocalPath)).toBe(true);

      const parsed = dotenv.parse(readFileSync(envLocalPath, "utf8"));
      const result = envObject.safeParse(parsed);
      expect(result.success).toBe(true);

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

  it.skipIf(platform === "win32")("sets file mode 0600 on the written .env.local (POSIX-only)", async () => {
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
      const mode = statSync(join(tmpDir, ".env.local")).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(platform !== "win32")("mode restriction not applicable on win32 (platform gate)", () => {
    // Intentional skip: file chmod is a no-op on win32.
  });

  it("reprompts up to 5 times and then exits 1 when production profile receives invalid input", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "init-env-prod-fail-"));
    try {
      process.chdir(tmpDir);

      // Feed "y" for all prompts. DATABASE_URL receives "y" → not a valid URL.
      // After 5 re-prompt failures per field, init-env exits 1.
      const stdin = new DelayedAnswerStream([], "y");
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const getStderr = collectStream(stderr);

      const code = await run({
        stdin,
        stdout,
        stderr,
        now: () => new Date("2026-04-24T00:00:00Z"),
        args: ["--profile=production"],
      });
      stdin.destroy();

      const stderrText = getStderr();

      expect(code).toBe(1);
      expect(stderrText).toMatch(
        /The following fields failed validation|failed validation after/i,
      );
      expect(stderrText).not.toMatch(/value\s*=\s*["']y["']/i);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("aborts without modification when the user rejects overwriting an existing .env.local", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "init-env-abort-"));
    const envLocalPath = join(tmpDir, ".env.local");
    const originalContent = "# existing content\nKEY=value\n";
    writeFileSync(envLocalPath, originalContent, { mode: 0o600 });

    try {
      process.chdir(tmpDir);

      // The abort path issues exactly one readline read (the choice prompt).
      // fallback=null stalls after "3\n" is consumed — no further pushes.
      // After "3\n" is consumed readline may call _read() for read-ahead but
      // the stream stalls; prompter.close() fires (rl.close()), readline stops
      // requesting data, and run() returns 0. No OOM, no EOF "closed" error.
      const stdin = new DelayedAnswerStream(["3"], null);
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
      expect(readFileSync(envLocalPath, "utf8")).toBe(originalContent);
      expect(getStdout()).toMatch(/[Aa]bort/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
