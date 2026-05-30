import { describe, it, expect, afterEach, afterAll } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeSecretFile, readSecretFile } from "../../lib/secure-file.js";

const testDir = mkdtempSync(join(tmpdir(), "psso-secure-file-"));
const isPosix = process.platform !== "win32";

let counter = 0;
function freshPath(name: string): string {
  return join(testDir, `${name}-${counter++}`);
}

afterEach(() => {
  // Each test uses a unique path; nothing shared to reset.
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("writeSecretFile / readSecretFile", () => {
  it("round-trips written content", () => {
    const path = freshPath("roundtrip");
    writeSecretFile(path, "s3cr3t-payload");

    expect(readSecretFile(path)).toBe("s3cr3t-payload");
  });

  it.runIf(isPosix)("creates the file with mode 0600", () => {
    const path = freshPath("mode");
    writeSecretFile(path, "data");

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.runIf(isPosix)("refuses to write through a pre-existing symlink (O_NOFOLLOW)", () => {
    const target = freshPath("write-target");
    const link = freshPath("write-link");
    writeFileSync(target, "original");
    symlinkSync(target, link);

    expect(() => writeSecretFile(link, "should-not-land")).toThrow();
  });

  it.runIf(isPosix)("refuses to read through a symlink (O_NOFOLLOW)", () => {
    const target = freshPath("read-target");
    const link = freshPath("read-link");
    writeFileSync(target, "secret-behind-link");
    symlinkSync(target, link);

    expect(() => readSecretFile(link)).toThrow();
  });
});
