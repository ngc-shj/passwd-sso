import { assertAnchorArtifactKey } from "@/lib/audit/anchor-artifact-keys";
import { assertArtifactSize, type AnchorDestination } from "./destination";

/**
 * A destination held in memory, for unit tests. It keeps the contract the real
 * ones keep (create-only, key shapes, the size bound), so a test built on it
 * exercises the protocol and not a mock's canned answers.
 */
export const IN_MEMORY_LOCATION = "memory://anchors";

export class InMemoryDestination implements AnchorDestination {
  private readonly objects = new Map<string, Buffer>();

  /** Every instance is the one location unless a test gives it another. */
  constructor(
    readonly name = "in-memory",
    readonly location = IN_MEMORY_LOCATION,
  ) {}

  async create(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<"created" | "exists"> {
    assertAnchorArtifactKey(args.artifactKey);
    assertArtifactSize(args.artifactBytes.length);
    args.signal?.throwIfAborted();
    if (this.objects.has(args.artifactKey)) return "exists";
    this.objects.set(args.artifactKey, Buffer.from(args.artifactBytes));
    return "created";
  }

  async read(artifactKey: string, signal?: AbortSignal): Promise<Buffer | null> {
    assertAnchorArtifactKey(artifactKey);
    signal?.throwIfAborted();
    const stored = this.objects.get(artifactKey);
    return stored ? Buffer.from(stored) : null;
  }

  async list(signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    return [...this.objects.keys()];
  }
}
