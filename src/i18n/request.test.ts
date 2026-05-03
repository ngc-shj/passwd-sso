import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mocks ───────────────────────────────────────────────────────────
//
// `loadAllMessages` is part of `@/i18n/messages` and performs dynamic imports
// of JSON files. We mock it to assert the resolution chain (locale picked →
// loader called) without exercising the real namespace loader (covered by
// `messages.test.ts`).

const { mockLoadAllMessages } = vi.hoisted(() => ({
  mockLoadAllMessages: vi.fn(async () => ({ Common: { ok: "ok" } })),
}));

vi.mock("./messages", () => ({
  loadAllMessages: mockLoadAllMessages,
}));

// `next-intl/server` exposes `getRequestConfig` as an identity function in
// production builds — wrapping the user-supplied resolver. We provide the
// same shape so the resolver remains directly invokable for assertions.
vi.mock("next-intl/server", () => ({
  getRequestConfig: <T>(fn: T) => fn,
}));

import requestConfig from "./request";
import { routing } from "./routing";

// The default export is the resolver function (identity-wrapped by the mock above).
type ResolverArg = { requestLocale: Promise<string | undefined> };
type Resolver = (arg: ResolverArg) => Promise<{ locale: string; messages: unknown }>;
const resolve = requestConfig as unknown as Resolver;

describe("i18n/request resolver", () => {
  beforeEach(() => {
    mockLoadAllMessages.mockClear();
  });

  it("returns the requested locale when it is supported", async () => {
    const result = await resolve({ requestLocale: Promise.resolve("en") });
    expect(result.locale).toBe("en");
    expect(mockLoadAllMessages).toHaveBeenCalledWith("en");
  });

  it("falls back to defaultLocale when the requested locale is unsupported", async () => {
    const result = await resolve({ requestLocale: Promise.resolve("fr") });
    expect(result.locale).toBe(routing.defaultLocale);
    expect(mockLoadAllMessages).toHaveBeenCalledWith(routing.defaultLocale);
  });

  it("falls back to defaultLocale when the requested locale is undefined", async () => {
    const result = await resolve({ requestLocale: Promise.resolve(undefined) });
    expect(result.locale).toBe(routing.defaultLocale);
    expect(mockLoadAllMessages).toHaveBeenCalledWith(routing.defaultLocale);
  });

  it("returns the messages object produced by loadAllMessages", async () => {
    const fakeMessages = { Common: { hello: "world" } };
    mockLoadAllMessages.mockResolvedValueOnce(fakeMessages);

    const result = await resolve({ requestLocale: Promise.resolve("ja") });
    expect(result.messages).toBe(fakeMessages);
  });

  it("invokes loadAllMessages exactly once per resolution", async () => {
    await resolve({ requestLocale: Promise.resolve("ja") });
    expect(mockLoadAllMessages).toHaveBeenCalledTimes(1);
  });
});
