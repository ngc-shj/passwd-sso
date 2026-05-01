import fs from "node:fs/promises";
import path from "node:path";
import type { AnchorDestination } from "./destination";

type FilesystemConfig = {
  basePath: string;
};

export class FilesystemDestination implements AnchorDestination {
  readonly name = "filesystem";

  private readonly basePath: string;

  constructor(config: FilesystemConfig) {
    this.basePath = config.basePath;
  }

  async upload(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
  }): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
    // Explicit mode 0o644: world-readable audit artifacts are intentional;
    // operator may restrict further via mount options if more restrictive permissions are needed.
    await fs.writeFile(path.join(this.basePath, args.artifactKey), args.artifactBytes, { mode: 0o644 });
  }
}
