import { loadEnv } from "@/lib/load-env";
import { defineConfig, env } from "prisma/config";

loadEnv();

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },

  datasource: {
    // MIGRATION_DATABASE_URL (SUPERUSER) for Prisma CLI (migrate, studio).
    // Falls back to DATABASE_URL (non-SUPERUSER app role) when unset.
    // env() throws on missing vars, so guard with process.env first.
    url: process.env.MIGRATION_DATABASE_URL
      ? env("MIGRATION_DATABASE_URL")
      : env("DATABASE_URL"),
  },
});
