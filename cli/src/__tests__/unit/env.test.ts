import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { envCommand } = await import("../../commands/env.js");

describe("envCommand", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "psso-env-command-"));
    exitCode = undefined;

    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("exits with code 1 when config uses a placeholder entry ID", async () => {
    const configPath = join(tempDir, ".passwd-sso-env.json");
    writeFileSync(configPath, JSON.stringify({
      secrets: {
        DATABASE_URL: { entry: "dummy-entry-id", field: "password" },
      },
    }), "utf-8");

    await expect(envCommand({ config: configPath, format: "shell" })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("placeholder entry ID"),
    );
  });
});
