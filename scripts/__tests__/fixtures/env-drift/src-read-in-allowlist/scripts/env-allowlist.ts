export const ALLOWLIST = [
  {
    type: "literal" as const,
    key: "SRC_READ_IN_ALLOWLIST_VAR",
    justification:
      "Fixture-only entry for check 12 [src-read-undeclared]: proves an allowlisted, " +
      "readByApp: true key is treated as declared and not flagged.",
    consumers: ["src/lib/reader.ts"],
    reviewedAt: "2026-07-29",
    readByApp: true,
  },
] as const;
