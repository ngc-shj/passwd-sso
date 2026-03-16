import type { vi } from "vitest";

type MockModel = Record<
  "findUnique" | "findFirst" | "findMany" | "create" | "update" |
  "delete" | "deleteMany" | "count" | "upsert",
  ReturnType<typeof vi.fn>
>;

export type MockPrisma = Record<string, MockModel> & {
  $transaction: ReturnType<typeof vi.fn>;
};
