import { vi, beforeEach } from "vitest";

// Passthrough mock for withRequestLog — prevents wrapper from accessing
// request.headers when tests call handlers without arguments.
// The dedicated with-request-log.test.ts tests the real implementation
// via dynamic import and its own logger mock.
vi.mock("@/lib/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: <H extends (...args: any[]) => unknown>(handler: H): H => handler,
}));

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
