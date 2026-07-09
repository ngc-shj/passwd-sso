import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MS_PER_SECOND } from "../../lib/time.js";

// cli/src/__tests__/integration/ → cli/dist/
const distEntry = resolve(import.meta.dirname, "../../../dist/index.js");
const distExists = existsSync(distEntry);

// Isolated HOME/XDG dirs: no config.json, no credentials, and no legacy
// ~/.passwd-sso migration source (os.homedir() follows $HOME on POSIX).
let isolatedHome: string;

const STACK_FRAME_MARKERS = ["    at ", "node:internal"];

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const { status, stdout, stderr } = spawnSync("node", [distEntry, ...args], {
    encoding: "utf8",
    timeout: 10 * MS_PER_SECOND,
    // Closed stdin: if the not-logged-in fail-fast ever regresses, readPassphrase
    // resolves immediately on EOF instead of hanging the suite at the prompt.
    input: "",
    env: {
      ...process.env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      XDG_DATA_HOME: join(isolatedHome, ".local", "share"),
    },
  });
  return { status, stdout, stderr };
}

describe("CLI error output without login", () => {
  beforeAll(() => {
    isolatedHome = mkdtempSync(join(tmpdir(), "passwd-sso-cli-test-"));
  });

  afterAll(() => {
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  it.skipIf(!distExists)(
    "unlock fails fast with a clean error and no passphrase prompt",
    () => {
      const { status, stdout, stderr } = runCli(["unlock"]);

      expect(status).toBe(1);
      expect(stderr).toContain("Not logged in. Run `passwd-sso login` first.");
      expect(stdout).not.toContain("Master passphrase:");
      for (const marker of STACK_FRAME_MARKERS) {
        expect(stdout + stderr).not.toContain(marker);
      }
    },
  );

  it.skipIf(!distExists)(
    "api-key list fails with a clean error and no stack trace",
    () => {
      const { status, stdout, stderr } = runCli(["api-key", "list"]);

      expect(status).toBe(1);
      expect(stderr).toContain("Not logged in. Run `passwd-sso login` first.");
      for (const marker of STACK_FRAME_MARKERS) {
        expect(stdout + stderr).not.toContain(marker);
      }
    },
  );
});
