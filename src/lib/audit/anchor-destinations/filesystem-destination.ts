import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertAnchorArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { assertArtifactSize, type AnchorDestination } from "./destination";

type FilesystemConfig = {
  basePath: string;
};

const PUBLIC_KEYS_DIR = "public-keys";
const TEMP_PREFIX = ".tmp-";

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

  private readonly basePath: string;

  constructor(config: FilesystemConfig) {
    this.basePath = config.basePath;
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
      handle = await fs.open(path.join(this.basePath, artifactKey), "r");
    } catch (err) {
      if (errnoOf(err) === "ENOENT") return null;
      throw err;
    }
    try {
      assertArtifactSize((await handle.stat()).size);
      return await handle.readFile({ signal });
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
