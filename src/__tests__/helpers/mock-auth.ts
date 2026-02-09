import { vi } from "vitest";

export interface MockSession {
  user: {
    id: string;
    email?: string;
    name?: string;
  };
}

export const DEFAULT_SESSION: MockSession = {
  user: {
    id: "test-user-id",
    email: "user@example.com",
    name: "Test User",
  },
};

/**
 * Creates a mock auth() function that returns the given session.
 * Override per-test with mockAuth.mockResolvedValue(null) for unauthenticated.
 */
export function createMockAuth(
  session: MockSession | null = DEFAULT_SESSION
) {
  return vi.fn(async () => session);
}
