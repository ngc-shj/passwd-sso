import { vi, beforeEach } from "vitest";

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// Set required env vars for crypto-server.ts and Prisma
process.env.SHARE_MASTER_KEY = "a".repeat(64);
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_RP_NAME = "Test App";
process.env.WEBAUTHN_PRF_SECRET = "c".repeat(64);
process.env.DIRECTORY_SYNC_MASTER_KEY = "d".repeat(64);
