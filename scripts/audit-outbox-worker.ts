#!/usr/bin/env tsx
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { createWorker } from "@/workers/audit-outbox-worker";

const databaseUrl =
  process.env.OUTBOX_WORKER_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error(
    JSON.stringify({
      level: "fatal",
      msg: "OUTBOX_WORKER_DATABASE_URL (or DATABASE_URL) is required",
    }),
  );
  process.exit(1);
}

const worker = createWorker({ databaseUrl });

worker.start().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: "fatal",
      msg: "Worker fatal error",
      err: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
