import { describe, expect, it, vi } from "vitest";

describe("requireOptionalModule", () => {
  it("loads module via createRequire", async () => {
    vi.resetModules();
    const requireMock = vi.fn().mockReturnValue({ ok: true });
    const createRequireMock = vi.fn().mockReturnValue(requireMock);

    vi.doMock("node:module", () => ({
      createRequire: createRequireMock,
    }));

    const { requireOptionalModule } = await import("./runtime-module");
    const mod = requireOptionalModule<{ ok: boolean }>("@google-cloud/storage");

    expect(createRequireMock).toHaveBeenCalled();
    expect(requireMock).toHaveBeenCalledWith("@google-cloud/storage");
    expect(mod).toEqual({ ok: true });
  });

  it("throws descriptive error when module is missing", async () => {
    vi.resetModules();
    const requireMock = vi.fn(() => {
      throw new Error("not found");
    });
    const createRequireMock = vi.fn().mockReturnValue(requireMock);

    vi.doMock("node:module", () => ({
      createRequire: createRequireMock,
    }));

    const { requireOptionalModule } = await import("./runtime-module");
    expect(() => requireOptionalModule("@azure/storage-blob")).toThrow(
      'Missing optional dependency "@azure/storage-blob"',
    );
  });
});

