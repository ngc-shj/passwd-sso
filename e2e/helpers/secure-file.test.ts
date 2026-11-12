import { describe, it, expect, afterAll } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeSecretFile } from "./secure-file";

const testDir = mkdtempSync(join(tmpdir(), "psso-e2e-secure-file-"));
const isPosix = process.platform !== "win32";

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("writeSecretFile (e2e mirror)", () => {
  it.runIf(isPosix)("creates the file with mode 0600", () => {
    const path = join(testDir, "new");
    writeSecretFile(path, "data");

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.runIf(isPosix)("overwriting a pre-existing 0644 file leaves it 0600 with new content", () => {
    const path = join(testDir, "existing");
    writeFileSync(path, "old-content-longer-than-new", { mode: 0o644 });
    chmodSync(path, 0o644);

    writeSecretFile(path, "new");

    expect(readFileSync(path, "utf-8")).toBe("new");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
