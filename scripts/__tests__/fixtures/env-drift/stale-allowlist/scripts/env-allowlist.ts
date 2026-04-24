export const ALLOWLIST = [
  {
    type: "literal" as const,
    key: "STALE_UNUSED_VAR",
    justification: "This variable is stale — not referenced by any consumer file or compose file anywhere.",
    consumers: ["scripts/nonexistent-consumer.sh"],
    reviewedAt: "2026-04-24",
  },
] as const;
