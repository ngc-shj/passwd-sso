/**
 * Tests for src/lib/load-env.ts.
 *
 * Pin the override-semantics invariant (RT3 / R25 persist-hydrate symmetry):
 * .env.local must override .env at the same key, AND .env values must fill
 * in keys absent from .env.local. A regression that "fixes" the load order
 * to look canonical (.env first, then .env.local) would silently flip the
 * precedence — these tests catch that.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./load-env";

describe("loadEnv()", () => {
  let baseDir: string;
  let origEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "load-env-"));
    origEnv = { ...process.env };
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(origEnv)) {
      process.env[k] = v;
    }
  });

  it(".env.local overrides .env at the same key", () => {
    writeFileSync(join(baseDir, ".env"), "FOO=base\n");
    writeFileSync(join(baseDir, ".env.local"), "FOO=override\n");

    delete process.env.FOO;
    loadEnv(baseDir);

    expect(process.env.FOO).toBe("override");
  });

  it(".env fills in keys not present in .env.local", () => {
    writeFileSync(join(baseDir, ".env"), "FOO=base\nBAR=base-only\n");
    writeFileSync(join(baseDir, ".env.local"), "FOO=override\n");

    delete process.env.FOO;
    delete process.env.BAR;
    loadEnv(baseDir);

    expect(process.env.FOO).toBe("override");
    expect(process.env.BAR).toBe("base-only");
  });

  it("loads from .env alone when .env.local is absent", () => {
    writeFileSync(join(baseDir, ".env"), "FOO=base\n");

    delete process.env.FOO;
    loadEnv(baseDir);

    expect(process.env.FOO).toBe("base");
  });

  it("loads from .env.local alone when .env is absent (back-compat)", () => {
    writeFileSync(join(baseDir, ".env.local"), "FOO=local-only\n");

    delete process.env.FOO;
    loadEnv(baseDir);

    expect(process.env.FOO).toBe("local-only");
  });

  it("does not overwrite a value already set in process.env (dotenv default)", () => {
    writeFileSync(join(baseDir, ".env"), "FOO=base\n");
    writeFileSync(join(baseDir, ".env.local"), "FOO=local\n");

    process.env.FOO = "from-shell";
    loadEnv(baseDir);

    expect(process.env.FOO).toBe("from-shell");
  });
});
