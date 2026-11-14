import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ArtifactNotRegularFileError, FilesystemDestination } from "./filesystem-destination";
import { ANCHOR_ARTIFACT_CONTENT_TYPE, publicKeyArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { AUDIT_ANCHOR_ARTIFACT_MAX_BYTES } from "@/lib/constants/audit/audit";
import { ArtifactTooLargeError } from "./destination";
import {
  createArtifact,
  describeAnchorDestinationContract,
  expectOneConcurrentCreateWins,
  manifestKeyFor,
  randomKid,
} from "@/__tests__/helpers/anchor-destination-contract";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anchor-fs-destination-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await fs.chmod(dir, 0o755).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describeAnchorDestinationContract("filesystem", async () => new FilesystemDestination({ basePath: await tempDir() }));

describe("FilesystemDestination", () => {
  it("has name 'filesystem'", () => {
    expect(new FilesystemDestination({ basePath: "/var/anchors" }).name).toBe("filesystem");
  });

  it("creates the base path recursively and stores the file there with mode 0o644", async () => {
    const basePath = path.join(await tempDir(), "nested", "anchors");
    const key = manifestKeyFor("2026-05-02");

    expect(await createArtifact(new FilesystemDestination({ basePath }), key, Buffer.from("payload"))).toBe("created");

    const stored = path.join(basePath, key);
    expect(await fs.readFile(stored)).toEqual(Buffer.from("payload"));
    expect((await fs.stat(stored)).mode & 0o777).toBe(0o644);
  });

  it("stores a public key under public-keys/ and lists it by its full key", async () => {
    const basePath = await tempDir();
    const dest = new FilesystemDestination({ basePath });
    const key = publicKeyArtifactKey(randomKid());

    await createArtifact(dest, key, Buffer.from("ab".repeat(32)));

    expect(await fs.readFile(path.join(basePath, key), "utf-8")).toBe("ab".repeat(32));
    expect(await dest.list()).toEqual([key]);
  });

  it("leaves no temp file behind, whether the create wrote or found the key taken", async () => {
    const basePath = await tempDir();
    const dest = new FilesystemDestination({ basePath });
    const key = manifestKeyFor("2026-05-02");

    await createArtifact(dest, key, Buffer.from("first"));
    await createArtifact(dest, key, Buffer.from("second"));

    expect(await fs.readdir(basePath)).toEqual([key]);
  });

  it("eight concurrent creates of one key: one is created, and one file remains", async () => {
    const basePath = await tempDir();
    const key = manifestKeyFor("2026-05-02");

    await expectOneConcurrentCreateWins(new FilesystemDestination({ basePath }), key);

    expect(await fs.readdir(basePath)).toEqual([key]);
  });

  it("does not replace a file already at the key, even one it did not write", async () => {
    const basePath = await tempDir();
    const key = manifestKeyFor("2026-05-02");
    await fs.writeFile(path.join(basePath, key), "planted");

    expect(await createArtifact(new FilesystemDestination({ basePath }), key, Buffer.from("mine"))).toBe("exists");

    expect(await fs.readFile(path.join(basePath, key), "utf-8")).toBe("planted");
  });

  it("lists a base path that does not exist yet as empty, and reads null from it", async () => {
    const dest = new FilesystemDestination({ basePath: path.join(await tempDir(), "not-created") });

    expect(await dest.list()).toEqual([]);
    expect(await dest.read(manifestKeyFor("2026-05-02"))).toBeNull();
  });

  it("lists files of any name at the top level and under public-keys/, and no directory or temp file", async () => {
    const basePath = await tempDir();
    await fs.mkdir(path.join(basePath, "public-keys"));
    await fs.mkdir(path.join(basePath, "other-dir"));
    await fs.writeFile(path.join(basePath, "notes.txt"), "x");
    await fs.writeFile(path.join(basePath, ".tmp-leftover"), "x");
    await fs.writeFile(path.join(basePath, "public-keys", "stray.pem"), "x");
    await fs.writeFile(path.join(basePath, "other-dir", "ignored.jws"), "x");

    const keys = await new FilesystemDestination({ basePath }).list();

    expect([...keys].sort()).toEqual(["notes.txt", "public-keys/stray.pem"]);
  });

  it("propagates a listing error that is not a missing directory", async () => {
    const basePath = path.join(await tempDir(), "a-file");
    await fs.writeFile(basePath, "not a directory");

    await expect(new FilesystemDestination({ basePath }).list()).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("throws on a create into a base path it cannot write, storing nothing", async () => {
    const basePath = await tempDir();
    await fs.chmod(basePath, 0o555);
    const dest = new FilesystemDestination({ basePath });

    await expect(createArtifact(dest, manifestKeyFor("2026-05-02"), Buffer.from("x"))).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(await dest.list()).toEqual([]);
  });

  it("throws on reading a stored file past the size bound", async () => {
    const basePath = await tempDir();
    const key = manifestKeyFor("2026-05-02");
    await fs.writeFile(path.join(basePath, key), Buffer.alloc(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES + 1));

    await expect(new FilesystemDestination({ basePath }).read(key)).rejects.toBeInstanceOf(ArtifactTooLargeError);
  });

  describe("read of a name that is not a regular file", () => {
    it.each<[string, (basePath: string, key: string) => Promise<void>]>([
      [
        "a symlink to another file",
        async (basePath, key) => {
          await fs.writeFile(path.join(basePath, "elsewhere"), "not an artifact");
          await fs.symlink(path.join(basePath, "elsewhere"), path.join(basePath, key));
        },
      ],
      [
        "a symlink to a directory",
        async (basePath, key) => {
          await fs.mkdir(path.join(basePath, "a-dir"));
          await fs.symlink(path.join(basePath, "a-dir"), path.join(basePath, key));
        },
      ],
      ["a directory", async (basePath, key) => void (await fs.mkdir(path.join(basePath, key)))],
    ])("throws a named error for %s, and does not answer null", async (_label, plant) => {
      const basePath = await tempDir();
      const key = manifestKeyFor("2026-05-02");
      await plant(basePath, key);

      const error = await new FilesystemDestination({ basePath }).read(key).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ArtifactNotRegularFileError);
      expect(error).toMatchObject({ code: "ARTIFACT_NOT_REGULAR_FILE" });
    });

    it("reads a regular file planted at the name", async () => {
      const basePath = await tempDir();
      const key = manifestKeyFor("2026-05-02");
      await fs.writeFile(path.join(basePath, key), "planted");

      expect(await new FilesystemDestination({ basePath }).read(key)).toEqual(Buffer.from("planted"));
    });
  });

  describe("read of a file that outgrew the size its stat reported", () => {
    /** Every `open` answers a handle whose stat reports 1 byte; `bytesRead` sums what is read through it. */
    function understateSize(): { bytesRead: () => number } {
      let total = 0;
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await realOpen(...args);
        const realStat = handle.stat.bind(handle);
        const realRead = handle.read.bind(handle);
        return Object.assign(handle, {
          stat: async () => Object.assign(await realStat(), { size: 1 }),
          read: async (...readArgs: Parameters<typeof realRead>) => {
            const result = await realRead(...readArgs);
            total += result.bytesRead;
            return result;
          },
        }) as fs.FileHandle;
      });
      return { bytesRead: () => total };
    }

    it("stops one byte past the bound and throws ArtifactTooLargeError", async () => {
      const basePath = await tempDir();
      const key = manifestKeyFor("2026-05-02");
      await fs.writeFile(path.join(basePath, key), Buffer.alloc(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES + 100_000));
      const reads = understateSize();

      await expect(new FilesystemDestination({ basePath }).read(key)).rejects.toBeInstanceOf(ArtifactTooLargeError);

      expect(reads.bytesRead()).toBe(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES + 1);
    });

    it("returns a file exactly at the bound whole", async () => {
      const basePath = await tempDir();
      const key = manifestKeyFor("2026-05-02");
      const bytes = Buffer.alloc(AUDIT_ANCHOR_ARTIFACT_MAX_BYTES, 0x61);
      await fs.writeFile(path.join(basePath, key), bytes);
      understateSize();

      const stored = await new FilesystemDestination({ basePath }).read(key);

      expect(stored?.equals(bytes)).toBe(true);
    });
  });

  it("rejects with the signal's reason when it is already aborted", async () => {
    const dest = new FilesystemDestination({ basePath: await tempDir() });
    const reason = new Error("bound fired");
    const signal = AbortSignal.abort(reason);

    await expect(
      dest.create({
        artifactBytes: Buffer.from("x"),
        artifactKey: manifestKeyFor("2026-05-02"),
        contentType: ANCHOR_ARTIFACT_CONTENT_TYPE.JWS,
        signal,
      }),
    ).rejects.toBe(reason);
    await expect(dest.list(signal)).rejects.toBe(reason);
    expect(await dest.list()).toEqual([]);
  });
});
