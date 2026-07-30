export const GROUPS = ["Application", "Database"] as const;
export type Group = (typeof GROUPS)[number];
export const descriptions = {
  DATABASE_URL: { group: "Database" as const, order: 1, description: "Database connection URL." },
  NODE_ENV: { group: "Application" as const, order: 1, description: "Runtime mode." },
  SRC_READ_IN_ZOD_VAR: { group: "Application" as const, order: 2, description: "Fixture-only var, declared in Zod." },
};
