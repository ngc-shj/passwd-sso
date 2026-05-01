export interface AnchorDestination {
  /** Stable identifier for logs / audit metadata */
  readonly name: string;
  /** Upload one manifest artifact. Throws on failure. */
  upload(args: {
    artifactBytes: Buffer;
    artifactKey: string;
    contentType: string;
  }): Promise<void>;
}
