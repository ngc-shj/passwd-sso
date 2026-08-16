import { vi, beforeEach, afterEach, expect } from "vitest";
import { _resetKeyProvider, getKeyProvider } from "@/lib/key-provider";

// Gate self-tests under scripts/__tests__/ shell out to real processes — node,
// bash, npx tsx, eslint, openssl — so their cost is subprocess startup, not
// assertion work. Measured in isolation they run 1-3s against the 10s default,
// which is ample alone and not under the full suite, where ~1000 test files
// compete for CPU. The symptom is a contention flake that picks a different
// file each run, so budgeting them one at a time only moves the failure.
//
// Scoped to that directory rather than raised globally: the src/ suites are
// in-process and a hang there is a real defect that should surface as a
// timeout, which a global bump would mask.
if (expect.getState().testPath?.includes("/scripts/__tests__/")) {
  vi.setConfig({ testTimeout: 60_000 });
}

// Passthrough mock for withRequestLog — prevents wrapper from accessing
// request.headers when tests call handlers without arguments.
// The dedicated with-request-log.test.ts tests the real implementation
// via dynamic import and its own logger mock.
vi.mock("@/lib/http/with-request-log", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  withRequestLog: <H extends (...args: any[]) => unknown>(handler: H): H => handler,
}));

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// Restore process.env stubs after every test. Per-test files MUST mutate env
// via vi.stubEnv (never direct assignment); this afterEach reverts them so
// later tests in the same file see the baseline values written below.
afterEach(() => {
  vi.unstubAllEnvs();
});

// Set required env vars for crypto-server.ts and Prisma
process.env.SHARE_MASTER_KEY = "a".repeat(64);
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.WEBAUTHN_RP_ID = "localhost";
process.env.WEBAUTHN_RP_NAME = "Test App";
process.env.WEBAUTHN_PRF_SECRET = "c".repeat(64);
process.env.DIRECTORY_SYNC_MASTER_KEY = "d".repeat(64);
// NextRequest in the Node test env does not expose request.ip, so tests that
// exercise XFF / X-Real-IP extraction need the reverse-proxy opt-in. Tests
// verifying the fail-closed path unset this locally.
process.env.TRUST_PROXY_HEADERS = "true";

// Initialize the EnvKeyProvider singleton so getKeyProviderSync() works in tests.
// Tests that exercise provider selection (key-provider/index.test.ts) reset and
// re-initialize the singleton themselves via _resetKeyProvider() + getKeyProvider().
_resetKeyProvider();
delete process.env.KEY_PROVIDER; // ensure "env" provider is selected
await getKeyProvider();
