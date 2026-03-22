import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rootPkg = require("../../../../package.json") as { version: string };

// cli/src/__tests__/integration/ → cli/dist/
const distEntry = resolve(import.meta.dirname, "../../../dist/index.js");

describe("CLI version", () => {
  it("--version outputs the root package.json version", () => {
    if (!existsSync(distEntry)) {
      throw new Error(
        `dist/index.js not found — run "npm run build" before tests`,
      );
    }

    const stdout = execFileSync("node", [distEntry, "--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();

    expect(stdout).toBe(rootPkg.version);
  });
});
