export const GROUPS = ["Application", "Database"] as const;
export type Group = (typeof GROUPS)[number];
export const descriptions = {
  DATABASE_URL: { group: "Database" as const, order: 1, description: "Database connection URL." },
  NODE_ENV: { group: "Application" as const, order: 1, description: "Runtime mode." },
  SRC_READ_DYNAMIC_KEY_DECLARED: {
    group: "Application" as const,
    order: 2,
    description: "Fixture-only var, statically read and declared in Zod.",
  },
};
