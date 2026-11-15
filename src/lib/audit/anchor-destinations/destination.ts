import { AUDIT_ANCHOR_ARTIFACT_MAX_BYTES } from "@/lib/constants/audit/audit";

export interface AnchorDestination {
  /** Stable identifier for logs / audit metadata */
  readonly name: string;
  /**
   * Where this destination stores a chain, as a URI naming the store and the
   * place in it. A manifest carries its hash (`chainLocationFor`), so one
   * copied to another place is not taken for that place's own.
   */
  readonly location: string;
  /** Create-only. "exists": the key is already held by a stored object; nothing was written. */
  create(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<"created" | "exists">;
  /** The stored bytes, or null when there is none. Throws past AUDIT_ANCHOR_ARTIFACT_MAX_BYTES. */
  read(artifactKey: string, signal?: AbortSignal): Promise<Buffer | null>;
  /** Every stored artifact key, of any shape, in no particular order. */
  list(signal?: AbortSignal): Promise<string[]>;
}

/** An artifact past the size bound. Its `code` is what a failure reason carries. */
export class ArtifactTooLargeError extends Error {
  readonly code = "ARTIFACT_TOO_LARGE";
  constructor() {
    super(`anchor artifact exceeds ${AUDIT_ANCHOR_ARTIFACT_MAX_BYTES} bytes`);
    this.name = "ArtifactTooLargeError";
  }
}

export function assertArtifactSize(byteLength: number): void {
  if (byteLength > AUDIT_ANCHOR_ARTIFACT_MAX_BYTES) throw new ArtifactTooLargeError();
}
