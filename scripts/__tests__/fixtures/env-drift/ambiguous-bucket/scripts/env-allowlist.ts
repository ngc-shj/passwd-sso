export const ALLOWLIST = [
  {
    type: "literal" as const,
    key: "DATABASE_URL",
    justification: "This key is also in Zod schema — this tests ambiguous-bucket detection correctly.",
    consumers: ["scripts/some-script.sh"],
    reviewedAt: "2026-04-24",
  },
] as const;
