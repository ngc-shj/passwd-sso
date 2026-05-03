import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

import fs from "node:fs/promises";
import { FilesystemDestination } from "./filesystem-destination";

const mockedMkdir = vi.mocked(fs.mkdir);
const mockedWriteFile = vi.mocked(fs.writeFile);

describe("FilesystemDestination", () => {
  beforeEach(() => {
    mockedMkdir.mockReset().mockResolvedValue(undefined);
    mockedWriteFile.mockReset().mockResolvedValue(undefined);
  });

  it("has name 'filesystem'", () => {
    const dest = new FilesystemDestination({ basePath: "/var/anchors" });
    expect(dest.name).toBe("filesystem");
  });

  it("creates basePath recursively before writing", async () => {
    const dest = new FilesystemDestination({ basePath: "/var/anchors" });

    await dest.upload({
      artifactBytes: Buffer.from("payload"),
      artifactKey: "2026-05-02.kid-audit-anchor-abc.jws",
      contentType: "application/jose",
    });

    expect(mockedMkdir).toHaveBeenCalledOnce();
    expect(mockedMkdir).toHaveBeenCalledWith("/var/anchors", { recursive: true });
  });

  it("writes file to basePath/artifactKey with mode 0o644", async () => {
    const dest = new FilesystemDestination({ basePath: "/var/anchors" });
    const bytes = Buffer.from("jws-payload");

    await dest.upload({
      artifactBytes: bytes,
      artifactKey: "artifact.jws",
      contentType: "application/jose",
    });

    expect(mockedWriteFile).toHaveBeenCalledOnce();
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/var/anchors/artifact.jws",
      bytes,
      { mode: 0o644 },
    );
  });

  it("calls mkdir before writeFile (ordering)", async () => {
    const callOrder: string[] = [];
    mockedMkdir.mockImplementation(async () => {
      callOrder.push("mkdir");
      return undefined;
    });
    mockedWriteFile.mockImplementation(async () => {
      callOrder.push("writeFile");
      return undefined;
    });

    const dest = new FilesystemDestination({ basePath: "/var/anchors" });
    await dest.upload({
      artifactBytes: Buffer.from("x"),
      artifactKey: "k.jws",
      contentType: "application/jose",
    });

    expect(callOrder).toEqual(["mkdir", "writeFile"]);
  });

  it("propagates EACCES from mkdir", async () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    mockedMkdir.mockRejectedValue(err);

    const dest = new FilesystemDestination({ basePath: "/forbidden" });
    await expect(
      dest.upload({
        artifactBytes: Buffer.from("x"),
        artifactKey: "k.jws",
        contentType: "application/jose",
      }),
    ).rejects.toThrow("permission denied");

    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it("propagates ENOSPC from writeFile", async () => {
    const err = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    mockedWriteFile.mockRejectedValue(err);

    const dest = new FilesystemDestination({ basePath: "/var/anchors" });
    await expect(
      dest.upload({
        artifactBytes: Buffer.from("x"),
        artifactKey: "k.jws",
        contentType: "application/jose",
      }),
    ).rejects.toThrow("disk full");
  });

  it("joins basePath with artifactKey via path.join semantics", async () => {
    const dest = new FilesystemDestination({ basePath: "/var/anchors/" });

    await dest.upload({
      artifactBytes: Buffer.from("x"),
      artifactKey: "subdir/key.jws",
      contentType: "application/jose",
    });

    // path.join normalizes the trailing slash + nested key
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/var/anchors/subdir/key.jws",
      expect.any(Buffer),
      { mode: 0o644 },
    );
  });
});
