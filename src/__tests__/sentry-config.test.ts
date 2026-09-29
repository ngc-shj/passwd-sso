import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SENTRY_DATA_COLLECTION } from "@/lib/security/sentry-scrub";

const mocks = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({ init: mocks.init }));

// SDK v11 stopped calling `beforeSendTransaction` and widened the default data
// collection, so each init site must wire the span scrubber and the pinned
// baseline itself.
describe.each([
  ["server", "SENTRY_DSN", () => import("../../sentry.server.config")],
  ["client", "NEXT_PUBLIC_SENTRY_DSN", () => import("../../sentry.client.config")],
])("sentry.%s.config", (_name, dsnVar, load) => {
  beforeEach(() => {
    vi.resetModules();
    mocks.init.mockReset();
    vi.stubEnv(dsnVar, "https://public@sentry.example.com/1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // resetModules gives the config a fresh sentry-scrub instance; compare
  // against that one, not the top-level import.
  const loadScrub = () => import("@/lib/security/sentry-scrub");

  it("scrubs streamed spans and events", async () => {
    await load();
    const { scrubSentryEvent, scrubSentrySpan } = await loadScrub();
    const options = mocks.init.mock.calls[0][0];
    expect(options.beforeSendSpan).toBe(scrubSentrySpan);
    expect(options.beforeSend({ message: "x" })).toEqual(scrubSentryEvent({ message: "x" }));
    expect(options).not.toHaveProperty("beforeSendTransaction");
  });

  it("pins the restrictive data-collection baseline", async () => {
    await load();
    const scrub = await loadScrub();
    expect(mocks.init.mock.calls[0][0].dataCollection).toBe(scrub.SENTRY_DATA_COLLECTION);
  });
});

describe("SENTRY_DATA_COLLECTION", () => {
  it("collects no cookies, bodies, user info or query text", () => {
    expect(SENTRY_DATA_COLLECTION).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      databaseQueryData: false,
      genAI: { inputs: false, outputs: false },
    });
  });
});
