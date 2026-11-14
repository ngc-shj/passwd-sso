import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertAnchorArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { AUDIT_ANCHOR_ARTIFACT_MAX_BYTES } from "@/lib/constants/audit/audit";
import { assertArtifactSize, type AnchorDestination } from "./destination";

type FilesystemConfig = {
  basePath: string;
};

const PUBLIC_KEYS_DIR = "public-keys";
const TEMP_PREFIX = ".tmp-";
const READ_CHUNK_BYTES = 64 * 1024;
// Absent on platforms without it; there a symlink is followed and the
// regular-file check on the opened target is what remains.
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
// Without it, opening a FIFO read-only blocks in `open` until a writer
// appears, holding a threadpool thread no signal reaches. With it the FIFO
// opens at once and the regular-file check refuses it. Absent on platforms
// without it; a regular file reads the same either way.
const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

/**
 * The name of an artifact key holds something that is not a regular file — a
 * symlink, a directory, a FIFO, a device. `create` only ever links regular files, so
 * it is not an artifact. Its `code` is what a failure reason carries.
 */
export class ArtifactNotRegularFileError extends Error {
  readonly code = "ARTIFACT_NOT_REGULAR_FILE";
  constructor() {
    super("anchor artifact path is not a regular file");
    this.name = "ArtifactNotRegularFileError";
  }
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function fileNames(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && !e.name.startsWith(TEMP_PREFIX)).map((e) => e.name);
  } catch (err) {
    // A base path nothing was created under yet holds no artifact.
    if (errnoOf(err) === "ENOENT") return [];
    throw err;
  }
}

export class FilesystemDestination implements AnchorDestination {
  readonly name = "filesystem";
  /** The base path made absolute; a symlink in it is not resolved. */
  readonly location: string;

  private readonly basePath: string;

  constructor(config: FilesystemConfig) {
    this.basePath = config.basePath;
    this.location = `file://${path.resolve(config.basePath)}`;
  }

  async create(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<"created" | "exists"> {
    assertAnchorArtifactKey(args.artifactKey);
    assertArtifactSize(args.artifactBytes.length);
    args.signal?.throwIfAborted();

    const finalPath = path.join(this.basePath, args.artifactKey);
    const dir = path.dirname(finalPath);
    await fs.mkdir(dir, { recursive: true });

    // Written whole to a temp name in the same directory, then linked: link()
    // fails with EEXIST when the name is taken, so the final name only ever
    // appears with complete content and is never replaced.
    const tempPath = path.join(dir, `${TEMP_PREFIX}${randomUUID()}`);
    try {
      // Explicit mode 0o644: world-readable audit artifacts are intentional;
      // operator may restrict further via mount options if more restrictive permissions are needed.
      const handle = await fs.open(tempPath, "wx", 0o644);
      try {
        await handle.writeFile(args.artifactBytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(tempPath, finalPath);
      } catch (err) {
        if (errnoOf(err) === "EEXIST") return "exists";
        throw err;
      }
      return "created";
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }

  async read(artifactKey: string, signal?: AbortSignal): Promise<Buffer | null> {
    assertAnchorArtifactKey(artifactKey);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path.join(this.basePath, artifactKey), fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (err) {
      if (errnoOf(err) === "ENOENT") return null;
      // What O_NOFOLLOW answers for a symlink at the name.
      if (errnoOf(err) === "ELOOP") throw new ArtifactNotRegularFileError();
      throw err;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ArtifactNotRegularFileError();
      assertArtifactSize(stat.size);

      // The size checked is the file's at the stat. The read is bounded on its
      // own, one byte past the limit, so a file that grew since is refused
      // rather than read whole.
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= AUDIT_ANCHOR_ARTIFACT_MAX_BYTES) {
        signal?.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, AUDIT_ANCHOR_ARTIFACT_MAX_BYTES + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      assertArtifactSize(total);
      return Buffer.concat(chunks, total);
    } finally {
      await handle.close();
    }
  }

  async list(signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    const top = await fileNames(this.basePath);
    const publicKeys = await fileNames(path.join(this.basePath, PUBLIC_KEYS_DIR));
    return [...top, ...publicKeys.map((name) => `${PUBLIC_KEYS_DIR}/${name}`)];
  }
}
