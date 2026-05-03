// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadBlob } from "./download-blob";

describe("downloadBlob", () => {
  let createSpy: ReturnType<typeof vi.spyOn>;
  let revokeSpy: ReturnType<typeof vi.spyOn>;
  let clickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // jsdom does not implement createObjectURL — install stubs
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        value: () => "",
        configurable: true,
        writable: true,
      });
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        value: () => undefined,
        configurable: true,
        writable: true,
      });
    }
    createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock-url");
    revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    createSpy.mockRestore();
    revokeSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("creates an object URL from the response Blob", async () => {
    const response = new Response("payload", {
      headers: { "Content-Type": "text/plain" },
    });

    await downloadBlob(response, "report.txt");

    expect(createSpy).toHaveBeenCalledTimes(1);
    // Avoid `toBeInstanceOf(Blob)` — under jsdom + Node 20, the Blob seen by
    // production code (Node realm) is not `instanceof` jsdom-realm Blob.
    // Duck-type the captured argument instead: any object with `.size` and
    // matching `.type` is the Blob we expect.
    const arg = createSpy.mock.calls[0][0] as { size: number; type: string };
    expect(arg.type).toBe("text/plain");
    expect(arg.size).toBe(7); // "payload".length
  });

  it("triggers a click on a synthetic anchor", async () => {
    const response = new Response("hello");
    await downloadBlob(response, "hello.txt");
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("revokes the object URL after triggering download", async () => {
    const response = new Response("hello");
    await downloadBlob(response, "hello.txt");
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith("blob:mock-url");
  });

  it("propagates Blob conversion errors", async () => {
    // Force response.blob() to reject
    const failing = {
      blob: () => Promise.reject(new Error("blob failed")),
    } as unknown as Response;
    await expect(downloadBlob(failing, "x.txt")).rejects.toThrow("blob failed");
    expect(createSpy).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
